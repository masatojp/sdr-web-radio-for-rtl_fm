/**
 * Modern Web SDR - Move Items Update + Background Playback Fix
 * Features: WFM Support, Safe Edit Mode, Bookmark Reordering, Nested Folders, Move Items
 * Enhanced: Media Session API Support (Notification Center Controls)
 */

require('dotenv').config();
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
    webPort: 3000,
    password: "admin", 
    
    // SDR初期設定
    initialFreq: 126450000, 
    initialMode: 'AM',
    sampleRate: 48000, 
    ppm: 0,
    
    // パス設定
    recordingsPath: path.join(__dirname, 'recordings'),
    bookmarksFile: path.join(__dirname, 'bookmarks.json'),
    squelchFile: path.join(__dirname, 'squelch_data.json'),
};

if (!fs.existsSync(CONFIG.recordingsPath)) fs.mkdirSync(CONFIG.recordingsPath);

// ==========================================
// Discord Notification
// ==========================================
function sendDiscordNotification() {
    const rawUrl = process.env.DISCORD_WEBHOOK_URL || "";
    const webhookUrl = rawUrl.trim();
    if (!webhookUrl || !webhookUrl.startsWith("https://")) return;

    const payload = JSON.stringify({
        username: "SDR Commander",
        embeds: [{
            title: "📡 System Started",
            description: "SDR Web Receiver is online.",
            color: 5814783,
            fields: [
                { name: "Initial Freq", value: `${(CONFIG.initialFreq/1e6).toFixed(3)} MHz`, inline: true },
                { name: "Mode", value: CONFIG.initialMode, inline: true }
            ],
            timestamp: new Date().toISOString()
        }]
    });

    try {
        const urlObj = new URL(webhookUrl);
        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, () => {});
        req.on('error', () => {});
        req.write(payload);
        req.end();
    } catch (e) {}
}

// ==========================================
// データ管理
// ==========================================
let bookmarks = [];
let squelchDB = {};

const defaultBookmarks = [
  { "title": "Sendai Airport", "isFolder": true, "parentId": null, "id": "1763731824815" },
  { "title": "SDJ ATIS", "freq": 126.45, "mode": "AM", "isFolder": false, "parentId": "1763731824815", "id": "1763731847585" },
  { "title": "SDJ TWR", "freq": 118.7, "mode": "AM", "isFolder": false, "parentId": "1763731824815", "id": "1763731881249" },
  { "title": "Sendai FM Radio", "isFolder": true, "parentId": null, "id": "1763731929504" },
  { "title": "Date FM", "freq": 77.1, "mode": "WFM", "isFolder": false, "parentId": "1763731929504", "id": "1763732002721" }
];

function loadData() {
    try {
        if (fs.existsSync(CONFIG.bookmarksFile)) bookmarks = JSON.parse(fs.readFileSync(CONFIG.bookmarksFile));
        else { bookmarks = defaultBookmarks; saveData(); }
        if (fs.existsSync(CONFIG.squelchFile)) squelchDB = JSON.parse(fs.readFileSync(CONFIG.squelchFile));
    } catch (e) { bookmarks = defaultBookmarks; }
}
function saveData() {
    fs.writeFile(CONFIG.bookmarksFile, JSON.stringify(bookmarks, null, 2), () => {});
    fs.writeFile(CONFIG.squelchFile, JSON.stringify(squelchDB, null, 2), () => {});
}
loadData();

// ==========================================
// DSP (Audio Processing)
// ==========================================
class AudioDSP {
    constructor() { this.reset(); }
    reset() { 
        this.lastIn=0; this.lastOut=0; 
        this.agcPeak=0; this.agcGain=1.0; 
        this.squelchGate=0.0; this.rms=0; 
    }
    
    softClip(x) {
        if (x > 3) return 1;
        if (x < -3) return -1;
        return x - (x*x*x)/27;
    }

    process(inputBuffer, opts) {
        const len = inputBuffer.length / 2;
        const out = Buffer.alloc(len * 2);
        const sqThresh = opts.squelchThreshold / 100.0;
        let sumSq = 0;

        for (let i = 0; i < len; i++) {
            let s = inputBuffer.readInt16LE(i * 2) / 32768.0;
            let raw = s; 
            s = raw - 0.95 * this.lastIn + 0.95 * this.lastOut; 
            this.lastIn = raw; 
            this.lastOut = s;
            
            this.agcPeak = this.agcPeak * 0.999 + Math.abs(s) * 0.001;
            let g = 0.5 / (this.agcPeak + 0.01);
            if (g > 20.0) g = 20.0; 
            if (g < 0.1) g = 0.1;

            this.agcGain = this.agcGain * 0.995 + g * 0.005;
            let p = s * this.agcGain * this.squelchGate;

            if (p > 0.95 || p < -0.95) p = this.softClip(p);
            if (p > 0.99) p = 0.99; 
            if (p < -0.99) p = -0.99;

            out.writeInt16LE(Math.floor(p * 32767), i * 2);
            sumSq += (s * s); 
        }

        const rms = Math.sqrt(sumSq / len);
        this.rms = this.rms * 0.9 + rms * 0.1;

        const open = Math.max(0.002, sqThresh); 
        const close = open * 0.8; 
        if (this.rms > open) this.squelchGate = 1.0;
        else if (this.rms < close) this.squelchGate = 0.0;

        return { 
            buffer: out, 
            rssi: Math.min(100, Math.floor(Math.sqrt(this.rms) * 500)), 
            isOpen: this.squelchGate === 1.0 
        };
    }
}
const dsp = new AudioDSP();

// ==========================================
// RTL-SDR Backend
// ==========================================
let rtlProcess = null;
let currentFreq = CONFIG.initialFreq;
let currentMode = CONFIG.initialMode;
let currentAtt = 'off';
let isRecording = false;
let recordingStream = null;
let recordingFilename = "";
let squelchThreshold = 10;

