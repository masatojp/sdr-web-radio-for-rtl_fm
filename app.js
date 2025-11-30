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
    // 初期周波数 (Airband)
    frequency: 128800000, 
    // rtl_fmの設定
    gain: '40',       // 'auto' or 0-50. 航空無線は少し下げたほうがS/Nが良い場合がある
    ppm: 0,           // 周波数補正
    squelch: 20,      // rtl_fm側の簡易スケルチ
    
    // オーディオ設定
    sampleRate: 24000, // 音質確保のため少し高め
};

// ==========================================
// DSP (Audio Processing in Node.js)
// ==========================================
// 復調はrtl_fmに任せるため、Node.jsは「音声」の整形に集中する
class AudioProcessor {
    constructor() {
        this.buffer = Buffer.alloc(0);
        
        // 航空無線用フィルタ設定
        // 人の声の帯域 (300Hz - 3400Hz) 以外をカットする
        this.lastIn = 0;
        this.lastOut = 0;
        
        // コンプレッサー/AGC用
        this.peak = 0;
        this.gain = 1.0;
        this.targetLevel = 0.6; // 目標音量
    }

    // 簡易IIR バンドパスフィルタ & コンプレッサー
    process(chunk) {
        // 16bit Little Endian Signed PCMを想定
        const inputLen = chunk.length / 2;
        const outputBuffer = Buffer.alloc(inputLen * 2); // 16bit出力
        
        for (let i = 0; i < inputLen; i++) {
            // Int16読込 (-32768 ~ 32767) -> Float (-1.0 ~ 1.0)
            let sample = chunk.readInt16LE(i * 2) / 32768.0;

            // 1. DCカット (簡易HPF)
            sample = sample - 0.95 * this.lastIn + 0.95 * this.lastOut;
            this.lastIn = sample; // Save raw input for HPF state? No, typically input
            // 修正: DC Blocking Filter: y[n] = x[n] - x[n-1] + R * y[n-1]
            // ここでは簡易的に実装
            
            // 2. 簡易コンプレッサー (AGC)
            // 航空無線は「管制塔(遠い・小さい)」と「航空機(近い・大きい)」の差が激しい
            // 小さい音を持ち上げ、大きい音を抑える
            const absSample = Math.abs(sample);
            this.peak = this.peak * 0.9995 + absSample * 0.0005; // ゆっくり追従
            
            // ゲイン計算 (ピークが小さいときはゲインを上げ、大きいときは下げる)
            // 下限あり、上限あり
            let desiredGain = this.targetLevel / (this.peak + 0.01);
            if (desiredGain > 20.0) desiredGain = 20.0; // 無音時のノイズ増幅防止
            if (desiredGain < 1.0) desiredGain = 1.0;
            
            // ゲインを滑らかに変化させる
            this.gain = this.gain * 0.995 + desiredGain * 0.005;
            
            sample *= this.gain;

            // 3. ハードリミッター (歪み防止)
            if (sample > 0.95) sample = 0.95;
            if (sample < -0.95) sample = -0.95;

            this.lastOut = sample;

            // Float -> Int16
            let outInt = Math.floor(sample * 32767);
            outputBuffer.writeInt16LE(outInt, i * 2);
        }
        return outputBuffer;
    }
}

const audioProc = new AudioProcessor();

// ==========================================
// rtl_fm 管理
// ==========================================
let rtlProcess = null;
let currentFreq = CONFIG.frequency;

function startRadio(freq) {
    if (rtlProcess) {
        rtlProcess.kill();
        rtlProcess = null;
    }

    currentFreq = freq;
    console.log(`[Radio] Tuning to ${(freq/1000000).toFixed(2)} MHz`);

    // rtl_fm コマンドの構築
    // -M am : AMモード
    // -f freq : 周波数
    // -s 24k : サンプリングレート (帯域幅も適切に設定される)
    // -g 40 : ゲイン
    // -l 20 : スケルチレベル (無音時はデータを出力しない設定だが、Web用にノイズゲートはJSでやりたい場合もある。
    //         ここではrtl_fmの機能を使うとデータが止まりWSが切れたと誤認する可能性があるため、スケルチは0にしてJSで制御するか、
    //         あるいは常時流す。ここでは音質優先でrtl_fmに任せず、常時ストリームさせてAGCを効かせる)
    
    const args = [
        '-M', 'am',
        '-f', freq.toString(),
        '-s', CONFIG.sampleRate.toString(),
        '-g', CONFIG.gain,
        '-p', CONFIG.ppm.toString(),
        // '-' は標準出力への書き出しを意味するが、rtl_fmはデフォルトでstdout
    ];

    // 出力フォーマットは Signed 16bit Little Endian
    rtlProcess = spawn('rtl_fm', args);

    rtlProcess.stdout.on('data', (chunk) => {
        // 音声処理を通してブロードキャスト
        const processedAudio = audioProc.process(chunk);
        broadcastAudio(processedAudio);
    });

    rtlProcess.stderr.on('data', (data) => {
        // rtl_fmのデバッグ情報など
        // console.log(`[rtl_fm] ${data}`);
    });

    rtlProcess.on('close', (code) => {
        console.log(`[Radio] Process exited with code ${code}`);
    });
}

