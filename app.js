/**
 * Hybrid Web SDR - Full Features
 * Core: rtl_fm (Demodulation) -> Node.js (Audio FX, Squelch, Streaming, UI)
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto'); // For future extensions

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
    webPort: 3000,
    password: "admin", // チューニング用パスワード
    
    // SDR設定
    initialFreq: 128800000,
    initialMode: 'AM',
    sampleRate: 24000, // 24kHz (rtl_fmの出力レート)
    ppm: 0,
    
    // パス設定
    recordingsPath: path.join(__dirname, 'recordings'),
    bookmarksFile: path.join(__dirname, 'bookmarks.json'),
    squelchFile: path.join(__dirname, 'squelch_data.json'),
};

// ディレクトリ作成
if (!fs.existsSync(CONFIG.recordingsPath)) fs.mkdirSync(CONFIG.recordingsPath);

// ==========================================
// データ管理 (ブックマーク & スケルチ)
// ==========================================
let bookmarks = [];
let squelchDB = {}; // 周波数ごとのノイズフロア保存用

function loadData() {
    try {
        if (fs.existsSync(CONFIG.bookmarksFile)) bookmarks = JSON.parse(fs.readFileSync(CONFIG.bookmarksFile));
        if (fs.existsSync(CONFIG.squelchFile)) squelchDB = JSON.parse(fs.readFileSync(CONFIG.squelchFile));
        console.log(`[System] Loaded ${bookmarks.length} bookmarks.`);
    } catch (e) { console.error('[System] Load Error:', e); }
}

function saveData() {
    fs.writeFile(CONFIG.bookmarksFile, JSON.stringify(bookmarks, null, 2), () => {});
    fs.writeFile(CONFIG.squelchFile, JSON.stringify(squelchDB, null, 2), () => {});
}

loadData();

// ==========================================
// DSP & Audio Processing (Node.js)
// ==========================================
class AudioDSP {
    constructor() {
        this.reset();
    }

    reset() {
        this.lastIn = 0;
        this.lastOut = 0;
        this.agcPeak = 0;
        this.agcGain = 1.0;
        this.squelchGate = 0.0; // 0.0 = Muted, 1.0 = Open
        this.rms = 0; // 現在の音量（Signal Meter用）
    }

    // 16bit PCM Bufferを受け取り、加工して返す
    process(inputBuffer, opts) {
        const inputLen = inputBuffer.length / 2; // Int16 samples
        const outputBuffer = Buffer.alloc(inputLen * 2);
        
        const squelchThresh = opts.squelchThreshold / 100.0; // 0.0 - 1.0
        let sumSq = 0;

        for (let i = 0; i < inputLen; i++) {
            // Int16 -> Float (-1.0 ~ 1.0)
            let sample = inputBuffer.readInt16LE(i * 2) / 32768.0;

            // 1. DC除去 (HPF) - 低周波ノイズカット
            let rawSample = sample;
            sample = rawSample - 0.95 * this.lastIn + 0.95 * this.lastOut;
            this.lastIn = rawSample;
            this.lastOut = sample;

            // 2. 音量測定 (RMS計算用)
            sumSq += sample * sample;

            // 3. 簡易AGC (コンプレッサー)
            // 航空無線: 管制塔(小)と航空機(大)の差を埋める
            const absSample = Math.abs(sample);
            this.agcPeak = this.agcPeak * 0.999 + absSample * 0.001;
            
            let targetGain = 0.6 / (this.agcPeak + 0.05);
            if (targetGain > 15.0) targetGain = 15.0; // 無音時の過剰増幅防止
            if (targetGain < 1.0) targetGain = 1.0;

            this.agcGain = this.agcGain * 0.99 + targetGain * 0.01;
            
            // AGC適用
            let processed = sample * this.agcGain;

            // 4. ノイズゲート (ソフトウェアスケルチ)
            // AGC前の生レベルで判定するのが理想だが、AGC後の方が聴感に近い場合もある
            // ここでは「ノイズフロア」と比較するため、平滑化されたRMSを使う
            // 処理は後述のブロックで行い、ここでは現在のGate状態を適用
            processed *= this.squelchGate;

            // 5. リミッター
            if (processed > 0.98) processed = 0.98;
            if (processed < -0.98) processed = -0.98;

            outputBuffer.writeInt16LE(Math.floor(processed * 32767), i * 2);
        }

        // ブロックごとのRMS計算とスケルチ判定
        const blockRms = Math.sqrt(sumSq / inputLen);
        this.rms = this.rms * 0.8 + blockRms * 0.2; // 表示用の平滑化

        // ヒステリシス付きスケルチロジック
        const openThresh = Math.max(0.005, squelchThresh); // 最低限のフロア
        const closeThresh = openThresh * 0.8;

        if (this.rms > openThresh) {
            // Attack (Open Fast)
            this.squelchGate = 0.9 * this.squelchGate + 0.1 * 1.0;
        } else if (this.rms < closeThresh) {
            // Release (Close Slow)
            this.squelchGate = 0.95 * this.squelchGate; // Fade out
            if (this.squelchGate < 0.01) this.squelchGate = 0;
        }

        // 表示用RSSI (0-100)
        const displayRssi = Math.min(100, Math.floor(Math.sqrt(this.rms) * 200)); 

        return { buffer: outputBuffer, rssi: displayRssi, isOpen: this.squelchGate > 0.1 };
    }
}

const dsp = new AudioDSP();

// ==========================================
// RTL-SDR 管理 (child_process)
// ==========================================
let rtlProcess = null;
let currentFreq = CONFIG.initialFreq;
let currentMode = CONFIG.initialMode;
let currentAtt = 'off'; // off, weak, strong
let isTuning = false;

// 録音管理
let isRecording = false;
let recordingStream = null;
let recordingFilename = "";

function startRadio(freq, mode, att) {
    if (rtlProcess) {
        rtlProcess.kill(); // 前のプロセスを終了
        rtlProcess = null;
    }

    currentFreq = freq;
    currentMode = mode;
    currentAtt = att;
    isTuning = true;
    dsp.reset(); // DSP状態リセット

    // ATT設定からゲイン値を決定
    let gainVal = '40'; // Default (High Sensitivity)
    if (att === 'weak') gainVal = '20'; // ATT Weak
    if (att === 'strong') gainVal = '0'; // ATT Strong

    // rtl_fm 引数構築
    const args = [
        '-M', mode === 'FM' ? 'fm' : 'am', // am / fm
        '-f', freq.toString(),
        '-s', CONFIG.sampleRate.toString(),
        '-g', gainVal,
        '-p', CONFIG.ppm.toString(),
        // 以下の設定でrtl_fm内蔵のフィルタ品質を上げる
        '-F', '9', 
    ];

    console.log(`[Radio] Start: ${freq}Hz ${mode} Gain:${gainVal}`);

    rtlProcess = spawn('rtl_fm', args);

    rtlProcess.stdout.on('data', (chunk) => {
        // 音声処理 & 配信
        handleAudioStream(chunk);
    });

    rtlProcess.on('close', (code) => {
        console.log(`[Radio] Stopped (Code: ${code})`);
    });

    // チューニング完了通知（少し待ってから）
    setTimeout(() => {
        isTuning = false;
        broadcastStatus();
    }, 500);
}

// ==========================================
// ストリーミング & 録音ロジック
// ==========================================
let squelchThreshold = 10; // 0-100 (Arbitrary)

function handleAudioStream(rawChunk) {
    // DSP処理
    const result = dsp.process(rawChunk, { squelchThreshold });
    
    // WebSocket配信
    const header = new Int16Array(1);
    header[0] = result.rssi; // 最初の2バイトにRSSIを埋め込む
    
    // RSSIヘッダ + 音声データ
    const sendBuffer = Buffer.concat([Buffer.from(header.buffer), result.buffer]);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(sendBuffer);
        }
    });

    // 録音 (WAV書き込み)
    if (isRecording && recordingStream && result.isOpen) {
        // スケルチが開いている時のみ書き込む（容量節約）
        recordingStream.write(result.buffer);
    }
}

// WAVヘッダ書き込みヘルパー
function writeWavHeader(stream, sampleRate, dataLength) {
    const buffer = Buffer.alloc(44);
    // RIFF identifier
    buffer.write('RIFF', 0);
    // file length (data + 36)
    buffer.writeUInt32LE(36 + dataLength, 4);
    // RIFF type
    buffer.write('WAVE', 8);
    // format chunk identifier
    buffer.write('fmt ', 12);
    // format chunk length
    buffer.writeUInt32LE(16, 16);
    // sample format (1 is PCM)
    buffer.writeUInt16LE(1, 20);
    // channels (1)
    buffer.writeUInt16LE(1, 22);
    // sample rate
    buffer.writeUInt32LE(sampleRate, 24);
    // byte rate (sampleRate * blockAlign)
    buffer.writeUInt32LE(sampleRate * 2, 28);
    // block align (channels * bytes per sample)
    buffer.writeUInt16LE(2, 32);
    // bits per sample
    buffer.writeUInt16LE(16, 34);
    // data chunk identifier
    buffer.write('data', 36);
    // data chunk length
    buffer.writeUInt32LE(dataLength, 40);
    
    stream.write(buffer);
}

function startRec() {
    if (isRecording) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    recordingFilename = `${currentMode}_${(currentFreq/1e6).toFixed(3)}MHz_${timestamp}.wav`;
    const filePath = path.join(CONFIG.recordingsPath, recordingFilename);
    
    console.log(`[Rec] Start: ${recordingFilename}`);
    
    // WAVストリーム作成 (ヘッダは後で書き直すため、まずはプレースホルダ)
    recordingStream = fs.createWriteStream(filePath);
    writeWavHeader(recordingStream, CONFIG.sampleRate, 0); // 仮ヘッダ
    
    isRecording = true;
    broadcastStatus();
}

function stopRec() {
    if (!isRecording) return;
    isRecording = false;
    
    if (recordingStream) {
        const filePath = recordingStream.path;
        const bytesWritten = recordingStream.bytesWritten - 44; // ヘッダ分引く
        recordingStream.end();
        
        // ヘッダを正しいサイズで書き直す
        // fdを開いて先頭を書き換える
        setTimeout(() => {
            fs.open(filePath, 'r+', (err, fd) => {
                if (!err) {
                    const headerBuf = Buffer.alloc(44);
                    // create temp stream to generate header buffer logic reused
                    // ...簡易実装: 手動で構築
                    const buf = Buffer.alloc(44);
                    buf.write('RIFF', 0);
                    buf.writeUInt32LE(36 + bytesWritten, 4);
                    buf.write('WAVE', 8);
                    buf.write('fmt ', 12);
                    buf.writeUInt32LE(16, 16);
                    buf.writeUInt16LE(1, 20);
                    buf.writeUInt16LE(1, 22);
                    buf.writeUInt32LE(CONFIG.sampleRate, 24);
                    buf.writeUInt32LE(CONFIG.sampleRate * 2, 28);
                    buf.writeUInt16LE(2, 32);
                    buf.writeUInt16LE(16, 34);
                    buf.write('data', 36);
                    buf.writeUInt32LE(bytesWritten, 40);
                    fs.write(fd, buf, 0, 44, 0, () => fs.close(fd, ()=>{}));
                }
            });
        }, 100);
        
        console.log(`[Rec] Stop: ${bytesWritten} bytes audio`);
        recordingStream = null;
    }
    broadcastStatus();
    broadcastRecordings();
}

// ==========================================
// Web Server & WebSocket Commands
// ==========================================
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlContent); // HTMLは最下部に定義
    } else if (url.pathname.startsWith('/download/')) {
        const fname = path.basename(decodeURIComponent(url.pathname));
        const fpath = path.join(CONFIG.recordingsPath, fname);
        if (fs.existsSync(fpath)) {
            res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Disposition': `attachment; filename="${fname}"`
            });
            fs.createReadStream(fpath).pipe(res);
        } else {
            res.writeHead(404); res.end('Not Found');
        }
    } else {
        res.writeHead(404); res.end();
    }
});

const wss = new WebSocket.Server({ server });

function broadcastStatus() {
    const status = {
        type: 'status_update',
        freq: currentFreq,
        mode: currentMode,
        att: currentAtt,
        isRecording: isRecording,
        squelch: squelchThreshold
    };
    wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(JSON.stringify(status)); });
}

function broadcastRecordings() {
    try {
        const files = fs.readdirSync(CONFIG.recordingsPath)
            .filter(f => f.endsWith('.wav'))
            .map(f => {
                const stat = fs.statSync(path.join(CONFIG.recordingsPath, f));
                return { name: f, size: stat.size, date: stat.mtime };
            })
            .sort((a,b) => b.date - a.date);
        
        const msg = JSON.stringify({ type: 'recordings', data: files });
        wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(msg); });
    } catch(e) {}
}

wss.on('connection', (ws) => {
    broadcastStatus();
    ws.send(JSON.stringify({ type: 'bookmarks', data: bookmarks }));
    broadcastRecordings();

    ws.on('message', (msg) => {
        try {
            const cmd = JSON.parse(msg);
            
            if (cmd.type === 'auth_tune') {
                if (cmd.password === CONFIG.password) {
                    startRadio(cmd.freq, cmd.mode, currentAtt);
                } else {
                    ws.send(JSON.stringify({ type: 'error', msg: 'Incorrect Password' }));
                }
            }
            else if (cmd.type === 'set_att') {
                startRadio(currentFreq, currentMode, cmd.att); // ATT変更は再起動が必要
            }
            else if (cmd.type === 'set_squelch') {
                squelchThreshold = cmd.val;
                // 保存
                squelchDB[currentFreq] = squelchThreshold;
                saveData();
                broadcastStatus();
            }
            else if (cmd.type === 'start_recording') startRec();
            else if (cmd.type === 'stop_recording') stopRec();
            else if (cmd.type === 'delete_recording') {
                const fpath = path.join(CONFIG.recordingsPath, cmd.filename);
                if(fs.existsSync(fpath)) fs.unlinkSync(fpath);
                broadcastRecordings();
            }
            else if (cmd.type === 'add_bookmark') {
                cmd.data.id = Date.now().toString();
                bookmarks.push(cmd.data);
                saveData();
                ws.send(JSON.stringify({ type: 'bookmarks', data: bookmarks }));
            }
            else if (cmd.type === 'delete_bookmark') {
                bookmarks = bookmarks.filter(b => b.id !== cmd.id);
                saveData();
                ws.send(JSON.stringify({ type: 'bookmarks', data: bookmarks }));
            }
        } catch(e) { console.error(e); }
    });
});

// サーバー起動
server.listen(CONFIG.webPort, () => {
    console.log(`[Server] Running on http://localhost:${CONFIG.webPort}`);
    startRadio(CONFIG.initialFreq, CONFIG.initialMode, 'off');
});

// ==========================================
// フロントエンド (HTML/CSS/JS)
// ==========================================
const htmlContent = `
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>SDR Monitor Pro</title>
<meta name="theme-color" content="#000000">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📡</text></svg>">
<style>
    :root { --primary: #00e676; --bg: #000; --panel: #1a1a1a; --text: #e0e0e0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 10px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; overscroll-behavior-y: none; }
    .container { width: 100%; max-width: 420px; padding-bottom: 60px; }
    
    /* Main Display */
    .freq-card { background: linear-gradient(145deg, #151515, #222); padding: 20px; border-radius: 20px; box-shadow: 0 8px 30px rgba(0,0,0,0.6); border: 1px solid #333; text-align: center; margin-bottom: 20px; position: relative; }
    .freq-val { font-size: 3.2rem; font-weight: 800; color: #fff; text-shadow: 0 0 15px rgba(0, 230, 118, 0.4); font-feature-settings: "tnum"; line-height: 1; }
    .unit { font-size: 1rem; color: #888; margin-top: 5px; }
    .mode-badge { position: absolute; top: 20px; right: 20px; background: #333; padding: 4px 10px; border-radius: 8px; font-weight: bold; font-size: 0.8rem; color: var(--primary); }
    .att-badge { position: absolute; top: 20px; left: 20px; background: #333; padding: 4px 10px; border-radius: 8px; font-weight: bold; font-size: 0.8rem; color: #ff9800; display: none; }

    /* Signal Meter */
    .meter-box { margin-top: 20px; background: #000; padding: 10px; border-radius: 10px; }
    .meter-bar-bg { height: 10px; background: #222; border-radius: 5px; overflow: hidden; position: relative; }
    .meter-bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2196f3, #00e676, #ff1744); transition: width 0.05s linear; }
    .meter-threshold { position: absolute; top:0; bottom:0; width: 2px; background: #ffeb3b; z-index: 10; transition: left 0.1s; }
    .meter-labels { display: flex; justify-content: space-between; font-size: 0.7rem; color: #666; margin-top: 4px; }

    /* Controls */
    .ctrl-group { background: var(--panel); padding: 15px; border-radius: 15px; margin-bottom: 15px; }
    .slider-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
    input[type=range] { flex: 1; height: 30px; }
    
    .btn-row { display: flex; gap: 10px; margin-bottom: 10px; }
    .btn { flex: 1; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; color: #fff; background: #333; transition: 0.2s; }
    .btn:active { transform: scale(0.98); }
    .btn.active { background: var(--primary); color: #000; }
    .btn-rec { background: #d32f2f; }
    .btn-rec.recording { background: #ff1744; animation: pulse 1.5s infinite; }
    
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.6; } 100% { opacity: 1; } }

    /* Frequency Input */
    .input-row { display: flex; gap: 10px; }
    input[type="number"] { flex: 1; background: #222; border: 1px solid #444; color: #fff; padding: 12px; border-radius: 8px; font-size: 1.1rem; text-align: center; }
    .btn-tune { background: #00897b; }

    /* Start Button */
    #startBtn { width: 100%; padding: 20px; font-size: 1.2rem; font-weight: bold; border-radius: 50px; background: var(--primary); color: #000; border: none; box-shadow: 0 4px 20px rgba(0, 230, 118, 0.4); margin-bottom: 20px; cursor: pointer; }
    #startBtn.hidden { display: none; }

    /* Lists (Bookmarks/Recordings) */
    .list-header { display: flex; justify-content: space-between; align-items: center; margin: 15px 0 5px; color: #888; font-size: 0.9rem; font-weight: bold; }
    .list-item { background: var(--panel); border-bottom: 1px solid #333; padding: 12px; display: flex; justify-content: space-between; align-items: center; }
    .list-item:first-child { border-top-left-radius: 10px; border-top-right-radius: 10px; }
    .list-item:last-child { border-bottom-left-radius: 10px; border-bottom-right-radius: 10px; border-bottom: none; }
    .item-info div:first-child { font-weight: bold; color: #fff; }
    .item-info div:last-child { font-size: 0.8rem; color: #888; }
    .item-actions button { padding: 5px 10px; border-radius: 4px; border: none; margin-left: 5px; cursor: pointer; font-size: 0.8rem; }
    .act-del { background: #b71c1c; color: #fff; }
    .act-dl { background: #00897b; color: #fff; text-decoration: none; padding: 5px 10px; border-radius: 4px; font-size: 0.8rem; margin-left: 5px; }

    /* Modal */
    .modal-overlay { position: fixed; top:0; left:0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(5px); z-index: 1000; display: none; justify-content: center; align-items: center; }
    .modal { background: #1e1e1e; padding: 25px; border-radius: 15px; width: 85%; max-width: 300px; text-align: center; border: 1px solid #333; }
    .modal h3 { margin-top: 0; color: #fff; }
    .modal input { width: 100%; margin-bottom: 15px; box-sizing: border-box; }
</style>
</head>
<body>
    <div class="container">
        <div style="font-size:0.8rem; color:#666; margin-bottom:10px; text-align:center;" id="statusText">Disconnected</div>

        <button id="startBtn" onclick="startAudio()">START MONITOR</button>

        <div class="freq-card">
            <span class="mode-badge" id="modeLabel">AM</span>
            <span class="att-badge" id="attBadge">ATT</span>
            <div class="freq-val" id="freqLabel">---.---</div>
            <div class="unit">MHz</div>
            
            <div class="meter-box">
                <div class="meter-labels"><span>SQL</span><span id="sqVal">10</span></div>
                <div class="meter-bar-bg">
                    <div class="meter-bar-fill" id="rssiBar"></div>
                    <div class="meter-threshold" id="sqMarker" style="left: 10%"></div>
                </div>
            </div>
            
            <div class="slider-row">
                <span style="font-size:0.8rem; color:#888;">OPEN</span>
                <input type="range" id="sqRange" min="0" max="60" value="10" oninput="updateSq(this.value)" onchange="sendSq(this.value)">
                <span style="font-size:0.8rem; color:#888;">TIGHT</span>
            </div>
        </div>

        <div class="ctrl-group">
            <div class="btn-row">
                <button class="btn active" id="btnAM" onclick="setMode('AM')">AM</button>
                <button class="btn" id="btnFM" onclick="setMode('FM')">FM</button>
            </div>
            <div class="btn-row">
                <button class="btn active" id="attOff" onclick="setAtt('off')">NO ATT</button>
                <button class="btn" id="attWeak" onclick="setAtt('weak')">WEAK</button>
                <button class="btn" id="attStrong" onclick="setAtt('strong')">STRONG</button>
            </div>
            <div class="input-row">
                <input type="number" id="tuneFreq" placeholder="Freq (MHz)" step="0.001">
                <button class="btn btn-tune" onclick="openAuthModal()">TUNE</button>
            </div>
        </div>

        <div class="list-header">
            <span>BOOKMARKS</span>
            <button class="btn" style="padding:4px 10px; font-size:0.8rem;" onclick="addBookmark()">+ ADD</button>
        </div>
        <div id="bmList"></div>

        <div class="list-header">
            <span>RECORDINGS</span>
            <button class="btn btn-rec" id="recBtn" style="padding:4px 10px; font-size:0.8rem;" onclick="toggleRec()">REC</button>
        </div>
        <div id="recList"></div>
    </div>

    <div class="modal-overlay" id="authModal">
        <div class="modal">
            <h3>Enter Password</h3>
            <input type="password" id="authPass" placeholder="Password">
            <div class="btn-row">
                <button class="btn" onclick="closeAuthModal()">Cancel</button>
                <button class="btn active" onclick="doTune()">Tune</button>
            </div>
        </div>
    </div>

<script>
    let ws;
    let audioCtx;
    let nextTime = 0;
    const SAMPLE_RATE = 24000;
    
    // UI Elements
    const els = {
        freq: document.getElementById('freqLabel'),
        mode: document.getElementById('modeLabel'),
        attBadge: document.getElementById('attBadge'),
        status: document.getElementById('statusText'),
        rssiBar: document.getElementById('rssiBar'),
        sqMarker: document.getElementById('sqMarker'),
        recBtn: document.getElementById('recBtn'),
        bmList: document.getElementById('bmList'),
        recList: document.getElementById('recList'),
        tuneFreq: document.getElementById('tuneFreq'),
        startBtn: document.getElementById('startBtn')
    };

    let state = { freq: 0, mode: 'AM', att: 'off', isRec: false };

    function startAudio() {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
        // Android/iOS: Resume context on user gesture
        if (audioCtx.state === 'suspended') audioCtx.resume();
        
        // Keep-alive oscillator for mobile background playback
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.frequency.value = 20; 
        gainNode.gain.value = 0.001; // Inaudible
        oscillator.start();

        els.startBtn.classList.add('hidden');
        connectWs();
    }

    function connectWs() {
        ws = new WebSocket((location.protocol==='https:'?'wss:':'ws:') + '//' + location.host);
        ws.binaryType = 'arraybuffer';
        
        ws.onopen = () => els.status.innerText = "Connected";
        ws.onclose = () => {
            els.status.innerText = "Disconnected... Reconnecting";
            setTimeout(connectWs, 3000);
        };
        
        ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                handleJson(JSON.parse(e.data));
            } else {
                handleAudio(e.data);
            }
        };
    }

    function handleJson(msg) {
        if (msg.type === 'status_update') {
            state.freq = msg.freq;
            state.mode = msg.mode;
            state.att = msg.att;
            state.isRec = msg.isRecording;

            els.freq.innerText = (msg.freq / 1000000).toFixed(3);
            els.mode.innerText = msg.mode;
            
            // UI Sync
            document.getElementById('sqRange').value = msg.squelch;
            updateSq(msg.squelch);

            // Mode Buttons
            document.getElementById('btnAM').className = 'btn ' + (msg.mode==='AM'?'active':'');
            document.getElementById('btnFM').className = 'btn ' + (msg.mode==='FM'?'active':'');

            // ATT Buttons
            ['off','weak','strong'].forEach(t => {
                document.getElementById('att'+(t.charAt(0).toUpperCase()+t.slice(1))).className = 'btn ' + (msg.att===t?'active':'');
            });
            els.attBadge.style.display = (msg.att !== 'off') ? 'block' : 'none';
            els.attBadge.innerText = 'ATT ' + msg.att.toUpperCase();

            // Rec Button
            els.recBtn.className = 'btn btn-rec ' + (msg.isRecording ? 'recording' : '');
            els.recBtn.innerText = msg.isRecording ? 'STOP REC' : 'REC';

        } else if (msg.type === 'bookmarks') {
            renderBookmarks(msg.data);
        } else if (msg.type === 'recordings') {
            renderRecordings(msg.data);
        } else if (msg.type === 'error') {
            alert(msg.msg);
        }
    }

    function handleAudio(buffer) {
        if (!audioCtx) return;

        // Parse Header (First 2 bytes = Int16 RSSI)
        const view = new Int16Array(buffer);
        const rssi = view[0];
        const pcmData = view.subarray(1); // The rest is audio

        // Update Meter
        els.rssiBar.style.width = rssi + '%';

        // Play Audio
        const float32 = new Float32Array(pcmData.length);
        for(let i=0; i<pcmData.length; i++) float32[i] = pcmData[i] / 32768.0;

        const audioBuf = audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
        audioBuf.getChannelData(0).set(float32);
        
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(audioCtx.destination);
        
        const now = audioCtx.currentTime;
        // Jitter buffer logic
        if (nextTime < now) nextTime = now + 0.05;
        src.start(nextTime);
        nextTime += audioBuf.duration;
    }

    // Commands
    function updateSq(val) {
        document.getElementById('sqVal').innerText = val;
        els.sqMarker.style.left = val + '%';
    }
    function sendSq(val) {
        ws.send(JSON.stringify({ type: 'set_squelch', val: parseInt(val) }));
    }
    function setMode(m) { state.mode = m; } // Wait for tune to apply
    function setAtt(a) { 
        ws.send(JSON.stringify({ type: 'set_att', att: a }));
    }
    function toggleRec() {
        ws.send(JSON.stringify({ type: state.isRec ? 'stop_recording' : 'start_recording' }));
    }

    // Tuning Flow
    function openAuthModal() { document.getElementById('authModal').style.display = 'flex'; }
    function closeAuthModal() { document.getElementById('authModal').style.display = 'none'; }
    function doTune() {
        const pass = document.getElementById('authPass').value;
        let freq = parseFloat(els.tuneFreq.value);
        if(!freq) freq = state.freq / 1000000;
        
        ws.send(JSON.stringify({
            type: 'auth_tune',
            password: pass,
            freq: Math.floor(freq * 1000000),
            mode: state.mode
        }));
        closeAuthModal();
        document.getElementById('authPass').value = '';
    }

    // Lists
    function renderBookmarks(list) {
        els.bmList.innerHTML = list.map(b => \`
            <div class="list-item" onclick="tuneTo(\${b.freq}, '\${b.mode}')">
                <div class="item-info">
                    <div>\${b.title}</div>
                    <div>\${(b.freq/1e6).toFixed(3)} MHz \${b.mode}</div>
                </div>
                <div class="item-actions">
                    <button class="act-del" onclick="event.stopPropagation(); delBm('\${b.id}')">DEL</button>
                </div>
            </div>
        \`).join('');
    }

    function addBookmark() {
        const title = prompt("Station Name:");
        if(!title) return;
        ws.send(JSON.stringify({
            type: 'add_bookmark',
            data: { title, freq: state.freq, mode: state.mode }
        }));
    }

    function delBm(id) {
        if(confirm("Delete?")) ws.send(JSON.stringify({ type: 'delete_bookmark', id }));
    }

    function tuneTo(freq, mode) {
        els.tuneFreq.value = freq / 1000000;
        state.mode = mode;
        openAuthModal();
    }

    function renderRecordings(list) {
        els.recList.innerHTML = list.map(f => \`
            <div class="list-item">
                <div class="item-info">
                    <div>\${f.name}</div>
                    <div>\${(f.size/1024/1024).toFixed(2)} MB</div>
                </div>
                <div class="item-actions">
                    <a href="/download/\${f.name}" class="act-dl" download>DL</a>
                    <button class="act-del" onclick="delRec('\${f.name}')">DEL</button>
                </div>
            </div>
        \`).join('');
    }

    function delRec(fname) {
        if(confirm("Delete File?")) ws.send(JSON.stringify({ type: 'delete_recording', filename: fname }));
    }

</script>
</body>
</html>
`;