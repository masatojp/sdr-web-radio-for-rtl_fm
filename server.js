const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram'); // Not used, but standard for net
const WebSocket = require('ws');
const express = require('express');
require('dotenv').config();

// ==========================================
// 1. 設定 (Configuration)
// ==========================================
const PORT = process.env.PORT || 3000;
const INITIAL_FREQ = 126450000;
const INITIAL_MODE = "AM";
const SAMPLE_RATE = 48000;
const RECORDINGS_PATH = path.join(__dirname, 'recordings');
const BOOKMARKS_FILE = path.join(__dirname, 'bookmarks.json');
const SQUELCH_FILE = path.join(__dirname, 'squelch_data.json');

// Ensure directories exist
if (!fs.existsSync(RECORDINGS_PATH)) fs.mkdirSync(RECORDINGS_PATH, { recursive: true });

// ==========================================
// 2. データ構造 & グローバルステート
// ==========================================

const state = {
    freq: INITIAL_FREQ,
    mode: INITIAL_MODE,
    title: "",
    att: "off",
    squelch: 10,
    isRecording: false,
    lat: 0.0,
    lon: 0.0,
    address: "",
    gpsStatus: "init", // "disconnected", "searching", "active"
    gpsUnlocked: false,
    recFilename: null
};

let bookmarks = [];
let squelchDB = {};
let clients = new Set();
let recFileStream = null;
let currentRecPath = null;
let rtlProcess = null;

// DSP Instance
class AudioDSP {
    constructor() {
        this.reset();
    }

    reset() {
        this.lastIn = 0;
        this.lastOut = 0;
        this.agcPeak = 0;
        this.agcGain = 1.0;
        this.squelchGate = 0.0;
        this.rms = 0;
    }

    process(inputBuffer, threshold) {
        // Input is raw PCM 16-bit Little Endian
        const numSamples = inputBuffer.length / 2;
        const outBuffer = Buffer.allocUnsafe(inputBuffer.length);
        
        const sqThresh = threshold / 100.0;
        let sumSq = 0;

        for (let i = 0; i < numSamples; i++) {
            // Read Int16
            const rawInt = inputBuffer.readInt16LE(i * 2);
            let s = rawInt / 32768.0;

            // DC Offset Removal
            const raw = s;
            s = raw - 0.95 * this.lastIn + 0.95 * this.lastOut;
            this.lastIn = raw;
            this.lastOut = s;

            // AGC
            this.agcPeak = 0.999 * this.agcPeak + 0.001 * Math.abs(s);
            let g = 0.5 / (this.agcPeak + 0.01);
            if (g > 20.0) g = 20.0;
            if (g < 0.1) g = 0.1;
            this.agcGain = 0.995 * this.agcGain + 0.005 * g;

            let p = s * this.agcGain * this.squelchGate;

            // Soft Limiter
            if (p > 0.95 || p < -0.95) {
                if (p > 3) p = 1;
                else if (p < -3) p = -1;
                else p = p - (p * p * p) / 27;
            }
            if (p > 0.99) p = 0.99;
            if (p < -0.99) p = -0.99;

            // Write Output
            const outInt = Math.floor(p * 32767);
            outBuffer.writeInt16LE(outInt, i * 2);

            sumSq += s * s;
        }

        const rms = Math.sqrt(sumSq / numSamples);
        this.rms = 0.9 * this.rms + 0.1 * rms;

        const open = Math.max(0.002, sqThresh);
        const closeVal = open * 0.8;

        if (this.rms > open) {
            this.squelchGate = 1.0;
        } else if (this.rms < closeVal) {
            this.squelchGate = 0.0;
        }

        const rssi = Math.min(100, Math.floor(Math.sqrt(this.rms) * 500));

        return {
            buffer: outBuffer,
            rssi: rssi,
            isOpen: this.squelchGate === 1.0
        };
    }
}

const dsp = new AudioDSP();

// ==========================================
// 3. データ永続化 (Persistence)
// ==========================================

