/**
 * Modern Web SDR - ATT MID Adjusted (Gain 10)
 * Core: rtl_fm -> Node.js -> Modern UI
 */

const http = require('http');
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
    sampleRate: 24000,
    ppm: 0,
    
    // パス設定
    recordingsPath: path.join(__dirname, 'recordings'),
    bookmarksFile: path.join(__dirname, 'bookmarks.json'),
    squelchFile: path.join(__dirname, 'squelch_data.json'),
};

if (!fs.existsSync(CONFIG.recordingsPath)) fs.mkdirSync(CONFIG.recordingsPath);

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
  { "title": "Date FM", "freq": 77.1, "mode": "FM", "isFolder": false, "parentId": "1763731929504", "id": "1763732002721" }
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
    process(inputBuffer, opts) {
        const len = inputBuffer.length / 2;
        const out = Buffer.alloc(len * 2);
        const sqThresh = opts.squelchThreshold / 100.0;
        let sumSq = 0;

        for (let i = 0; i < len; i++) {
            let s = inputBuffer.readInt16LE(i * 2) / 32768.0;
            // HPF
            let raw = s; s = raw - 0.95 * this.lastIn + 0.95 * this.lastOut; this.lastIn = raw; this.lastOut = s;
            sumSq += s * s;
            
            // AGC
            this.agcPeak = this.agcPeak * 0.999 + Math.abs(s) * 0.001;
            let g = 0.6 / (this.agcPeak + 0.05);
            if (g > 15.0) g = 15.0; if (g < 1.0) g = 1.0;
            this.agcGain = this.agcGain * 0.99 + g * 0.01;
            
            let p = s * this.agcGain * this.squelchGate;
            if (p > 0.98) p = 0.98; if (p < -0.98) p = -0.98;
            out.writeInt16LE(Math.floor(p * 32767), i * 2);
        }

        const rms = Math.sqrt(sumSq / len);
        this.rms = this.rms * 0.8 + rms * 0.2;

        // Instant Squelch Logic
        const open = Math.max(0.005, sqThresh); 
        const close = open * 0.8; 
        if (this.rms > open) this.squelchGate = 1.0;
        else if (this.rms < close) this.squelchGate = 0.0;

        return { 
            buffer: out, 
            rssi: Math.min(100, Math.floor(Math.sqrt(this.rms) * 200)), 
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
    
    // Attenuator Logic (Gain Control)
    let gainVal = '48'; // OFF = Max
    if (att === 'weak') gainVal = '35';   // WEAK
    if (att === 'mid')  gainVal = '10';   // MID (Changed to 10)
    if (att === 'strong') gainVal = '0';  // STRONG

    const args = ['-M', (mode === 'FM' ? 'fm' : 'am'), '-f', freq.toString(), '-s', CONFIG.sampleRate.toString(), '-g', gainVal, '-p', CONFIG.ppm.toString(), '-F', '9'];
    console.log(`[Radio] Tune: ${(freq/1e6).toFixed(3)} MHz (${mode}) ATT:${att}(${gainVal})`);
    
    rtlProcess = spawn('rtl_fm', args);
    rtlProcess.stdout.on('data', (c) => handleAudio(c));
    setTimeout(() => broadcastStatus(), 500);
}

function handleAudio(raw) {
    const res = dsp.process(raw, { squelchThreshold });
    const head = new Int16Array(1); head[0] = res.rssi;
    // Embed Squelch Status
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
            if (c.type === 'auth_tune') {
                if (c.password === CONFIG.password) startRadio(c.freq, c.mode, currentAtt);
            }
            else if (c.type === 'set_att') startRadio(currentFreq, currentMode, c.att);
            else if (c.type === 'set_squelch') { squelchThreshold = c.val; squelchDB[currentFreq] = c.val; saveData(); broadcastStatus(); }
            else if (c.type === 'start_recording') startRec();
            else if (c.type === 'stop_recording') stopRec();
            else if (c.type === 'delete_recording') { fs.unlinkSync(path.join(CONFIG.recordingsPath, c.filename)); broadcastRecordings(); }
            else if (c.type === 'add_bookmark') { c.data.id = Date.now().toString(); bookmarks.push(c.data); saveData(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); }
            else if (c.type === 'delete_bookmark') { bookmarks = bookmarks.filter(b=>b.id!==c.id && b.parentId!==c.id); saveData(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); }
        } catch(e){}
    });
});