function startRadio(freq, mode, att) {
    if (rtlProcess) { rtlProcess.kill(); rtlProcess = null; }
    currentFreq = freq; currentMode = mode; currentAtt = att; dsp.reset();
    
    let gainVal = '48'; 
    if (att === 'weak') gainVal = '29';
    if (att === 'mid')  gainVal = '9';
    if (att === 'strong') gainVal = '0';

    let args = ['-f', freq.toString(), '-g', gainVal, '-p', CONFIG.ppm.toString(), '-F', '9'];

    if (mode === 'WFM') {
        args.push('-M', 'wbfm', '-s', '240000', '-r', CONFIG.sampleRate.toString());
    } else {
        let rtlMode = (mode === 'FM') ? 'fm' : 'am';
        args.push('-M', rtlMode, '-s', CONFIG.sampleRate.toString());
    }

    console.log(`[Radio] Tune: ${(freq/1e6).toFixed(3)} MHz (${mode}) ATT:${att}(${gainVal})`);
    
    rtlProcess = spawn('rtl_fm', args);
    let chunkBuf = Buffer.alloc(0);
    const CHUNK_SIZE = 4096; 

    rtlProcess.stdout.on('data', (c) => {
        chunkBuf = Buffer.concat([chunkBuf, c]);
        while (chunkBuf.length >= CHUNK_SIZE) {
            const chunk = chunkBuf.subarray(0, CHUNK_SIZE);
            chunkBuf = chunkBuf.subarray(CHUNK_SIZE);
            handleAudio(chunk);
        }
    });
    setTimeout(() => broadcastStatus(), 500);
}

function handleAudio(raw) {
    const res = dsp.process(raw, { squelchThreshold });
    const head = new Int16Array(1); head[0] = res.rssi;
    const statusWord = res.isOpen ? 1 : 0; 
    const combo = Buffer.alloc(raw.length + 4); 
    combo.writeInt16LE(res.rssi, 0);
    combo.writeInt16LE(statusWord, 2);
    res.buffer.copy(combo, 4);

    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(combo); });
    if (isRecording && recordingStream && res.isOpen) recordingStream.write(res.buffer);
}

function startRec() {
    if (isRecording) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    recordingFilename = `${currentMode}_${(currentFreq/1e6).toFixed(3)}MHz_${ts}.wav`;
    const fp = path.join(CONFIG.recordingsPath, recordingFilename);
    recordingStream = fs.createWriteStream(fp);
    writeWavHeader(recordingStream, CONFIG.sampleRate, 0);
    isRecording = true; broadcastStatus();
}

function stopRec() {
    if (!isRecording) return;
    isRecording = false;
    if (recordingStream) {
        const fp = recordingStream.path;
        const b = recordingStream.bytesWritten - 44;
        recordingStream.end();
        setTimeout(() => {
            fs.open(fp, 'r+', (err, fd) => {
                if (!err) {
                    const h = Buffer.alloc(44);
                    h.write('RIFF',0); h.writeUInt32LE(36+b,4); h.write('WAVE',8); h.write('fmt ',12);
                    h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(1,22); h.writeUInt32LE(CONFIG.sampleRate,24);
                    h.writeUInt32LE(CONFIG.sampleRate*2,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write('data',36); h.writeUInt32LE(b,40);
                    fs.write(fd, h, 0, 44, 0, () => fs.close(fd, ()=>{}));
                }
            });
        }, 100);
        recordingStream = null;
    }
    broadcastStatus(); broadcastRecordings();
}

function writeWavHeader(s, r, l) {
    const b = Buffer.alloc(44);
    b.write('RIFF',0); b.writeUInt32LE(36+l,4); b.write('WAVE',8); b.write('fmt ',12);
    b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(r,24);
    b.writeUInt32LE(r*2,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(l,40); s.write(b);
}

// ==========================================
// Server
// ==========================================
const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/') { res.writeHead(200,{'Content-Type':'text/html'}); res.end(htmlContent); }
    else if (u.pathname.startsWith('/download/')) {
        const f = path.basename(decodeURIComponent(u.pathname));
        const fp = path.join(CONFIG.recordingsPath, f);
        if (fs.existsSync(fp)) { res.writeHead(200,{'Content-Type':'audio/wav','Content-Disposition':`attachment; filename="${f}"`}); fs.createReadStream(fp).pipe(res); }
        else { res.writeHead(404); res.end(); }
    } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocket.Server({ server });

function broadcastStatus() {
    const msg = JSON.stringify({ type:'status_update', freq:currentFreq, mode:currentMode, att:currentAtt, isRecording, squelch:squelchThreshold });
    wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(msg); });
}
function broadcastRecordings() {
    try {
        const d = fs.readdirSync(CONFIG.recordingsPath).filter(f=>f.endsWith('.wav')).map(f=>({name:f, size:fs.statSync(path.join(CONFIG.recordingsPath,f)).size})).sort((a,b)=>b.name.localeCompare(a.name));
        wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(JSON.stringify({type:'recordings', data:d})); });
    } catch(e){}
}