function loadData() {
    try {
        if (fs.existsSync(BOOKMARKS_FILE)) {
            bookmarks = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8'));
        } else {
            saveBookmarks();
        }
        if (fs.existsSync(SQUELCH_FILE)) {
            squelchDB = JSON.parse(fs.readFileSync(SQUELCH_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Error loading data:", e);
    }
}

function saveBookmarks() {
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2));
}

function saveSquelch() {
    fs.writeFileSync(SQUELCH_FILE, JSON.stringify(squelchDB, null, 2));
}

// ==========================================
// 4. Helper Functions
// ==========================================

function checkAuthHash(envKey, inputPass) {
    const targetHash = process.env[envKey];
    if (!targetHash) return false;
    const hash = crypto.createHash('sha256').update(inputPass).digest('hex');
    return hash === targetHash;
}

function reverseGeocode(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    const options = {
        headers: { 'User-Agent': 'SDR-Commander-Node/1.0' }
    };

    https.get(url, options, (res) => {
        if (res.statusCode !== 200) return;
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (json.display_name) {
                    state.address = json.display_name;
                    broadcastStatus();
                    console.log(`[GPS] Address: ${state.address}`);
                }
            } catch (e) {}
        });
    }).on('error', () => {});
}

// ==========================================
// 5. System Stats
// ==========================================

function getSystemStats() {
    let cpuTemp = 0;
    try {
        const t = fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", 'utf8');
        cpuTemp = parseFloat(t) / 1000.0;
    } catch (e) {}

    const mem = process.memoryUsage();
    // Simplified memory stats (OS level stats in Node require complex parsing of /proc/meminfo or external lib)
    // Here we replicate the Go behavior roughly by reading /proc/meminfo if on Linux
    let memTotal = 0, memUsed = 0;
    try {
        const memInfo = fs.readFileSync("/proc/meminfo", 'utf8');
        const totalMatch = memInfo.match(/MemTotal:\s+(\d+)/);
        const freeMatch = memInfo.match(/MemFree:\s+(\d+)/);
        const buffersMatch = memInfo.match(/Buffers:\s+(\d+)/);
        const cachedMatch = memInfo.match(/Cached:\s+(\d+)/);
        
        if (totalMatch) {
            memTotal = parseInt(totalMatch[1]) * 1024;
            const free = parseInt(freeMatch?.[1] || 0) * 1024;
            const buffers = parseInt(buffersMatch?.[1] || 0) * 1024;
            const cached = parseInt(cachedMatch?.[1] || 0) * 1024;
            memUsed = memTotal - (free + buffers + cached);
        }
    } catch(e) {}

    let diskTotal = 0, diskUsed = 0;
    try {
        const stats = fs.statfsSync(RECORDINGS_PATH);
        diskTotal = stats.bsize * stats.blocks;
        diskUsed = stats.bsize * (stats.blocks - stats.bfree);
    } catch (e) {} // statfsSync requires Node 19.6+, fallback for older nodes or non-linux handled gracefully by try/catch

    const uptime = process.uptime();
    const load = fs.existsSync("/proc/loadavg") ? fs.readFileSync("/proc/loadavg", "utf8").split(" ") : [0,0,0];

    return {
        cpuTemp,
        loadAvg1: parseFloat(load[0] || 0),
        loadAvg5: parseFloat(load[1] || 0),
        loadAvg15: parseFloat(load[2] || 0),
        memTotal,
        memUsed,
        diskTotal,
        diskUsed,
        uptime
    };
}

// ==========================================
// 6. SDR Manager
// ==========================================

function startSDR() {
    if (rtlProcess) {
        rtlProcess.kill();
        rtlProcess = null;
    }

    dsp.reset();

    let gainVal = "48";
    if (state.att === "weak") gainVal = "29";
    else if (state.att === "mid") gainVal = "9";
    else if (state.att === "strong") gainVal = "0";

    const ppm = "0";
    const args = ["-f", state.freq.toString(), "-g", gainVal, "-p", ppm, "-F", "9"];

    if (state.mode === "WFM") {
        args.push("-M", "wbfm", "-s", "240000", "-r", SAMPLE_RATE.toString());
    } else {
        let rtlMode = "am";
        if (state.mode === "FM") rtlMode = "fm";
        args.push("-M", rtlMode, "-s", SAMPLE_RATE.toString());
    }

    console.log(`[Radio] Starting: rtl_fm ${args.join(" ")}`);
    rtlProcess = spawn("rtl_fm", args);

    rtlProcess.stdout.on('data', (chunk) => {
        // chunk is a Buffer
        const res = dsp.process(chunk, state.squelch);

        // Prepare Header: RSSI (int16), IsOpen (int16)
        const header = Buffer.alloc(4);
        header.writeInt16LE(res.rssi, 0);
        header.writeInt16LE(res.isOpen ? 1 : 0, 2);

        const packet = Buffer.concat([header, res.buffer]);

        // Broadcast audio
        broadcastAudio(packet);

        // Recording
        if (state.isRecording && recFileStream && res.isOpen) {
            recFileStream.write(res.buffer);
        }
    });

    rtlProcess.on('error', (err) => {
        console.error("SDR Error:", err);
    });

    rtlProcess.on('close', (code) => {
        console.log(`SDR Exited with code ${code}`);
    });
}