// ==========================================
// Webサーバー & WebSocket
// ==========================================
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlContent);
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocket.Server({ server });

function broadcastAudio(data) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// ステータス配信（接続時など）
function sendStatus(ws) {
    const msg = JSON.stringify({
        type: 'status',
        freq: currentFreq,
        sampleRate: CONFIG.sampleRate
    });
    ws.send(msg);
}

wss.on('connection', (ws) => {
    console.log('[Web] Client connected');
    sendStatus(ws);

    ws.on('message', (message) => {
        try {
            const cmd = JSON.parse(message);
            if (cmd.type === 'tune') {
                const freq = parseFloat(cmd.freq);
                startRadio(Math.floor(freq * 1000000));
                // 全員に通知
                wss.clients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) sendStatus(c);
                });
            }
        } catch(e) { console.error(e); }
    });
});

// ==========================================
// Frontend (Minimal UI for Audio)
// ==========================================
const htmlContent = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Clear Airband SDR</title>
    <style>
        body { background: #111; color: #eee; font-family: sans-serif; text-align: center; padding: 20px; }
        .box { background: #222; padding: 20px; border-radius: 10px; max-width: 400px; margin: 0 auto; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        h1 { margin: 0; font-size: 1.5rem; color: #4db6ac; }
        #freqDisplay { font-size: 3rem; font-weight: bold; margin: 20px 0; font-family: monospace; }
        input { padding: 10px; font-size: 1.2rem; width: 120px; text-align: center; border-radius: 5px; border: none; }
        button { padding: 10px 20px; font-size: 1.2rem; background: #00897b; color: white; border: none; border-radius: 5px; cursor: pointer; }
        button:active { background: #00695c; }
        #status { color: #888; font-size: 0.8rem; margin-top: 10px; }
        .monitor-btn { width: 100%; margin-top: 20px; background: #c62828; }
    </style>
</head>
<body>
    <div class="box">
        <h1>Airband Monitor</h1>
        <div id="freqDisplay">---.---</div>
        <div>
            <input type="number" id="freqInput" step="0.025" placeholder="MHz">
            <button onclick="tune()">TUNE</button>
        </div>
        <button id="playBtn" class="monitor-btn">START AUDIO</button>
        <div id="status">Ready</div>
    </div>

    <script>
        let ws;
        let audioCtx;
        let nextStartTime = 0;
        const FREQ_OFFSET = 0; // 必要なら表示補正

        const els = {
            freq: document.getElementById('freqDisplay'),
            input: document.getElementById('freqInput'),
            status: document.getElementById('status'),
            playBtn: document.getElementById('playBtn')
        };

        function connect() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + location.host);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => els.status.innerText = "Connected";
            ws.onclose = () => {
                els.status.innerText = "Disconnected. Reconnecting...";
                setTimeout(connect, 3000);
            };

            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'status') {
                        els.freq.innerText = (msg.freq / 1000000).toFixed(3);
                        els.input.value = (msg.freq / 1000000).toFixed(3);
                    }
                } else {
                    playAudio(event.data);
                }
            };
        }

        function playAudio(arrayBuffer) {
            if (!audioCtx) return;
            
            // Int16 -> Float32
            const int16 = new Int16Array(arrayBuffer);
            const float32 = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) {
                float32[i] = int16[i] / 32768.0;
            }

            const audioBuffer = audioCtx.createBuffer(1, float32.length, 24000);
            audioBuffer.getChannelData(0).set(float32);

            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);

            const now = audioCtx.currentTime;
            // バッファリング戦略: 遅延しすぎたらリセット、そうでなければ直後に再生
            if (nextStartTime < now) nextStartTime = now + 0.05;
            source.start(nextStartTime);
            nextStartTime += audioBuffer.duration;
        }

        els.playBtn.addEventListener('click', () => {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            }
            if (audioCtx.state === 'suspended') audioCtx.resume();
            els.playBtn.innerText = "LISTENING...";
            els.playBtn.style.background = "#2e7d32";
        });

        window.tune = () => {
            const freq = parseFloat(els.input.value);
            if (freq && ws) {
                ws.send(JSON.stringify({ type: 'tune', freq: freq }));
            }
        };

        connect();
    </script>
</body>
</html>
`;

server.listen(CONFIG.webPort, () => {
    console.log(`Server running at http://localhost:${CONFIG.webPort}`);
    startRadio(CONFIG.frequency);
});