wss.on('connection', ws => {
    broadcastStatus(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); broadcastRecordings();
    ws.on('message', m => {
        try {
            const c = JSON.parse(m);
            if (c.type === 'auth_tune') { if (c.password === CONFIG.password) startRadio(c.freq, c.mode, currentAtt); }
            else if (c.type === 'set_att') startRadio(currentFreq, currentMode, c.att);
            else if (c.type === 'set_squelch') { squelchThreshold = c.val; squelchDB[currentFreq] = c.val; saveData(); broadcastStatus(); }
            else if (c.type === 'start_recording') startRec();
            else if (c.type === 'stop_recording') stopRec();
            else if (c.type === 'delete_recording') { fs.unlinkSync(path.join(CONFIG.recordingsPath, c.filename)); broadcastRecordings(); }
            else if (c.type === 'add_bookmark') { c.data.id = Date.now().toString(); bookmarks.push(c.data); saveData(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); }
            else if (c.type === 'edit_bookmark') { 
                const idx = bookmarks.findIndex(b => b.id === c.data.id);
                if (idx !== -1) {
                    bookmarks[idx].title = c.data.title;
                    if (!bookmarks[idx].isFolder) {
                         bookmarks[idx].freq = c.data.freq;
                         bookmarks[idx].mode = c.data.mode;
                    }
                    saveData();
                    ws.send(JSON.stringify({type:'bookmarks', data:bookmarks}));
                }
            }
            else if (c.type === 'move_bookmark') {
                const { id, dir } = c;
                const item = bookmarks.find(b => b.id === id);
                if (item) {
                    const siblings = bookmarks.filter(b => b.parentId === item.parentId);
                    const index = siblings.findIndex(b => b.id === id);
                    let swapTarget = null;
                    if (dir === 'up' && index > 0) swapTarget = siblings[index - 1];
                    else if (dir === 'down' && index < siblings.length - 1) swapTarget = siblings[index + 1];
                    
                    if (swapTarget) {
                        const globalIndex = bookmarks.findIndex(b => b.id === id);
                        const globalTargetIndex = bookmarks.findIndex(b => b.id === swapTarget.id);
                        [bookmarks[globalIndex], bookmarks[globalTargetIndex]] = [bookmarks[globalTargetIndex], bookmarks[globalIndex]];
                        saveData();
                        ws.send(JSON.stringify({type:'bookmarks', data:bookmarks}));
                    }
                }
            }
            else if (c.type === 'change_parent') {
                const item = bookmarks.find(b => b.id === c.id);
                if (item) {
                    if (item.id !== c.newParentId) {
                        item.parentId = c.newParentId;
                        saveData();
                        ws.send(JSON.stringify({type:'bookmarks', data:bookmarks}));
                    }
                }
            }
            else if (c.type === 'delete_bookmark') { bookmarks = bookmarks.filter(b=>b.id!==c.id && b.parentId!==c.id); saveData(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); }
        } catch(e){}
    });
});

server.listen(CONFIG.webPort, () => {
    console.log(`[System] Interface Ready: http://localhost:${CONFIG.webPort}`);
    startRadio(CONFIG.initialFreq, CONFIG.initialMode, 'off');
    sendDiscordNotification();
});