// ==========================================
// 7. GPS Manager
// ==========================================

function parseNMEACoord(val, dir) {
    if (!val || val.length < 4) return 0.0;
    const dot = val.indexOf('.');
    if (dot === -1) return 0.0;
    
    const deg = parseFloat(val.substring(0, dot - 2));
    const min = parseFloat(val.substring(dot - 2));
    
    let res = deg + min / 60.0;
    if (dir === 'S' || dir === 'W') res = -res;
    return res;
}

function startGPS() {
    const gpsPort = process.env.GPS_PORT || '/dev/ttyUSB0';
    const gpsBaud = process.env.GPS_BAUD_RATE || '38400';

    // Set baud rate using stty (Linux)
    exec(`stty -F ${gpsPort} ${gpsBaud} raw -echo`, (err) => {
        if (err) {
            // Likely not connected or not linux
            return; 
        }

        // Simple Read Stream logic
        const stream = fs.createReadStream(gpsPort, { encoding: 'utf8' });
        let buffer = '';
        let lastUpdate = 0;

        stream.on('data', (chunk) => {
            // Only process if clients exist
            if (clients.size === 0) return;

            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line

            const now = Date.now();
            if (now - lastUpdate < 15000) return; // 15s throttle

            for (const line of lines) {
                if (line.includes('$GPGGA') || line.includes('$GNGGA')) {
                    const parts = line.split(',');
                    // check fix quality (idx 6) > 0
                    if (parts.length >= 10 && parts[6] !== '0' && parts[2] && parts[4]) {
                        const lat = parseNMEACoord(parts[2], parts[3]);
                        const lon = parseNMEACoord(parts[4], parts[5]);

                        lastUpdate = now;
                        let updated = false;

                        if (state.gpsStatus !== 'active') {
                            state.gpsStatus = 'active';
                            updated = true;
                        }

                        // Significant move check
                        const dist = Math.abs(state.lat - lat) + Math.abs(state.lon - lon);
                        state.lat = lat;
                        state.lon = lon;

                        if (dist > 0.0001) {
                            updated = true;
                            reverseGeocode(lat, lon);
                        }

                        if (updated) broadcastStatus();
                        console.log(`[GPS] Lat: ${lat}, Lon: ${lon}`);
                    } else {
                         if (state.gpsStatus === 'active') {
                            state.gpsStatus = 'searching';
                            broadcastStatus();
                         }
                    }
                }
            }
        });

        stream.on('error', () => {
             if (state.gpsStatus !== 'disconnected') {
                 state.gpsStatus = 'disconnected';
                 broadcastStatus();
             }
             // Retry logic could go here
        });
    });
}

// ==========================================
// 8. Recording Logic
// ==========================================

function writeWavHeader(stream, sampleRate, dataLen) {
    const buffer = Buffer.alloc(44);
    
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataLen, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // Mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
    buffer.writeUInt16LE(2, 32); // BlockAlign
    buffer.writeUInt16LE(16, 34); // BitsPerSample
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataLen, 40);

    if (stream instanceof fs.WriteStream) {
        // If it's a stream, we can't easily seek back unless we open it as a file descriptor later.
        // For writing *initial* header:
        stream.write(buffer);
    } else if (typeof stream === 'number') {
        // File Descriptor (sync)
        fs.writeSync(stream, buffer, 0, 44, 0);
    }
}