server.listen(CONFIG.webPort, () => {
    console.log(`[System] Interface Ready: http://localhost:${CONFIG.webPort}`);
    startRadio(CONFIG.initialFreq, CONFIG.initialMode, 'off');
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
    :root { --bg: #050507; --panel: rgba(30, 30, 35, 0.7); --acc: #00ffc8; --acc-dim: rgba(0,255,200,0.15); --txt: #fff; --sub: #8b9bb4; }
    body { background: var(--bg); color: var(--txt); font-family: 'Inter', sans-serif; margin: 0; display: flex; justify-content: center; min-height: 100vh; user-select: none; -webkit-user-select: none; touch-action: manipulation; }
    .app { width: 100%; max-width: 480px; padding: 20px 20px 100px; box-sizing: border-box; }
    .panel { background: var(--panel); backdrop-filter: blur(12px); border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); padding: 20px; margin-bottom: 16px; }
    
    .freq { font-family: 'JetBrains Mono', monospace; font-size: 3.2rem; text-align: center; font-weight: 700; line-height: 1; text-shadow: 0 0 20px var(--acc-dim); margin: 15px 0; }
    .badges { display: flex; justify-content: center; gap: 8px; }
    .badge { font-size: 0.75rem; padding: 4px 10px; border-radius: 20px; background: rgba(255,255,255,0.05); color: var(--sub); border: 1px solid rgba(255,255,255,0.05); }
    .badge-sql.open { background: var(--acc-dim); color: var(--acc); border-color: var(--acc); }
    
    .meter-wrap { position: relative; height: 36px; margin-top: 20px; display: flex; align-items: center; }
    .meter-bg { position: absolute; left: 0; right: 0; top: 12px; bottom: 12px; background: rgba(255,255,255,0.1); border-radius: 6px; overflow: hidden; }
    .meter-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2196f3, var(--acc)); transition: width 0.05s ease-out; }
    
    input[type=range] { 
        position: absolute; left: 0; width: 100%; height: 100%; 
        -webkit-appearance: none; background: transparent; margin: 0; z-index: 10; cursor: pointer;
    }
    input[type=range]::-webkit-slider-runnable-track { width: 100%; height: 100%; background: transparent; }
    input[type=range]::-webkit-slider-thumb { 
        -webkit-appearance: none; 
        height: 36px; width: 4px; 
        background: #ffd700; border-radius: 2px;
        box-shadow: 0 0 10px #ffd700;
        margin-top: 0px; 
    }
    .sq-label { text-align: center; font-size: 0.7rem; color: var(--sub); margin-top: 4px; }

    .ctrls { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
    .btn-row { display: flex; gap: 8px; width: 100%; }
    .btn { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--txt); padding: 12px 8px; border-radius: 12px; font-weight: 600; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 6px; font-size: 0.75rem; transition: background 0.1s; white-space: nowrap; }
    .btn:active { background: rgba(255,255,255,0.15); transform: scale(0.98); }
    .btn.active { background: var(--acc-dim); border-color: var(--acc); color: var(--acc); }
    .btn-tune { background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05)); font-size: 1rem; }
    .rec.on { background: #ff3b30; color: #fff; border-color: #ff3b30; animation: p 2s infinite; }
    @keyframes p { 0% {opacity:1} 50% {opacity:0.7} 100% {opacity:1} }

    .tree { display: flex; flex-direction: column; gap: 2px; }
    .row { display: flex; align-items: center; padding: 12px; background: rgba(255,255,255,0.02); border-radius: 8px; cursor: pointer; justify-content: space-between; transition: background 0.1s; }
    .row:hover { background: rgba(255,255,255,0.05); }
    .row:active { background: rgba(255,255,255,0.08); }
    .row-click-area { display: flex; align-items: center; flex: 1; height: 100%; } 
    .folder-c { margin-left: 10px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 10px; display: none; }
    .folder-c.open { display: block; }
    .icon { color: var(--sub); font-size: 1.2rem; transition: transform 0.2s; }
    .icon.rot { transform: rotate(90deg); }
    .txt { display: flex; flex-direction: column; }
    .sub { font-size: 0.8rem; color: var(--sub); }
    .act { display: flex; gap: 4px; }
    .ib { background: transparent; border: none; color: var(--sub); padding: 8px; cursor: pointer; border-radius: 50%; z-index: 10; }
    .ib:active { background: rgba(255,255,255,0.1); color: #fff; }

    .ovl { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); backdrop-filter:blur(8px); display:none; justify-content:center; align-items:flex-end; z-index: 1000; }
    .card { background: #1a1b20; width:100%; max-width:480px; padding:30px; border-radius:24px 24px 0 0; box-shadow: 0 -10px 40px #000; animation: up 0.3s; }
    @keyframes up { from{transform:translateY(100%)}to{transform:translateY(0)} }
    .inp { width:100%; background:#27282e; border:none; padding:16px; border-radius:12px; color:#fff; font-size:1.2rem; margin-bottom:15px; box-sizing:border-box; outline:none; }
    .inp:focus { outline: 2px solid var(--acc); }
    
    .start-ovl { position: fixed; top:0; left:0; width:100%; height:100%; background:#050507; z-index: 2000; display:flex; justify-content:center; align-items:center; flex-direction:column; transition: opacity 0.3s; }
    .big-btn { background: var(--acc); color: #000; border: none; padding: 18px 40px; border-radius: 50px; font-size: 1.2rem; font-weight: 800; box-shadow: 0 0 30px var(--acc); cursor: pointer; }
</style>
</head>
<body>
    <div class="start-ovl" id="startScreen">
        <div style="font-size:3rem; margin-bottom:20px;">📡</div>
        <button class="big-btn" onclick="window.ui.init()">CONNECT SYSTEM</button>
    </div>

    <div class="app">
        <div class="panel">
            <div class="badges">
                <span class="badge" id="bdgMode">AM</span>
                <span class="badge" id="bdgAtt" style="display:none">ATT</span>
                <span class="badge" id="bdgSql">MUTED</span>
            </div>
            <div class="freq" id="dspFreq">---.---</div>
            
            <div class="meter-wrap">
                <div class="meter-bg"><div class="meter-fill" id="dspRssi"></div></div>
                <input type="range" id="inpSq" min="0" max="60" value="10" oninput="window.ui.updSq(this.value)" onchange="window.ws.sendSq(this.value)">
            </div>
            <div class="sq-label">SQUELCH THRESHOLD</div>
        </div>

        <div class="ctrls">
            <div class="btn-row">
                <button class="btn btn-tune" style="flex:2" onclick="window.ui.modal(true)"><span class="material-symbols-outlined">dialpad</span> TUNE</button>
                <button class="btn" id="btnRec" style="flex:1" onclick="window.ws.togRec()"><span class="material-symbols-outlined">fiber_manual_record</span> REC</button>
            </div>
            <div class="btn-row">
                <button class="btn active" id="attOff" onclick="window.ws.setAtt('off')">NO ATT</button>
                <button class="btn" id="attWeak" onclick="window.ws.setAtt('weak')">WEAK</button>
                <button class="btn" id="attMid" onclick="window.ws.setAtt('mid')">MID</button>
                <button class="btn" id="attStrong" onclick="window.ws.setAtt('strong')">STRONG</button>
            </div>
        </div>

        <div style="color:var(--sub); font-size:0.8rem; margin:20px 0 5px;">BOOKMARKS</div>
        <div class="panel" id="listBM" style="padding:10px;"></div>

        <div style="color:var(--sub); font-size:0.8rem; margin:20px 0 5px;">RECORDINGS</div>
        <div class="panel" id="listRec" style="padding:10px;"></div>
    </div>

    <div class="ovl" id="modal">
        <div class="card">
            <div style="color:#fff; font-weight:700; font-size:1.2rem; margin-bottom:20px;">Set Frequency</div>
            <input type="number" class="inp" id="inpFreq" placeholder="128.800" step="0.001">
            <div style="display:flex; gap:10px; margin-bottom:15px;">
                <button class="btn" id="modAM" onclick="window.ui.selMod('AM')">AM</button>
                <button class="btn" id="modFM" onclick="window.ui.selMod('FM')">FM</button>
            </div>
            <input type="password" class="inp" id="inpPass" placeholder="Password (required)">
            <div style="display:flex; gap:10px;">
                <button class="btn" style="flex:1" onclick="window.ui.modal(false)">CANCEL</button>
                <button class="btn" style="flex:1; background:var(--acc); color:#000;" onclick="window.ws.tune()">TUNE</button>
            </div>
        </div>
    </div>

<script>
    let audioCtx, wsConn, nextTime=0;
    const state = { freq:0, mode:'AM', att:'off', rec:false, bm:[], expanded:new Set() };

    window.ui = {
        els: { freq:document.getElementById('dspFreq'), rssi:document.getElementById('dspRssi') },
        modalMode: 'AM',
        init() {
            audioCtx = new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});
            if(audioCtx.state==='suspended') audioCtx.resume();
            const o=audioCtx.createOscillator(); const g=audioCtx.createGain();
            o.connect(g); g.connect(audioCtx.destination); o.frequency.value=10; g.gain.value=0.001; o.start();
            document.getElementById('startScreen').style.opacity='0';
            setTimeout(()=>document.getElementById('startScreen').style.display='none',300);
            window.ws.connect();
        },
        upd(m) {
            state.freq=m.freq; state.mode=m.mode; state.att=m.att; state.rec=m.isRecording;
            this.els.freq.innerText = (m.freq/1e6).toFixed(3);
            document.getElementById('bdgMode').innerText = m.mode;
            document.getElementById('bdgAtt').style.display = m.att!=='off'?'inline-block':'none';
            document.getElementById('bdgAtt').innerText = 'ATT '+m.att.toUpperCase();
            
            ['off','weak','mid','strong'].forEach(k => {
                document.getElementById('att'+k.charAt(0).toUpperCase()+k.slice(1)).className = 'btn '+(m.att===k?'active':'');
            });
            
            document.getElementById('btnRec').className = 'btn '+(m.isRecording?'rec on':'');
            document.getElementById('inpSq').value = m.squelch;
        },
        updSq(v) { /* handled by css */ },
        modal(show) {
            document.getElementById('modal').style.display = show?'flex':'none';
            if(show) { 
                document.getElementById('inpFreq').value = (state.freq/1e6).toFixed(3); 
                this.selMod(state.mode); 
                document.getElementById('inpPass').focus();
            }
        },
        selMod(m) {
            this.modalMode = m;
            document.getElementById('modAM').className = 'btn '+(m==='AM'?'active':'');
            document.getElementById('modFM').className = 'btn '+(m==='FM'?'active':'');
        },
        renderBM(list) {
            const d = list || state.bm;
            const roots = []; const map = {};
            d.forEach(i => map[i.id] = {...i, c:[]});
            d.forEach(i => { if(i.parentId && map[i.parentId]) map[i.parentId].c.push(map[i.id]); else roots.push(map[i.id]); });
            document.getElementById('listBM').innerHTML = this.tree(roots);
        },
        tree(nodes) {
            return nodes.map(n => {
                if(n.isFolder) {
                    const open = state.expanded.has(n.id);
                    return \`
                        <div>
                            <div class="row" onclick="window.ui.tog('\${n.id}')">
                                <div class="row-click-area">
                                    <span class="material-symbols-outlined icon \${open?'rot':''}">chevron_right</span>
                                    <span style="font-weight:600; margin-left:10px;">\${n.title}</span>
                                </div>
                                <div class="act">
                                    <button class="ib" onclick="event.stopPropagation(); window.ws.add('\${n.id}')"><span class="material-symbols-outlined">add</span></button>
                                    <button class="ib" onclick="event.stopPropagation(); window.ws.del('\${n.id}')"><span class="material-symbols-outlined">delete</span></button>
                                </div>
                            </div>
                            <div class="folder-c \${open?'open':''}">\${this.tree(n.c)}</div>
                        </div>\`;
                }
                return \`
                    <div class="row" onclick="window.ws.tuneDir(\${n.freq}, '\${n.mode}')">
                        <div class="row-click-area">
                            <div class="txt">
                                <span style="font-weight:600;">\${n.title}</span>
                                <span class="sub">\${n.freq.toFixed(3)} MHz \${n.mode}</span>
                            </div>
                        </div>
                        <button class="ib" onclick="event.stopPropagation(); window.ws.del('\${n.id}')"><span class="material-symbols-outlined">delete</span></button>
                    </div>\`;
            }).join('');
        },
        tog(id) {
            if(state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
            this.renderBM();
        },
        renderRec(list) {
            document.getElementById('listRec').innerHTML = list.map(f => \`
                <div class="row">
                    <div class="row-click-area">
                        <div class="txt">
                            <span style="font-weight:600;">\${f.name.split('_')[2]||f.name}</span>
                            <span class="sub">\${(f.size/1024/1024).toFixed(2)} MB</span>
                        </div>
                    </div>
                    <div class="act">
                        <a href="/download/\${f.name}" class="ib" download><span class="material-symbols-outlined">download</span></a>
                        <button class="ib" onclick="window.ws.delRec('\${f.name}')"><span class="material-symbols-outlined">delete</span></button>
                    </div>
                </div>\`).join('');
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
        tune(skip=false) {
            let f = state.freq;
            const m = window.ui.modalMode; 
            if(!skip) { const v = parseFloat(document.getElementById('inpFreq').value); if(v) f = Math.floor(v*1e6); }
            const p = document.getElementById('inpPass').value;
            this.send({type:'auth_tune', password:p, freq:f, mode:m});
            window.ui.modal(false);
        },
        tuneDir(f, m) {
            const p = document.getElementById('inpPass').value;
            if (!p) {
                state.freq = Math.floor(f*1e6);
                state.mode = m;
                document.getElementById('inpFreq').value = f.toFixed(3);
                window.ui.selMod(m);
                window.ui.modal(true);
                return;
            }
            this.send({type:'auth_tune', password:p, freq:Math.floor(f*1e6), mode:m});
            state.mode = m;
        },
        add(pid) {
            const isF = confirm("Create a Folder? (Cancel for Channel)");
            const t = prompt(isF?"Folder Name":"Name"); if(!t) return;
            const d = {title:t, isFolder:isF, parentId:pid};
            if(!isF) { d.freq = state.freq/1e6; d.mode = state.mode; }
            this.send({type:'add_bookmark', data:d});
        },
        del(id) { if(confirm('Delete?')) this.send({type:'delete_bookmark', id}); },
        delRec(n) { if(confirm('Delete?')) this.send({type:'delete_recording', filename:n}); },
        audio(b) {
            if(!audioCtx) return;
            const dv = new DataView(b);
            const rssi = dv.getInt16(0, true);
            const sqlOpen = dv.getInt16(2, true);
            
            window.ui.els.rssi.style.width = Math.min(100, (rssi/200)*100)+'%';
            const bdgSql = document.getElementById('bdgSql');
            if (sqlOpen) {
                bdgSql.innerText = 'SQL OPEN';
                bdgSql.className = 'badge badge-sql open';
            } else {
                bdgSql.innerText = 'MUTED';
                bdgSql.className = 'badge badge-sql';
            }

            const f = new Float32Array((b.byteLength - 4) / 2);
            const s16 = new Int16Array(b, 4);
            for(let i=0; i<f.length; i++) f[i] = s16[i]/32768.0;
            
            const buf = audioCtx.createBuffer(1, f.length, 24000);
            buf.getChannelData(0).set(f);
            const s = audioCtx.createBufferSource(); s.buffer=buf; s.connect(audioCtx.destination);
            const now = audioCtx.currentTime;
            if(nextTime < now) nextTime = now + 0.04;
            s.start(nextTime); nextTime += buf.duration;
        }
    };
</script>
</body>
</html>
`;