/**
 * Modern Web SDR - UI Remastered
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
    password: "admin", // チューニング用パスワード
    
    // SDR初期設定
    initialFreq: 128800000, // 128.80 MHz
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

function loadData() {
    try {
        if (fs.existsSync(CONFIG.bookmarksFile)) bookmarks = JSON.parse(fs.readFileSync(CONFIG.bookmarksFile));
        if (fs.existsSync(CONFIG.squelchFile)) squelchDB = JSON.parse(fs.readFileSync(CONFIG.squelchFile));
    } catch (e) {}
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
        this.lastIn = 0; this.lastOut = 0;
        this.agcPeak = 0; this.agcGain = 1.0;
        this.squelchGate = 0.0; this.rms = 0;
    }
    process(inputBuffer, opts) {
        const inputLen = inputBuffer.length / 2;
        const outputBuffer = Buffer.alloc(inputLen * 2);
        const squelchThresh = opts.squelchThreshold / 100.0;
        let sumSq = 0;

        for (let i = 0; i < inputLen; i++) {
            let sample = inputBuffer.readInt16LE(i * 2) / 32768.0;
            
            // HPF (DC Cut)
            let raw = sample;
            sample = raw - 0.95 * this.lastIn + 0.95 * this.lastOut;
            this.lastIn = raw; this.lastOut = sample;

            sumSq += sample * sample;

            // AGC
            const absSample = Math.abs(sample);
            this.agcPeak = this.agcPeak * 0.999 + absSample * 0.001;
            let targetGain = 0.6 / (this.agcPeak + 0.05);
            if (targetGain > 15.0) targetGain = 15.0;
            if (targetGain < 1.0) targetGain = 1.0;
            this.agcGain = this.agcGain * 0.99 + targetGain * 0.01;
            
            let processed = sample * this.agcGain * this.squelchGate;
            
            // Limiter
            if (processed > 0.98) processed = 0.98;
            if (processed < -0.98) processed = -0.98;

            outputBuffer.writeInt16LE(Math.floor(processed * 32767), i * 2);
        }

        const blockRms = Math.sqrt(sumSq / inputLen);
        this.rms = this.rms * 0.8 + blockRms * 0.2;

        // Squelch Logic
        const openThresh = Math.max(0.005, squelchThresh);
        const closeThresh = openThresh * 0.8;
        if (this.rms > openThresh) this.squelchGate = 0.9 * this.squelchGate + 0.1;
        else if (this.rms < closeThresh) {
            this.squelchGate *= 0.95;
            if (this.squelchGate < 0.01) this.squelchGate = 0;
        }

        const displayRssi = Math.min(100, Math.floor(Math.sqrt(this.rms) * 200)); 
        return { buffer: outputBuffer, rssi: displayRssi, isOpen: this.squelchGate > 0.1 };
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
let isTuning = false;
let isRecording = false;
let recordingStream = null;
let recordingFilename = "";
let squelchThreshold = 10;

function startRadio(freq, mode, att) {
    if (rtlProcess) { rtlProcess.kill(); rtlProcess = null; }
    
    currentFreq = freq; currentMode = mode; currentAtt = att;
    isTuning = true; dsp.reset();

    let gainVal = '40';
    if (att === 'weak') gainVal = '20';
    if (att === 'strong') gainVal = '0';

    const args = ['-M', mode === 'FM' ? 'fm' : 'am', '-f', freq.toString(), '-s', CONFIG.sampleRate.toString(), '-g', gainVal, '-p', CONFIG.ppm.toString(), '-F', '9'];
    console.log(`[Radio] Tune: ${(freq/1e6).toFixed(3)} MHz (${mode})`);
    
    rtlProcess = spawn('rtl_fm', args);
    rtlProcess.stdout.on('data', (chunk) => handleAudioStream(chunk));
    
    setTimeout(() => { isTuning = false; broadcastStatus(); }, 500);
}

function handleAudioStream(rawChunk) {
    const result = dsp.process(rawChunk, { squelchThreshold });
    const header = new Int16Array(1); header[0] = result.rssi;
    const sendBuffer = Buffer.concat([Buffer.from(header.buffer), result.buffer]);

    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(sendBuffer); });

    if (isRecording && recordingStream && result.isOpen) {
        recordingStream.write(result.buffer);
    }
}

function startRec() {
    if (isRecording) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    recordingFilename = `${currentMode}_${(currentFreq/1e6).toFixed(3)}MHz_${ts}.wav`;
    const fp = path.join(CONFIG.recordingsPath, recordingFilename);
    recordingStream = fs.createWriteStream(fp);
    writeWavHeader(recordingStream, CONFIG.sampleRate, 0);
    isRecording = true;
    broadcastStatus();
}

function stopRec() {
    if (!isRecording) return;
    isRecording = false;
    if (recordingStream) {
        const fp = recordingStream.path;
        const bytes = recordingStream.bytesWritten - 44;
        recordingStream.end();
        setTimeout(() => {
            fs.open(fp, 'r+', (err, fd) => {
                if (!err) {
                    const buf = Buffer.alloc(44);
                    // Minimal WAV Header update
                    buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
                    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
                    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(CONFIG.sampleRate, 24);
                    buf.writeUInt32LE(CONFIG.sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
                    buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
                    fs.write(fd, buf, 0, 44, 0, () => fs.close(fd, ()=>{}));
                }
            });
        }, 100);
        recordingStream = null;
    }
    broadcastStatus(); broadcastRecordings();
}

function writeWavHeader(stream, sampleRate, len) {
    const b = Buffer.alloc(44);
    b.write('RIFF',0); b.writeUInt32LE(36+len,4); b.write('WAVE',8); b.write('fmt ',12);
    b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(sampleRate,24);
    b.writeUInt32LE(sampleRate*2,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36);
    b.writeUInt32LE(len,40); stream.write(b);
}

// ==========================================
// Server & WebSocket
// ==========================================
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlContent);
    } else if (url.pathname.startsWith('/download/')) {
        const f = path.basename(decodeURIComponent(url.pathname));
        const fp = path.join(CONFIG.recordingsPath, f);
        if (fs.existsSync(fp)) {
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Disposition': `attachment; filename="${f}"` });
            fs.createReadStream(fp).pipe(res);
        } else { res.writeHead(404); res.end(); }
    } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocket.Server({ server });

function broadcastStatus() {
    const msg = JSON.stringify({ type: 'status_update', freq: currentFreq, mode: currentMode, att: currentAtt, isRecording, squelch: squelchThreshold });
    wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(msg); });
}
function broadcastRecordings() {
    try {
        const d = fs.readdirSync(CONFIG.recordingsPath).filter(f=>f.endsWith('.wav')).map(f=>({name:f, size:fs.statSync(path.join(CONFIG.recordingsPath,f)).size})).sort((a,b)=>b.name.localeCompare(a.name));
        const msg = JSON.stringify({type:'recordings', data:d});
        wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(msg); });
    } catch(e){}
}

wss.on('connection', ws => {
    broadcastStatus(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); broadcastRecordings();
    ws.on('message', m => {
        try {
            const c = JSON.parse(m);
            if (c.type === 'auth_tune') {
                if (c.password === CONFIG.password) startRadio(c.freq, c.mode, currentAtt);
                else ws.send(JSON.stringify({type:'error', msg:'Wrong Password'}));
            }
            else if (c.type === 'set_att') startRadio(currentFreq, currentMode, c.att);
            else if (c.type === 'set_squelch') { squelchThreshold = c.val; squelchDB[currentFreq] = c.val; saveData(); broadcastStatus(); }
            else if (c.type === 'start_recording') startRec();
            else if (c.type === 'stop_recording') stopRec();
            else if (c.type === 'delete_recording') { fs.unlinkSync(path.join(CONFIG.recordingsPath, c.filename)); broadcastRecordings(); }
            else if (c.type === 'add_bookmark') { c.data.id = Date.now().toString(); bookmarks.push(c.data); saveData(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); }
            else if (c.type === 'delete_bookmark') { bookmarks = bookmarks.filter(b=>b.id!==c.id); saveData(); ws.send(JSON.stringify({type:'bookmarks', data:bookmarks})); }
        } catch(e){}
    });
});

server.listen(CONFIG.webPort, () => {
    console.log(`[System] Interface Ready: http://localhost:${CONFIG.webPort}`);
    startRadio(CONFIG.initialFreq, CONFIG.initialMode, 'off');
});

// ==========================================
// Modern Frontend (HTML/CSS/JS)
// ==========================================
const htmlContent = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>SDR COMMANDER</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
    
    <style>
        :root {
            --bg-color: #050507;
            --card-bg: rgba(30, 30, 35, 0.6);
            --accent-color: #00ffc8;
            --accent-dim: rgba(0, 255, 200, 0.1);
            --danger-color: #ff3b30;
            --text-main: #ffffff;
            --text-sub: #8b9bb4;
            --glass-border: 1px solid rgba(255, 255, 255, 0.08);
            --radius: 16px;
        }

        body {
            background-color: var(--bg-color);
            background-image: radial-gradient(circle at 50% 0%, #1a1f35 0%, var(--bg-color) 70%);
            color: var(--text-main);
            font-family: 'Inter', sans-serif;
            margin: 0;
            padding: 0;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            -webkit-tap-highlight-color: transparent;
        }

        .app-container {
            width: 100%;
            max-width: 480px;
            padding: 20px;
            padding-bottom: 100px;
            box-sizing: border-box;
        }

        /* Glassmorphism Card */
        .glass-panel {
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: var(--glass-border);
            border-radius: var(--radius);
            padding: 20px;
            margin-bottom: 16px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        /* Frequency Display */
        .freq-display {
            text-align: center;
            position: relative;
            padding: 20px 0;
        }
        .freq-main {
            font-family: 'JetBrains Mono', monospace;
            font-size: 3.5rem;
            font-weight: 700;
            letter-spacing: -2px;
            color: var(--text-main);
            text-shadow: 0 0 20px var(--accent-dim);
            line-height: 1;
        }
        .freq-unit {
            color: var(--text-sub);
            font-size: 0.9rem;
            font-weight: 600;
            margin-top: 4px;
            letter-spacing: 2px;
        }
        .badges {
            display: flex;
            justify-content: center;
            gap: 8px;
            margin-bottom: 10px;
        }
        .badge {
            font-size: 0.75rem;
            padding: 4px 10px;
            border-radius: 20px;
            background: rgba(255,255,255,0.05);
            color: var(--text-sub);
            font-weight: 600;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .badge.active {
            background: var(--accent-dim);
            color: var(--accent-color);
            border-color: var(--accent-color);
        }

        /* Signal Meter */
        .meter-container {
            margin-top: 20px;
            position: relative;
        }
        .meter-track {
            height: 6px;
            background: rgba(255,255,255,0.1);
            border-radius: 3px;
            overflow: hidden;
            position: relative;
        }
        .meter-bar {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #2196f3, var(--accent-color));
            transition: width 0.08s ease-out;
            box-shadow: 0 0 10px var(--accent-color);
        }
        .sq-marker {
            position: absolute;
            top: -4px;
            bottom: -4px;
            width: 2px;
            background: #ffd700;
            z-index: 2;
            transition: left 0.1s;
            box-shadow: 0 0 5px #ffd700;
        }
        .sq-controls {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 12px;
        }
        .sq-icon { color: var(--text-sub); font-size: 1.2rem; }
        
        /* Modern Slider */
        input[type=range] {
            -webkit-appearance: none;
            width: 100%;
            background: transparent;
        }
        input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none;
            height: 18px;
            width: 18px;
            border-radius: 50%;
            background: #fff;
            cursor: pointer;
            margin-top: -7px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        }
        input[type=range]::-webkit-slider-runnable-track {
            width: 100%;
            height: 4px;
            cursor: pointer;
            background: rgba(255,255,255,0.15);
            border-radius: 2px;
        }

        /* Control Grid */
        .control-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 16px;
        }
        .btn {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.05);
            color: var(--text-main);
            padding: 14px;
            border-radius: 12px;
            font-size: 0.9rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        .btn:active { transform: scale(0.96); }
        .btn.active {
            background: var(--accent-dim);
            border-color: var(--accent-color);
            color: var(--accent-color);
        }
        .btn-tune {
            grid-column: span 2;
            background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
            font-size: 1rem;
        }
        .btn-rec {
            grid-column: span 2;
            background: rgba(255, 59, 48, 0.1);
            color: var(--danger-color);
            border-color: rgba(255, 59, 48, 0.3);
        }
        .btn-rec.recording {
            background: var(--danger-color);
            color: #fff;
            box-shadow: 0 0 20px rgba(255, 59, 48, 0.4);
            animation: pulse 2s infinite;
        }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }

        /* Start Overlay */
        .start-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(5, 5, 7, 0.95);
            backdrop-filter: blur(10px);
            z-index: 2000;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            transition: opacity 0.3s;
        }
        .start-btn {
            background: var(--accent-color);
            color: #000;
            border: none;
            padding: 18px 40px;
            border-radius: 50px;
            font-size: 1.2rem;
            font-weight: 800;
            box-shadow: 0 0 30px var(--accent-color);
            cursor: pointer;
            letter-spacing: 1px;
        }
        .start-btn:active { transform: scale(0.95); }

        /* Input Modal */
        .modal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6);
            backdrop-filter: blur(8px);
            z-index: 1000;
            display: none;
            justify-content: center;
            align-items: flex-end; /* Bottom sheet on mobile */
        }
        .modal-card {
            background: #1a1b20;
            width: 100%;
            max-width: 480px;
            border-top-left-radius: 24px;
            border-top-right-radius: 24px;
            padding: 30px;
            box-sizing: border-box;
            box-shadow: 0 -10px 40px rgba(0,0,0,0.5);
            animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

        .modal-title { font-size: 1.2rem; font-weight: 700; margin-bottom: 20px; color: #fff; }
        .input-group { position: relative; margin-bottom: 20px; }
        .modern-input {
            width: 100%;
            background: #27282e;
            border: 2px solid transparent;
            padding: 16px;
            border-radius: 12px;
            color: #fff;
            font-size: 1.2rem;
            font-family: 'Inter', sans-serif;
            box-sizing: border-box;
            outline: none;
            transition: 0.2s;
        }
        .modern-input:focus { border-color: var(--accent-color); background: #2d2e36; }
        .modal-actions { display: flex; gap: 12px; }
        .btn-primary { background: var(--accent-color); color: #000; flex: 1; border:none; }
        .btn-secondary { background: #333; color: #fff; flex: 1; border:none; }

        /* Lists */
        .section-title {
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-sub);
            margin: 24px 0 8px 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .list-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .item-main { display: flex; flex-direction: column; }
        .item-title { font-weight: 600; color: #fff; font-size: 1rem; }
        .item-sub { color: var(--text-sub); font-size: 0.8rem; margin-top: 2px; }
        .icon-btn {
            background: transparent; border: none; color: var(--text-sub);
            padding: 8px; cursor: pointer; border-radius: 50%;
        }
        .icon-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
    </style>
</head>
<body>

    <div class="start-overlay" id="startOverlay">
        <div style="font-size: 3rem; margin-bottom: 20px;">📡</div>
        <button class="start-btn" onclick="initApp()">CONNECT SYSTEM</button>
        <p style="color: #666; margin-top: 20px; font-size: 0.8rem;">Ready to monitor airwaves</p>
    </div>

    <div class="app-container">
        <div class="glass-panel">
            <div class="badges">
                <span class="badge" id="modeBadge">AM</span>
                <span class="badge" id="attBadge" style="display:none">ATT</span>
                <span class="badge" id="recBadge" style="display:none; color:var(--danger-color); border-color:var(--danger-color)">REC</span>
            </div>

            <div class="freq-display">
                <div class="freq-main" id="freqVal">---.---</div>
                <div class="freq-unit">MEGAHERTZ</div>
            </div>

            <div class="meter-container">
                <div class="meter-track">
                    <div class="meter-bar" id="rssiBar"></div>
                    <div class="sq-marker" id="sqMarker" style="left: 10%"></div>
                </div>
                <div class="sq-controls">
                    <span class="material-symbols-outlined sq-icon">graphic_eq</span>
                    <input type="range" id="sqRange" min="0" max="60" value="10" oninput="ui.updateSq(this.value)" onchange="ws.sendSq(this.value)">
                </div>
            </div>
        </div>

        <div class="control-grid">
            <button class="btn btn-tune" onclick="ui.modal('tune')">
                <span class="material-symbols-outlined">dialpad</span> TUNE FREQUENCY
            </button>
            <button class="btn active" id="btnAM" onclick="ws.setMode('AM')">AM</button>
            <button class="btn" id="btnFM" onclick="ws.setMode('FM')">FM</button>
            <button class="btn active" id="attOff" onclick="ws.setAtt('off')">NO ATT</button>
            <button class="btn" id="attWeak" onclick="ws.setAtt('weak')">WEAK</button>
            <button class="btn btn-rec" id="recBtn" onclick="ws.toggleRec()">
                <span class="material-symbols-outlined">fiber_manual_record</span> REC
            </button>
        </div>

        <div class="section-title">
            Channels
            <button class="icon-btn" onclick="ws.addBookmark()">
                <span class="material-symbols-outlined">add</span>
            </button>
        </div>
        <div class="glass-panel" id="bmList"></div>

        <div class="section-title">Recorded Files</div>
        <div class="glass-panel" id="recList"></div>
    </div>

    <div class="modal-overlay" id="modalOverlay">
        <div class="modal-card">
            <div class="modal-title" id="modalTitle">Set Frequency</div>
            
            <div class="input-group" id="freqInputGroup">
                <input type="number" inputmode="decimal" class="modern-input" id="tuneInput" placeholder="128.800" step="0.001">
            </div>
            
            <div class="input-group">
                <input type="password" inputmode="numeric" class="modern-input" id="authInput" placeholder="Admin Password">
            </div>

            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="ui.closeModal()">CANCEL</button>
                <button class="btn btn-primary" onclick="ws.tune()">EXECUTE</button>
            </div>
        </div>
    </div>

<script>
    // System Logic
    let audioCtx;
    let wsConn;
    let nextTime = 0;
    const SAMPLE_RATE = 24000;
    
    // State
    const state = { freq: 0, mode: 'AM', att: 'off', isRec: false };

    // UI Controller
    const ui = {
        els: {
            freq: document.getElementById('freqVal'),
            rssi: document.getElementById('rssiBar'),
            sqMarker: document.getElementById('sqMarker'),
            modal: document.getElementById('modalOverlay'),
            bmList: document.getElementById('bmList'),
            recList: document.getElementById('recList')
        },
        updateStatus(msg) {
            state.freq = msg.freq;
            state.mode = msg.mode;
            state.att = msg.att;
            state.isRec = msg.isRecording;

            this.els.freq.innerText = (msg.freq / 1e6).toFixed(3);
            
            // Badges
            document.getElementById('modeBadge').innerText = msg.mode;
            const attBadge = document.getElementById('attBadge');
            if (msg.att !== 'off') {
                attBadge.style.display = 'inline-block';
                attBadge.innerText = 'ATT ' + msg.att.toUpperCase();
                attBadge.classList.add('active');
            } else {
                attBadge.style.display = 'none';
            }
            document.getElementById('recBadge').style.display = msg.isRecording ? 'inline-block' : 'none';

            // Buttons
            document.getElementById('btnAM').className = 'btn ' + (msg.mode==='AM'?'active':'');
            document.getElementById('btnFM').className = 'btn ' + (msg.mode==='FM'?'active':'');
            document.getElementById('recBtn').className = 'btn btn-rec ' + (msg.isRecording?'recording':'');
            
            // Squelch
            document.getElementById('sqRange').value = msg.squelch;
            this.updateSq(msg.squelch);
        },
        updateSq(val) { this.els.sqMarker.style.left = ((val/60)*100) + '%'; },
        modal(type) {
            this.els.modal.style.display = 'flex';
            if(type === 'tune') {
                document.getElementById('tuneInput').value = (state.freq / 1e6).toFixed(3);
                document.getElementById('tuneInput').focus();
            }
        },
        closeModal() { this.els.modal.style.display = 'none'; document.getElementById('authInput').value=''; },
        renderBM(list) {
            this.els.bmList.innerHTML = list.map(b => \`
                <div class="list-item" onclick="ws.tuneDirect(\${b.freq}, '\${b.mode}')">
                    <div class="item-main">
                        <div class="item-title">\${b.title}</div>
                        <div class="item-sub">\${(b.freq/1e6).toFixed(3)} MHz \${b.mode}</div>
                    </div>
                    <button class="icon-btn" onclick="event.stopPropagation(); ws.delBm('\${b.id}')">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </div>
            \`).join('');
        },
        renderRec(list) {
            this.els.recList.innerHTML = list.map(f => \`
                <div class="list-item">
                    <div class="item-main">
                        <div class="item-title">\${f.name.split('_')[2] || f.name}</div>
                        <div class="item-sub">\${(f.size/1024/1024).toFixed(2)} MB</div>
                    </div>
                    <div>
                        <a href="/download/\${f.name}" class="icon-btn" download style="text-decoration:none; color:var(--text-sub)">
                            <span class="material-symbols-outlined">download</span>
                        </a>
                        <button class="icon-btn" onclick="ws.delRec('\${f.name}')">
                            <span class="material-symbols-outlined">delete</span>
                        </button>
                    </div>
                </div>
            \`).join('');
        }
    };

    // WebSocket Controller
    const ws = {
        send(obj) { if(wsConn && wsConn.readyState===1) wsConn.send(JSON.stringify(obj)); },
        sendSq(val) { this.send({type:'set_squelch', val: parseInt(val)}); },
        setMode(m) { state.mode = m; this.tune(true); }, // Just update mode flag for next tune or force tune? Better force tune with current freq
        setAtt(a) { this.send({type:'set_att', att: a}); },
        toggleRec() { this.send({type: state.isRec ? 'stop_recording' : 'start_recording'}); },
        tune(skipInput = false) {
            const pass = document.getElementById('authInput').value;
            let freq = state.freq;
            if (!skipInput) {
                const val = parseFloat(document.getElementById('tuneInput').value);
                if(val) freq = Math.floor(val * 1e6);
            }
            this.send({ type:'auth_tune', password: pass, freq: freq, mode: state.mode });
            ui.closeModal();
        },
        tuneDirect(freq, mode) {
            state.mode = mode;
            document.getElementById('tuneInput').value = freq/1e6;
            ui.modal('tune');
        },
        addBookmark() {
            const t = prompt("Channel Name");
            if(t) this.send({type:'add_bookmark', data:{title:t, freq:state.freq, mode:state.mode}});
        },
        delBm(id) { if(confirm('Delete?')) this.send({type:'delete_bookmark', id}); },
        delRec(fn) { if(confirm('Delete?')) this.send({type:'delete_recording', filename:fn}); }
    };

    function initApp() {
        // Audio Init
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
        if(audioCtx.state === 'suspended') audioCtx.resume();
        
        // Silent Oscillator for Mobile Wake Lock
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.frequency.value=10; gain.gain.value=0.001; osc.start();

        // UI Transition
        document.getElementById('startOverlay').style.opacity = '0';
        setTimeout(() => document.getElementById('startOverlay').style.display = 'none', 300);

        // Connect
        connect();
    }

    function connect() {
        wsConn = new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);
        wsConn.binaryType = 'arraybuffer';
        wsConn.onmessage = e => {
            if(typeof e.data === 'string') {
                const msg = JSON.parse(e.data);
                if(msg.type==='status_update') ui.updateStatus(msg);
                else if(msg.type==='bookmarks') ui.renderBM(msg.data);
                else if(msg.type==='recordings') ui.renderRec(msg.data);
                else if(msg.type==='error') alert(msg.msg);
            } else {
                playAudio(e.data);
            }
        };
        wsConn.onclose = () => setTimeout(connect, 3000);
    }

    function playAudio(buf) {
        if(!audioCtx) return;
        const view = new Int16Array(buf);
        const rssi = view[0];
        const audio = new Float32Array(view.length-1);
        for(let i=0; i<audio.length; i++) audio[i] = view[i+1]/32768.0;

        // Visual
        const pct = (rssi/200)*100; // rough scale
        ui.els.rssi.style.width = Math.min(100, pct) + '%';
        ui.els.rssi.style.boxShadow = \`0 0 \${pct/5}px var(--accent-color)\`;

        const b = audioCtx.createBuffer(1, audio.length, SAMPLE_RATE);
        b.getChannelData(0).set(audio);
        const s = audioCtx.createBufferSource();
        s.buffer = b; s.connect(audioCtx.destination);
        
        const now = audioCtx.currentTime;
        if(nextTime < now) nextTime = now + 0.04;
        s.start(nextTime);
        nextTime += b.duration;
    }
</script>
</body>
</html>
`;