function startRecording() {
    if (state.isRecording) return;

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const freqStr = (state.freq / 1000000).toFixed(3) + "MHz";
    const timeStr = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
    
    let titlePart = "";
    if (state.title) {
        titlePart = "_" + state.title.replace(/[\\/:*?"<>|]/g, "-");
    }

    let gpsInfo = "";
    if (state.gpsUnlocked && (state.lat !== 0 || state.lon !== 0)) {
        gpsInfo = `_Lat${state.lat.toFixed(4)}_Lon${state.lon.toFixed(4)}`;
    }

    const dirPath = path.join(RECORDINGS_PATH, dateStr, freqStr);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

    const filename = `${timeStr}_${freqStr}${titlePart}${gpsInfo}.wav`;
    const fullPath = path.join(dirPath, filename);

    recFileStream = fs.createWriteStream(fullPath);
    currentRecPath = fullPath;
    
    // Write placeholder header
    writeWavHeader(recFileStream, SAMPLE_RATE, 0);

    state.isRecording = true;
    state.recFilename = fullPath;
    broadcastStatus();
}

function stopRecording() {
    if (!state.isRecording) return;
    state.isRecording = false;

    if (recFileStream) {
        recFileStream.end(() => {
            // Fix header with correct size
            if (currentRecPath) {
                try {
                    const stats = fs.statSync(currentRecPath);
                    const fileSize = stats.size;
                    const dataLen = fileSize - 44;
                    const fd = fs.openSync(currentRecPath, 'r+');
                    writeWavHeader(fd, SAMPLE_RATE, dataLen);
                    fs.closeSync(fd);
                } catch(e) {
                    console.error("Error fixing WAV header:", e);
                }
            }
            recFileStream = null;
            currentRecPath = null;
            broadcastRecordings();
        });
    } else {
        broadcastStatus();
    }
}

// ==========================================
// 9. Web & Socket Server
// ==========================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static('public')); // Serve index.html and assets
app.use(express.json());

// Icon Generation Mock
app.get('/icons/:file', (req, res) => {
    // Just serve a static color rect if file doesn't exist, 
    // or rely on static folder. Go version generated PNGs on fly.
    // For simplicity in Node, we assume static files or just send 404/basic implementation
    // Ideally, use a library like 'canvas' or 'sharp' but that's a heavy dependency.
    // We will skip dynamic generation to keep it dependency-light.
    res.sendFile(path.join(__dirname, 'public', req.params.file), (err) => {
        if(err) res.status(404).send('Not found');
    });
});

// Download Handler
app.get('/download/*', (req, res) => {
    const relPath = req.params[0];
    if (relPath.includes('..')) return res.status(403).send("Forbidden");
    const filePath = path.join(RECORDINGS_PATH, relPath);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send("Not Found");
    }
});

// Broadcast Functions
function broadcastStatus() {
    const connCount = clients.size;
    let lat = 0, lon = 0, addr = "", gpsS = "locked";
    
    if (state.gpsUnlocked) {
        lat = state.lat; lon = state.lon;
        addr = state.address; gpsS = state.gpsStatus;
    }

    const msg = {
        type: "status_update",
        freq: state.freq,
        mode: state.mode,
        title: state.title,
        att: state.att,
        squelch: state.squelch,
        isRecording: state.isRecording,
        connections: connCount,
        lat: lat, lon: lon,
        address: addr,
        gpsStatus: gpsS,
        gpsUnlocked: state.gpsUnlocked
    };
    
    const json = JSON.stringify(msg);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(json);
    });
}

function broadcastAudio(packet) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(packet);
    });
}

function getRecordingsTree() {
    const dateMap = {};

    function scanDir(dir, rootRel) {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(dir, item.name);
            const relPath = path.join(rootRel, item.name);

            if (item.isDirectory()) {
                scanDir(fullPath, relPath);
            } else if (item.name.endsWith('.wav')) {
                // Heuristic parsing matching Go logic
                const parts = relPath.split(path.sep);
                let date = "Unknown", freq = "Unknown";
                
                // Expect recordings/YYYY-MM-DD/FREQ/file.wav
                if (parts.length >= 2) {
                    date = parts[0];
                    if (parts.length >= 3) freq = parts[1];
                }

                // If flat structure fallback
                if (date === "Unknown") {
                    const stats = fs.statSync(fullPath);
                    date = stats.mtime.toISOString().split('T')[0];
                }

                if (!dateMap[date]) dateMap[date] = {};
                if (!dateMap[date][freq]) dateMap[date][freq] = [];

                const stats = fs.statSync(fullPath);
                dateMap[date][freq].push({
                    name: item.name,
                    path: relPath, // relative path for download
                    size: stats.size
                });
            }
        }
    }

    scanDir(RECORDINGS_PATH, "");

    // Transform to array structure
    const dateList = [];
    Object.keys(dateMap).sort().reverse().forEach(date => {
        const freqList = [];
        Object.keys(dateMap[date]).sort().forEach(freq => {
            // Sort files by name
            dateMap[date][freq].sort((a, b) => a.name.localeCompare(b.name));
            freqList.push({ freq, files: dateMap[date][freq] });
        });
        dateList.push({ date, freqs: freqList });
    });

    return dateList;
}