// ==========================================
// Frontend
// ==========================================
const htmlContent = `
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>SDR COMMANDER</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@700&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
<style>
    :root { --bg: #050507; --panel: rgba(30, 30, 35, 0.7); --acc: #00ffc8; --acc-dim: rgba(0,255,200,0.15); --txt: #fff; --sub: #8b9bb4; --mute: #4a4a4a; --open: #00e676; --stop: #ff3b30; --warn: #ffcc00; }
    body { background: var(--bg); color: var(--txt); font-family: 'Inter', sans-serif; margin: 0; display: flex; justify-content: center; min-height: 100vh; user-select: none; -webkit-user-select: none; touch-action: manipulation; }
    .app { width: 100%; max-width: 480px; padding: 20px 20px 100px; box-sizing: border-box; }
    .panel { background: var(--panel); backdrop-filter: blur(12px); border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); padding: 20px; margin-bottom: 16px; }
    
    .freq { font-family: 'JetBrains Mono', monospace; font-size: 3.2rem; text-align: center; font-weight: 700; line-height: 1; text-shadow: 0 0 20px var(--acc-dim); margin: 15px 0; }
    .badges { display: flex; justify-content: center; gap: 8px; }
    .badge { font-size: 0.75rem; padding: 4px 10px; border-radius: 20px; background: rgba(255,255,255,0.05); color: var(--sub); border: 1px solid rgba(255,255,255,0.05); transition: 0.2s; }
    .badge-sql { background: var(--mute); color: #ccc; }
    .badge-sql.open { background: var(--open); color: #000; box-shadow: 0 0 10px var(--open); font-weight: bold; }
    
    .meter-wrap { position: relative; height: 32px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; overflow: hidden; background: #111; }
    .meter-fill { height: 100%; width: 0%; background: var(--mute); transition: width 0.05s ease-out, background 0.1s; }
    .meter-fill.active { background: var(--open); box-shadow: 0 0 15px var(--open); }
    .sq-mark { position: absolute; top: 0; bottom: 0; width: 2px; background: #ffd700; z-index: 5; transition: left 0.1s; box-shadow: 0 0 8px #ffd700; }

    .sq-ctrl-row { display: flex; justify-content: space-between; align-items: center; margin-top: 15px; }
    .sq-val-display { font-family: 'JetBrains Mono', monospace; font-size: 1rem; color: #ffd700; font-weight: bold; margin-left: 5px; }
    .sq-btn-group { display: flex; gap: 4px; }
    .btn-sq { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.1); color: var(--txt); padding: 8px 0; width: 36px; border-radius: 6px; font-size: 0.75rem; cursor: pointer; text-align: center; }
    .btn-sq:active { background: var(--acc); color: #000; border-color: var(--acc); }

    .ctrls { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
    .btn-row { display: flex; gap: 8px; width: 100%; }
    .btn { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--txt); padding: 12px 8px; border-radius: 12px; font-weight: 600; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 6px; font-size: 0.75rem; transition: background 0.1s; white-space: nowrap; }
    .btn:active { background: rgba(255,255,255,0.15); transform: scale(0.98); }
    .btn.active { background: var(--acc-dim); border-color: var(--acc); color: var(--acc); }
    .btn-tune { background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05)); font-size: 1rem; }
    .rec.on { background: #ff3b30; color: #fff; border-color: #ff3b30; animation: p 2s infinite; }
    @keyframes p { 0% {opacity:1} 50% {opacity:0.7} 100% {opacity:1} }

    .btn-audio-toggle { width: 100%; padding: 16px; background: rgba(0,255,200,0.15); border: 1px solid var(--acc); color: var(--acc); border-radius: 14px; font-weight: 800; font-size: 1rem; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 10px; transition: 0.2s; box-shadow: 0 0 15px rgba(0,255,200,0.1); margin-bottom: 5px; }
    .btn-audio-toggle.stop { background: rgba(255, 59, 48, 0.15); border-color: var(--stop); color: var(--stop); box-shadow: 0 0 15px rgba(255, 59, 48, 0.1); }
    .btn-audio-toggle:active { transform: scale(0.98); }

    .section-header { display: flex; justify-content: space-between; align-items: center; margin: 24px 4px 8px 4px; }
    .section-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; color: var(--sub); }
    
    .btn-edit-toggle { background: transparent; border: 1px solid var(--sub); color: var(--sub); padding: 4px 12px; border-radius: 6px; font-size: 0.75rem; cursor: pointer; transition: 0.2s; }
    .btn-edit-toggle.editing { background: var(--warn); color: #000; border-color: var(--warn); font-weight: bold; }
    
    .edit-controls { display: none; gap: 8px; }
    .edit-controls.show { display: flex; }
    .btn-add { background: var(--acc-dim); border: 1px solid var(--acc); color: var(--acc); padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: bold; cursor: pointer; }

    .tree { display: flex; flex-direction: column; gap: 2px; }
    
    /* Edit Mode Styles */
    .panel.edit-mode { border-color: var(--warn); background: rgba(255, 204, 0, 0.05); }
    .panel.edit-mode .row { cursor: default; }

    .row { display: flex; align-items: center; padding: 12px; background: rgba(255,255,255,0.02); border-radius: 8px; cursor: pointer; justify-content: space-between; transition: background 0.1s; }
    .row:hover { background: rgba(255,255,255,0.05); }
    .row-click-area { display: flex; align-items: center; flex: 1; height: 100%; } 
    .folder-c { margin-left: 10px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 10px; display: none; }
    .folder-c.open { display: block; }
    .icon { color: var(--sub); font-size: 1.2rem; transition: transform 0.2s; }
    .icon.rot { transform: rotate(90deg); }
    .txt { display: flex; flex-direction: column; }
    .sub { font-size: 0.8rem; color: var(--sub); }
    
    .act { display: flex; gap: 4px; }
    .ib { background: transparent; border: none; color: var(--sub); padding: 8px; cursor: pointer; border-radius: 50%; z-index: 10; display:flex; align-items:center; justify-content:center; }
    .ib:hover { color: var(--txt); background: rgba(255,255,255,0.1); }
    .ib-move { color: var(--warn); }
    .ib-del { color: var(--stop); }

    /* Modal Centering */
    .ovl { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); backdrop-filter:blur(8px); display:none; justify-content:center; align-items:center; z-index: 1000; }
    .card { background: #1a1b20; width:90%; max-width:400px; padding:30px; border-radius:24px; box-shadow: 0 10px 40px #000; animation: pop 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
    @keyframes pop { from{transform:scale(0.9); opacity:0} to{transform:scale(1); opacity:1} }
    
    .inp { width:100%; background:#27282e; border:none; padding:16px; border-radius:12px; color:#fff; font-size:1.2rem; margin-bottom:15px; box-sizing:border-box; outline:none; }
    .inp:focus { outline: 2px solid var(--acc); }
    
    /* Move Folder List */
    .move-item { padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px; cursor: pointer; display: flex; align-items: center; transition: 0.2s; }
    .move-item:hover { background: rgba(255,255,255,0.1); }
    .move-item.selected { background: var(--acc-dim); border: 1px solid var(--acc); color: var(--acc); }
</style>
</head>
<body>
    <div class="app">
        <div class="panel">
            <div class="badges">
                <span class="badge" id="bdgMode">AM</span>
                <span class="badge" id="bdgAtt" style="display:none">ATT</span>
                <span class="badge badge-sql" id="bdgSql">MUTED</span>
            </div>
            <div class="freq" id="dspFreq">---.---</div>
            
            <div class="meter-wrap">
                <div class="meter-fill" id="dspRssi"></div>
                <div class="sq-mark" id="sqMarker" style="left:10%"></div>
            </div>
            
            <div class="sq-ctrl-row">
                <div style="font-size:0.8rem; color:var(--sub);">AUDIO LEVEL > <span id="valSq" class="sq-val-display">10</span></div>
                <div class="sq-btn-group">
                    <button class="btn-sq" onclick="window.ui.adjSq(-10)">-10</button>
                    <button class="btn-sq" onclick="window.ui.adjSq(-5)">-5</button>
                    <button class="btn-sq" onclick="window.ui.adjSq(-1)">-1</button>
                    <button class="btn-sq" onclick="window.ui.adjSq(1)">+1</button>
                    <button class="btn-sq" onclick="window.ui.adjSq(5)">+5</button>
                    <button class="btn-sq" onclick="window.ui.adjSq(10)">+10</button>
                </div>
            </div>
        </div>

        <div class="ctrls">
            <button class="btn-audio-toggle" id="btnAudio" onclick="window.ui.togAudio()">
                <span class="material-symbols-outlined">volume_up</span> START LISTENING
            </button>

            <div class="btn-row">
                <button class="btn btn-tune" style="flex:2" onclick="window.ui.modal('tune')"><span class="material-symbols-outlined">dialpad</span> TUNE</button>
                <button class="btn" id="btnRec" style="flex:1" onclick="window.ws.togRec()"><span class="material-symbols-outlined">fiber_manual_record</span> REC</button>
            </div>
            <div class="btn-row">
                <button class="btn active" id="attOff" onclick="window.ws.setAtt('off')">NO ATT</button>
                <button class="btn" id="attWeak" onclick="window.ws.setAtt('weak')">WEAK</button>
                <button class="btn" id="attMid" onclick="window.ws.setAtt('mid')">MID</button>
                <button class="btn" id="attStrong" onclick="window.ws.setAtt('strong')">STRONG</button>
            </div>
        </div>

        <div class="section-header">
            <span class="section-title">CHANNELS</span>
            <div style="display:flex; gap:8px; align-items:center;">
                <button id="btnEditToggle" class="btn-edit-toggle" onclick="window.ui.togEdit()">EDIT</button>
                <div id="addBtns" class="edit-controls">
                    <button class="btn-add" onclick="window.ui.modal('add_folder')">+ FOLDER</button>
                    <button class="btn-add" onclick="window.ui.modal('add_freq')">+ FREQ</button>
                </div>
            </div>
        </div>
        
        <!-- List Container with dynamic class for Edit Mode -->
        <div class="panel" id="listBM" style="padding:10px;"></div>

        <div class="section-header"><span class="section-title">RECORDINGS</span></div>
        <div class="panel" id="listRec" style="padding:10px;"></div>
    </div>

    <!-- Modals -->
    <div class="ovl" id="modalTune">
        <div class="card">
            <div style="color:#fff; font-weight:700; font-size:1.2rem; margin-bottom:20px;">Set Frequency</div>
            <input type="number" class="inp" id="inpFreq" placeholder="128.800" step="0.001">
            <div style="display:flex; gap:10px; margin-bottom:15px;">
                <button class="btn" id="modAM" onclick="window.ui.selMod('AM')">AM</button>
                <button class="btn" id="modFM" onclick="window.ui.selMod('FM')">FM</button>
                <button class="btn" id="modWFM" onclick="window.ui.selMod('WFM')">WFM</button>
            </div>
            <input type="password" class="inp" id="inpPass" placeholder="Password (required)">
            <div style="display:flex; gap:10px;">
                <button class="btn" style="flex:1" onclick="window.ui.closeModal()">CANCEL</button>
                <button class="btn" style="flex:1; background:var(--acc); color:#000;" onclick="window.ws.tune()">TUNE</button>
            </div>
        </div>
    </div>

    <div class="ovl" id="modalAdd">
        <div class="card">
            <div style="color:#fff; font-weight:700; font-size:1.2rem; margin-bottom:20px;" id="addTitle">Add Channel</div>
            <input type="text" class="inp" id="addName" placeholder="Name">
            <div id="addFreqGroup">
                <input type="number" class="inp" id="addFreq" placeholder="Frequency (MHz)">
                <div style="display:flex; gap:10px; margin-bottom:15px;">
                    <button class="btn" id="addModAM" onclick="window.ui.selAddMod('AM')">AM</button>
                    <button class="btn" id="addModFM" onclick="window.ui.selAddMod('FM')">FM</button>
                    <button class="btn" id="addModWFM" onclick="window.ui.selAddMod('WFM')">WFM</button>
                </div>
            </div>
            <div style="display:flex; gap:10px;">
                <button class="btn" style="flex:1" onclick="window.ui.closeModal()">CANCEL</button>
                <button class="btn" style="flex:1; background:var(--acc); color:#000;" onclick="window.ws.saveBookmark()">SAVE</button>
            </div>
        </div>
    </div>

    <div class="ovl" id="modalMove">
        <div class="card">
            <div style="color:#fff; font-weight:700; font-size:1.2rem; margin-bottom:20px;">Move to Folder</div>
            <div id="moveFolderList" style="max-height:300px; overflow-y:auto; display:flex; flex-direction:column; gap:8px;"></div>
            <div style="display:flex; gap:10px; margin-top:20px;">
                <button class="btn" style="flex:1" onclick="window.ui.closeModal()">CANCEL</button>
            </div>
        </div>
    </div>

    <!-- Hidden Audio for Background Persistence -->
    <audio id="audioBridge" autoplay playsinline loop style="display:none;"></audio>

<script>
    let audioCtx;
    const state = { freq:0, mode:'AM', att:'off', rec:false, bm:[], expanded:new Set(), squelch: 10, editTargetId: null, editMode: false, moveTargetId: null };
    let nextStartTime = 0; 

    window.ui = {
        els: { freq:document.getElementById('dspFreq'), rssi:document.getElementById('dspRssi'), sq:document.getElementById('sqMarker'), valSq:document.getElementById('valSq') },
        modalMode: 'AM',
        addMode: 'AM',
        targetParent: null,
        addType: 'freq',

        init() {
            window.ws.connect();
            // Setup Media Session handlers initially
            if ('mediaSession' in navigator) {
                 navigator.mediaSession.setActionHandler('play', () => this.togAudio());
                 navigator.mediaSession.setActionHandler('pause', () => this.togAudio());
                 navigator.mediaSession.setActionHandler('stop', () => this.togAudio());
            }
        },

        togAudio() {
            const btn = document.getElementById('btnAudio');
            
            // First time setup or resume
            if (!audioCtx) {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                audioCtx = new Ctx(); 
                
                // Connect bridge to audio tag to keep background alive
                const dest = audioCtx.createMediaStreamDestination();
                const audioEl = document.getElementById('audioBridge');
                audioEl.srcObject = dest.stream;
                audioEl.play().catch(e => console.log("Auto-play blocked", e));
                
                window.audioDest = dest;
                
                // Start silent oscillator to keep pipeline active
                const osc = audioCtx.createOscillator();
                const g = audioCtx.createGain();
                osc.connect(g); g.connect(dest);
                osc.frequency.value = 10; g.gain.value = 0.001; osc.start();
                
                this.updateBtnState('running');
                this.updateMediaSessionState('playing');
                return;
            }

            if (audioCtx.state === 'running') {
                audioCtx.suspend().then(() => {
                    this.updateBtnState('suspended');
                    this.updateMediaSessionState('paused');
                    document.getElementById('audioBridge').pause();
                });
            } else {
                audioCtx.resume().then(() => {
                    this.updateBtnState('running');
                    this.updateMediaSessionState('playing');
                    document.getElementById('audioBridge').play().catch(e=>{});
                });
            }
        },

        updateBtnState(s) {
            const btn = document.getElementById('btnAudio');
            if (s === 'running') {
                btn.innerHTML = '<span class="material-symbols-outlined">volume_off</span> STOP LISTENING';
                btn.className = 'btn-audio-toggle stop';
            } else {
                btn.innerHTML = '<span class="material-symbols-outlined">volume_up</span> START LISTENING';
                btn.className = 'btn-audio-toggle';
            }
        },
        
        // --- NEW: Update Notification Metadata ---
        updateMediaSessionState(stateStr) {
            if (!('mediaSession' in navigator)) return;
            navigator.mediaSession.playbackState = stateStr;
            
            // Set richer metadata for the notification center
            const title = \`🔴 LIVE: \${(state.freq/1e6).toFixed(3)} MHz\`;
            const artist = \`SDR Commander [\${state.mode}]\`;
            
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title,
                artist: artist,
                album: 'SDR Web Receiver',
                artwork: [
                    { src: 'https://placehold.co/512x512/1a1b20/00ffc8?text=SDR+RADIO', sizes: '512x512', type: 'image/png' },
                    { src: 'https://placehold.co/192x192/1a1b20/00ffc8?text=SDR', sizes: '192x192', type: 'image/png' }
                ]
            });
            
            // Explicitly set position state to keep the media session active
            try {
                navigator.mediaSession.setPositionState({
                    duration: 3600, // Dummy long duration
                    playbackRate: 1.0,
                    position: 0
                });
            } catch(e) {
                // Ignore errors if position state is not supported
            }
        },

        upd(m) {
            state.freq=m.freq; state.mode=m.mode; state.att=m.att; state.rec=m.isRecording; state.squelch=m.squelch;
            this.els.freq.innerText = (m.freq/1e6).toFixed(3);
            document.getElementById('bdgMode').innerText = m.mode;
            document.getElementById('bdgAtt').style.display = m.att!=='off'?'inline-block':'none';
            document.getElementById('bdgAtt').innerText = 'ATT '+m.att.toUpperCase();
            ['off','weak','mid','strong'].forEach(k => { document.getElementById('att'+k.charAt(0).toUpperCase()+k.slice(1)).className = 'btn '+(m.att===k?'active':''); });
            document.getElementById('btnRec').className = 'btn '+(m.isRecording?'rec on':'');
            this.renderSq(m.squelch);
            
            // Refresh metadata when freq changes
            if(audioCtx && audioCtx.state === 'running') {
                this.updateMediaSessionState('playing');
            }
        },
        renderSq(v) { this.els.sq.style.left = v + '%'; this.els.valSq.innerText = v; },
        adjSq(delta) { let n = state.squelch + delta; if (n < 0) n = 0; if (n > 100) n = 100; state.squelch = n; this.renderSq(n); window.ws.sendSq(n); },
        
        // --- Edit Mode Logic ---
        togEdit() {
            state.editMode = !state.editMode;
            const btn = document.getElementById('btnEditToggle');
            const ctrls = document.getElementById('addBtns');
            const panel = document.getElementById('listBM');
            
            if (state.editMode) {
                btn.innerText = 'DONE';
                btn.classList.add('editing');
                ctrls.classList.add('show');
                panel.classList.add('edit-mode');
            } else {
                btn.innerText = 'EDIT';
                btn.classList.remove('editing');
                ctrls.classList.remove('show');
                panel.classList.remove('edit-mode');
            }
            this.renderBM();
        },

        modal(type, id=null) {
            this.closeModal(); 
            if (type === 'tune') {
                document.getElementById('modalTune').style.display = 'flex';
                document.getElementById('inpFreq').value = (state.freq/1e6).toFixed(3); 
                this.selMod(state.mode); 
                document.getElementById('inpPass').focus();
            } else if (type === 'add_folder' || type === 'add_freq') {
                document.getElementById('modalAdd').style.display = 'flex';
                this.targetParent = id; 
                state.editTargetId = null; 
                this.addType = (type === 'add_folder') ? 'folder' : 'freq';
                document.getElementById('addTitle').innerText = (this.addType === 'folder') ? "Create Folder" : "Add Channel";
                document.getElementById('addName').value = "";
                if (this.addType === 'folder') {
                    document.getElementById('addFreqGroup').style.display = 'none';
                } else {
                    document.getElementById('addFreqGroup').style.display = 'block';
                    document.getElementById('addFreq').value = (state.freq/1e6).toFixed(3);
                    this.selAddMod(state.mode);
                }
                document.getElementById('addName').focus();
            } else if (type === 'edit') {
                const target = state.bm.find(b => b.id === id);
                if (!target) return;
                state.editTargetId = id;
                document.getElementById('modalAdd').style.display = 'flex';
                this.addType = target.isFolder ? 'folder' : 'freq';
                document.getElementById('addTitle').innerText = target.isFolder ? "Edit Folder" : "Edit Channel";
                document.getElementById('addName').value = target.title;
                if (target.isFolder) {
                     document.getElementById('addFreqGroup').style.display = 'none';
                } else {
                     document.getElementById('addFreqGroup').style.display = 'block';
                     document.getElementById('addFreq').value = target.freq;
                     this.selAddMod(target.mode);
                }
            } else if (type === 'move') {
                state.moveTargetId = id;
                document.getElementById('modalMove').style.display = 'flex';
                const list = document.getElementById('moveFolderList');
                list.innerHTML = this.genFolderListHtml(null, 0);
            }
        },
        genFolderListHtml(parentId, depth) {
            let html = '';
            // Root
            if (parentId === null) {
                html += `<div class="move-item" onclick="window.ws.changeParent(null)"><span class="material-symbols-outlined" style="margin-right:8px">home</span> ROOT</div>`;
            }
            
            const children = state.bm.filter(b => b.parentId === parentId && b.isFolder);
            children.forEach(c => {
                if (c.id === state.moveTargetId) return; // Can't move into self
                const pad = depth * 20;
                html += `<div class="move-item" style="padding-left:${12+pad}px" onclick="window.ws.changeParent('${c.id}')"><span class="material-symbols-outlined" style="margin-right:8px">folder</span> ${c.title}</div>`;
                html += this.genFolderListHtml(c.id, depth + 1);
            });
            return html;
        },
        closeModal() {
            document.getElementById('modalTune').style.display = 'none';
            document.getElementById('modalAdd').style.display = 'none';
            document.getElementById('modalMove').style.display = 'none';
        },
        selMod(m) {
            this.modalMode = m;
            document.getElementById('modAM').className = 'btn '+(m==='AM'?'active':'');
            document.getElementById('modFM').className = 'btn '+(m==='FM'?'active':'');
            document.getElementById('modWFM').className = 'btn '+(m==='WFM'?'active':'');
        },
        selAddMod(m) {
            this.addMode = m;
            document.getElementById('addModAM').className = 'btn '+(m==='AM'?'active':'');
            document.getElementById('addModFM').className = 'btn '+(m==='FM'?'active':'');
            document.getElementById('addModWFM').className = 'btn '+(m==='WFM'?'active':'');
        },
        renderBM(list) {
            const d = list || state.bm;
            const roots = []; const map = {};
            d.forEach(i => map[i.id] = {...i, c:[]});
            d.forEach(i => { if(i.parentId && map[i.parentId]) map[i.parentId].c.push(map[i.id]); else roots.push(map[i.id]); });
            document.getElementById('listBM').innerHTML = this.tree(roots);
        },
        tree(nodes) {
            const isEdit = state.editMode;
            
            return nodes.map((n, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === nodes.length - 1;
                
                // Only show Edit Controls in Edit Mode
                let acts = '';
                if (isEdit) {
                    const moveBtns = `
                        ${!isFirst ? `<button class="ib ib-move" onclick="event.stopPropagation(); window.ws.move('${n.id}', 'up')"><span class="material-symbols-outlined">arrow_upward</span></button>` : ''}
                        ${!isLast ? `<button class="ib ib-move" onclick="event.stopPropagation(); window.ws.move('${n.id}', 'down')"><span class="material-symbols-outlined">arrow_downward</span></button>` : ''}
                    `;
                    
                    let addSubBtns = '';
                    if (n.isFolder) {
                        addSubBtns += `<button class="ib" onclick="event.stopPropagation(); window.ui.modal('add_freq', '${n.id}')" title="Add Channel"><span class="material-symbols-outlined">add</span></button>`;
                        addSubBtns += `<button class="ib" onclick="event.stopPropagation(); window.ui.modal('add_folder', '${n.id}')" title="Add Sub-Folder"><span class="material-symbols-outlined">create_new_folder</span></button>`;
                    }
                    
                    // Move Folder/Item Button
                    const moveParentBtn = `<button class="ib" onclick="event.stopPropagation(); window.ui.modal('move', '${n.id}')" title="Move to Folder"><span class="material-symbols-outlined">drive_file_move</span></button>`;

                    acts = `
                        ${moveBtns}
                        ${moveParentBtn}
                        ${addSubBtns}
                        <button class="ib" onclick="event.stopPropagation(); window.ui.modal('edit', '${n.id}')"><span class="material-symbols-outlined">edit</span></button>
                        <button class="ib ib-del" onclick="event.stopPropagation(); window.ws.del('${n.id}')"><span class="material-symbols-outlined">delete</span></button>
                    `;
                }

                // Interaction Logic
                let onClick = '';
                let cursor = '';
                
                if (n.isFolder) {
                    // Folder: Always toggle expand (Edit mode also allows expanding to see children)
                    onClick = `window.ui.tog('${n.id}')`;
                } else {
                    // Channel: Tune only in View Mode. In Edit Mode, clicking row does nothing (safety)
                    if (!isEdit) onClick = `window.ws.tuneDir(${n.freq}, '${n.mode}')`;
                    else onClick = "event.stopPropagation(); window.ui.modal('edit', '"+n.id+"')"; // Edit on click in edit mode
                }

                if(n.isFolder) {
                    const open = state.expanded.has(n.id);
                    return `
                        <div>
                            <div class="row" onclick="${onClick}">
                                <div class="row-click-area">
                                    <span class="material-symbols-outlined icon ${open?'rot':''}">chevron_right</span>
                                    <span style="font-weight:600; margin-left:10px;">${n.title}</span>
                                </div>
                                <div class="act">${acts}</div>
                            </div>
                            <div class="folder-c ${open?'open':''}">${this.tree(n.c)}</div>
                        </div>`;
                }
                return `
                    <div class="row" onclick="${onClick}">
                        <div class="row-click-area">
                            <div class="txt">
                                <span style="font-weight:600;">${n.title}</span>
                                <span class="sub">${n.freq.toFixed(3)} MHz ${n.mode}</span>
                            </div>
                        </div>
                        <div class="act">${acts}</div>
                    </div>`;
            }).join('');
        },
        tog(id) {
            if(state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
            this.renderBM();
        },
        renderRec(list) {
            document.getElementById('listRec').innerHTML = list.map(f => `
                <div class="row">
                    <div class="row-click-area">
                        <div class="txt">
                            <span style="font-weight:600;">${f.name.split('_')[2]||f.name}</span>
                            <span class="sub">${(f.size/1024/1024).toFixed(2)} MB</span>
                        </div>
                    </div>
                    <div class="act">
                        <a href="/download/${f.name}" class="ib" download><span class="material-symbols-outlined">download</span></a>
                        <button class="ib ib-del" onclick="window.ws.delRec('${f.name}')"><span class="material-symbols-outlined">delete</span></button>
                    </div>
                </div>`).join('');
        }
    };

    window.ws = {
        c: null,
        connect() {
            this.c = new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);
            this.c.binaryType = 'arraybuffer';
            this.c.onmessage = e => {
                if(typeof e.data === 'string') {
                    const m = JSON.parse(e.data);
                    if(m.type==='status_update') window.ui.upd(m);
                    else if(m.type==='bookmarks') { state.bm = m.data; window.ui.renderBM(); }
                    else if(m.type==='recordings') window.ui.renderRec(m.data);
                    else if(m.type==='error') alert(m.msg);
                } else this.audio(e.data);
            };
            this.c.onclose = () => setTimeout(()=>this.connect(), 3000);
        },
        send(o) { if(this.c&&this.c.readyState===1) this.c.send(JSON.stringify(o)); },
        sendSq(v) { this.send({type:'set_squelch', val:parseInt(v)}); },
        setMode(m) { state.mode=m; this.tune(true); },
        setAtt(a) { this.send({type:'set_att', att:a}); },
        togRec() { this.send({type:state.rec?'stop_recording':'start_recording'}); },
        move(id, dir) { this.send({type:'move_bookmark', id, dir}); },
        changeParent(pid) {
            if (state.moveTargetId) {
                this.send({type:'change_parent', id:state.moveTargetId, newParentId:pid});
                window.ui.closeModal();
            }
        },
        tune(skip=false) {
            let f = state.freq;
            const m = window.ui.modalMode; 
            if(!skip) { const v = parseFloat(document.getElementById('inpFreq').value); if(v) f = Math.floor(v*1e6); }
            const p = document.getElementById('inpPass').value;
            this.send({type:'auth_tune', password:p, freq:f, mode:m});
            window.ui.closeModal();
        },
        tuneDir(f, m) {
            const p = document.getElementById('inpPass').value;
            if (!p) {
                state.freq = Math.floor(f*1e6);
                state.mode = m;
                document.getElementById('inpFreq').value = f.toFixed(3);
                window.ui.selMod(m);
                window.ui.modal('tune');
                return;
            }
            this.send({type:'auth_tune', password:p, freq:Math.floor(f*1e6), mode:m});
            state.mode = m;
        },
        saveBookmark() {
            const title = document.getElementById('addName').value;
            if (!title) return;
            const isFolder = (window.ui.addType === 'folder');
            
            if (state.editTargetId) {
                const data = { id: state.editTargetId, title, isFolder };
                if (!isFolder) {
                    const freqVal = parseFloat(document.getElementById('addFreq').value);
                    if (!freqVal) return;
                    data.freq = freqVal;
                    data.mode = window.ui.addMode;
                }
                this.send({type:'edit_bookmark', data});
            } else {
                const data = { title, isFolder, parentId: window.ui.targetParent };
                if (!isFolder) {
                    const freqVal = parseFloat(document.getElementById('addFreq').value);
                    if (!freqVal) return;
                    data.freq = freqVal;
                    data.mode = window.ui.addMode;
                }
                this.send({type:'add_bookmark', data});
            }
            window.ui.closeModal();
        },
        del(id) { if(confirm('Delete?')) this.send({type:'delete_bookmark', id}); },
        delRec(n) { if(confirm('Delete?')) this.send({type:'delete_recording', filename:n}); },
        
        audio(b) {
            if(!audioCtx || audioCtx.state !== 'running') return;

            const dv = new DataView(b);
            const rssi = dv.getInt16(0, true);
            const sqlOpen = dv.getInt16(2, true);
            
            const bar = window.ui.els.rssi;
            bar.style.width = Math.min(100, (rssi/200)*100)+'%';
            if(sqlOpen) bar.classList.add('active'); else bar.classList.remove('active');
            const bdgSql = document.getElementById('bdgSql');
            if (sqlOpen) { bdgSql.innerText = 'SQL OPEN'; bdgSql.className = 'badge badge-sql open'; } 
            else { bdgSql.innerText = 'MUTED'; bdgSql.className = 'badge badge-sql'; }

            const f = new Float32Array((b.byteLength - 4) / 2);
            const s16 = new Int16Array(b, 4);
            for(let i=0; i<f.length; i++) f[i] = s16[i]/32768.0;

            const buf = audioCtx.createBuffer(1, f.length, 48000);
            buf.getChannelData(0).set(f);

            const now = audioCtx.currentTime;
            if (nextStartTime < now) nextStartTime = now;

            const s = audioCtx.createBufferSource();
            s.buffer = buf;
            if (window.audioDest) s.connect(window.audioDest);
            else s.connect(audioCtx.destination);
            
            s.start(nextStartTime);
            nextStartTime += buf.duration;
        }
    };

    window.ui.init();
</script>
</body>
</html>
`;