function broadcastRecordings() {
    const data = getRecordingsTree();
    const msg = JSON.stringify({ type: "recordings", data });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

function broadcastDebug() {
    const stats = getSystemStats();
    const msg = JSON.stringify({ type: "debug_info", data: stats });
    clients.forEach(client => {
        if (client.debugAuth && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// WebSocket Logic
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.debugAuth = false;

    broadcastStatus();
    ws.send(JSON.stringify({ type: "bookmarks", data: bookmarks }));
    
    // Send recordings once
    const recData = getRecordingsTree();
    ws.send(JSON.stringify({ type: "recordings", data: recData }));

    ws.on('message', (message) => {
        try {
            const cmd = JSON.parse(message);
            handleWSCommand(ws, cmd);
        } catch (e) {}
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcastStatus();
    });
});

function handleWSCommand(ws, cmd) {
    switch (cmd.type) {
        case "auth_tune":
            if (checkAuthHash("TUNE_AUTH_HASH", cmd.password)) {
                state.freq = cmd.freq;
                state.mode = cmd.mode;
                state.title = cmd.title || "";
                
                if (squelchDB[state.freq]) {
                    state.squelch = squelchDB[state.freq];
                }

                startSDR();
                broadcastStatus();
            }
            break;
        case "auth_gps":
            if (checkAuthHash("GPS_AUTH_HASH", cmd.gpsPassword)) {
                state.gpsUnlocked = !state.gpsUnlocked;
                broadcastStatus();
            }
            break;
        case "auth_debug":
            if (checkAuthHash("DEBUG_AUTH_HASH", cmd.debugPassword)) {
                ws.debugAuth = true;
                ws.send(JSON.stringify({ type: "debug_auth_success" }));
            }
            break;
        case "set_att":
            state.att = cmd.att;
            startSDR();
            broadcastStatus();
            break;
        case "set_squelch":
            state.squelch = cmd.val;
            squelchDB[state.freq] = cmd.val;
            saveSquelch();
            broadcastStatus();
            break;
        case "start_recording":
            startRecording();
            break;
        case "stop_recording":
            stopRecording();
            break;
        case "delete_recording":
            if (checkAuthHash("DELETE_AUTH_HASH", cmd.deletePassword)) {
                const safePath = path.normalize(cmd.filename).replace(/^(\.\.[\/\\])+/, '');
                const fullPath = path.join(RECORDINGS_PATH, safePath);
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                    broadcastRecordings();
                }
            }
            break;
        case "add_bookmark":
            {
                const b = cmd.data;
                b.id = Date.now().toString();
                bookmarks.push(b);
                saveBookmarks();
                const msg = JSON.stringify({ type: "bookmarks", data: bookmarks });
                clients.forEach(c => c.send(msg));
            }
            break;
        case "delete_bookmark":
            bookmarks = bookmarks.filter(b => b.id !== cmd.id && b.parentId !== cmd.id);
            saveBookmarks();
            const msgDel = JSON.stringify({ type: "bookmarks", data: bookmarks });
            clients.forEach(c => c.send(msgDel));
            break;
        // Simplified bookmark implementations (edit/move omitted for brevity but follow same pattern)
        case "edit_bookmark":
            {
                const d = cmd.data;
                const idx = bookmarks.findIndex(b => b.id === d.id);
                if (idx !== -1) {
                    bookmarks[idx] = { ...bookmarks[idx], ...d };
                    saveBookmarks();
                    clients.forEach(c => c.send(JSON.stringify({ type: "bookmarks", data: bookmarks })));
                }
            }
            break;
    }
}

// Discord Notification
function sendDiscordNotification() {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return;

    const payload = {
        username: "SDR Commander Node",
        embeds: [{
            title: "📡 System Started",
            description: "SDR Web Receiver is online (Node.js Backend).",
            color: 5814783,
            timestamp: new Date().toISOString(),
            fields: [
                { name: "Initial Freq", value: (state.freq/1e6).toFixed(3) + " MHz", inline: true },
                { name: "Mode", value: state.mode, inline: true }
            ]
        }]
    };

    const data = JSON.stringify(payload);
    const urlObj = new URL(url);
    const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    });
    req.write(data);
    req.end();
}

// Initialization
loadData();
startSDR();
startGPS();
setInterval(broadcastDebug, 1000);

server.listen(PORT, () => {
    console.log(`SDR Server (Node.js) running on http://localhost:${PORT}`);
    setTimeout(sendDiscordNotification, 2000);
});