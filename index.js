'use strict';

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

require('dotenv').config();

const CONFIG = {
    allowedNumbers: (process.env.ALLOWED_NUMBERS || '')
        .split(',')
        .map(n => n.trim())
        .filter(Boolean),
    maxMessagesPerChat: 50,
    port: process.env.PORT || 3000,
    authFolder: process.env.AUTH_FOLDER || './auth_session',
    logLevel: process.env.LOG_LEVEL || 'info',
};

const chats = {};
let globalMsgId = 0;

const messageQueue = [];
let lastMessageId = 0;
let currentQR = null;
let sockRef = null;

const logger = pino({ level: CONFIG.logLevel }, pino.destination(1));
const silentLogger = pino({ level: 'silent' });

const lidToNumber = new Map();

function jidToNumber(jid) {
    return (jid || '').split('@')[0].split(':')[0];
}

function extractText(msg) {
    const m = msg.message;
    if (!m) return null;
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        null
    );
}

function addToChat(number, name, text, ts, fromMe) {
    if (!chats[number]) {
        chats[number] = {
            number,
            name: (!fromMe && name) ? name : number,
            unread: 0,
            messages: [],
        };
    }

    const chat = chats[number];
    if (!fromMe && name && name !== number) chat.name = name;

    globalMsgId += 1;
    chat.messages.push({ id: globalMsgId, text, ts, fromMe: fromMe || false });

    if (chat.messages.length > CONFIG.maxMessagesPerChat) {
        chat.messages.shift();
    }

    if (!fromMe) {
        chat.unread += 1;
        lastMessageId += 1;
        messageQueue.push({ id: lastMessageId, from: number, name: chat.name, text, ts });
        if (messageQueue.length > 20) messageQueue.shift();
    }

    logger.info({ number, fromMe, text: text.slice(0, 50) }, 'Mensaje registrado');
}

// Convierte un buffer WAV a OGG/Opus, el formato de nota de voz de WhatsApp.
function wavToOpus(wavBuffer) {
    return new Promise((resolve, reject) => {
        const inPath = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
        const outPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`);

        fs.writeFileSync(inPath, wavBuffer);

        const ff = spawn('ffmpeg', [
            '-y',
            '-i', inPath,
            '-c:a', 'libopus',
            '-b:a', '24k',
            '-ar', '48000',
            '-ac', '1',
            outPath,
        ]);

        let stderr = '';
        ff.stderr.on('data', d => { stderr += d.toString(); });

        ff.on('close', code => {
            try { fs.unlinkSync(inPath); } catch (e) {}
            if (code !== 0) {
                try { fs.unlinkSync(outPath); } catch (e) {}
                return reject(new Error('ffmpeg fallo: ' + stderr.slice(-500)));
            }
            try {
                const ogg = fs.readFileSync(outPath);
                fs.unlinkSync(outPath);
                resolve(ogg);
            } catch (e) {
                reject(e);
            }
        });

        ff.on('error', err => reject(err));
    });
}

const app = express();

// El audio en streaming se maneja directamente como stream en el endpoint

app.get('/messages', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const msgs = messageQueue.filter(m => m.id > since);
    res.json({ count: msgs.length, messages: msgs });
});

app.get('/chats', (req, res) => {
    const list = Object.values(chats).map(c => ({
        number: c.number,
        name: c.name,
        unread: c.unread,
        lastText: c.messages.length > 0 ? c.messages[c.messages.length - 1].text : '',
        lastTs: c.messages.length > 0 ? c.messages[c.messages.length - 1].ts : 0,
    }));
    list.sort((a, b) => b.lastTs - a.lastTs);
    res.json({ count: list.length, chats: list });
});

app.get('/chats/:number', (req, res) => {
    const num = req.params.number;
    const limit = parseInt(req.query.limit) || 30;
    if (!chats[num]) return res.json({ number: num, name: num, unread: 0, messages: [] });
    const chat = chats[num];
    chat.unread = 0;
    res.json({
        number: chat.number,
        name: chat.name,
        unread: 0,
        messages: chat.messages.slice(-limit),
    });
});

// Recibe audio PCM crudo en streaming, lo pasa por ffmpeg en vivo y lo envia
// como nota de voz. El ESP manda las muestras a medida que graba, sin limite de RAM.
app.post('/send-audio', (req, res) => {
    const to = req.query.to;
    const sampleRate = parseInt(req.query.rate) || 16000;

    if (!to || !CONFIG.allowedNumbers.includes(to)) {
        return res.status(400).json({ error: 'Numero invalido o no permitido' });
    }
    if (!sockRef || !global.waConnected) {
        return res.status(503).json({ error: 'WhatsApp no conectado' });
    }

    logger.info({ to, sampleRate }, 'Iniciando recepcion de audio en streaming');

    // ffmpeg lee PCM crudo (s16le) desde stdin y saca OGG/Opus a stdout
    const ff = spawn('ffmpeg', [
        '-y',
        '-f', 's16le',
        '-ar', String(sampleRate),
        '-ac', '1',
        '-i', 'pipe:0',
        '-c:a', 'libopus',
        '-b:a', '24k',
        '-f', 'ogg',
        'pipe:1',
    ]);

    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));

    let ffErr = '';
    ff.stderr.on('data', d => { ffErr += d.toString(); });

    // El audio del ESP entra por req y se lo pasamos a ffmpeg en vivo
    // Contar bytes que llegan del ESP (diagnostico)
    let bytesRecibidos = 0;
    req.on('data', d => { bytesRecibidos += d.length; });
    req.on('end', () => { logger.info({ bytesRecibidos }, 'Total PCM recibido del ESP'); });

    req.pipe(ff.stdin);

    req.on('error', () => { try { ff.stdin.end(); } catch (e) {} });

    ff.on('close', async (code) => {
        if (code !== 0) {
            logger.error({ code, ffErr: ffErr.slice(-300) }, 'ffmpeg fallo');
            return res.status(500).json({ error: 'Error procesando audio' });
        }
        try {
            const ogg = Buffer.concat(chunks);
            const jid = to + '@s.whatsapp.net';
            await sockRef.sendMessage(jid, {
                audio: ogg,
                ptt: true,
                mimetype: 'audio/ogg; codecs=opus',
            });
            addToChat(to, to, '[audio enviado]', Math.floor(Date.now() / 1000), true);
            logger.info({ to, bytes: ogg.length }, 'Audio enviado');
            res.json({ ok: true });
        } catch (err) {
            logger.error({ err: err.message }, 'Error enviando audio');
            res.status(500).json({ error: err.message });
        }
    });

    ff.on('error', err => {
        logger.error({ err: err.message }, 'No se pudo iniciar ffmpeg');
        res.status(500).json({ error: 'ffmpeg no disponible' });
    });
});

app.get('/status', (req, res) => {
    res.json({
        connected: global.waConnected || false,
        chats: Object.keys(chats).length,
        lastMessageId,
        allowedNumbers: CONFIG.allowedNumbers,
    });
});

app.get('/clear', (req, res) => {
    Object.keys(chats).forEach(k => delete chats[k]);
    messageQueue.length = 0;
    lastMessageId = 0;
    res.json({ ok: true });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        connected: global.waConnected || false,
    });
});

app.get('/qr', async (req, res) => {
    if (global.waConnected) {
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Ya conectado</h2></body></html>');
    }
    if (!currentQR) {
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>QR no disponible aun, recarga en unos segundos</h2></body></html>');
    }
    const img = await QRCode.toDataURL(currentQR);
    res.send(`<html><head><meta http-equiv="refresh" content="30"></head>
        <body style="background:#111;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0">
        <p style="color:#fff;font-family:sans-serif;margin-bottom:16px">Escanea con WhatsApp, Dispositivos vinculados</p>
        <img src="${img}" style="width:280px;height:280px"/>
        </body></html>`);
});

app.listen(CONFIG.port, '0.0.0.0', () => logger.info(`Servidor escuchando en el puerto ${CONFIG.port}`));

async function connectToWhatsApp() {
    if (!fs.existsSync(CONFIG.authFolder)) {
        fs.mkdirSync(CONFIG.authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authFolder);
    const { version } = await fetchLatestBaileysVersion();
    logger.info({ version }, 'Version de WhatsApp Web');

    const sock = makeWASocket({
        version,
        logger: silentLogger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
        },
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });

    sockRef = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.lid && c.id) {
                lidToNumber.set(c.lid.split('@')[0], c.id.split('@')[0]);
            }
        }
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
            logger.info('QR disponible en /qr');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            currentQR = null;
            global.waConnected = true;
            logger.info('Conectado a WhatsApp');
        }
        if (connection === 'close') {
            global.waConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            logger.warn({ code }, 'Conexion cerrada');
            if (code !== DisconnectReason.loggedOut) {
                logger.info('Reconectando en 5 segundos');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Sesion cerrada, borra la carpeta de sesion y vuelve a escanear el QR');
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            let jid = msg.key.remoteJid;

            if (jid.endsWith('@lid')) {
                const alt = msg.key.remoteJidAlt || msg.key.senderPn;
                if (alt) {
                    jid = alt;
                } else {
                    const mapped = lidToNumber.get(jid.split('@')[0]);
                    if (!mapped) continue;
                    jid = mapped + '@s.whatsapp.net';
                }
            }

            if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;

            const number = jidToNumber(jid);
            if (!CONFIG.allowedNumbers.includes(number)) continue;

            const text = extractText(msg);
            if (!text) continue;

            const ts = Math.floor(msg.messageTimestamp || Date.now() / 1000);
            const fromMe = msg.key.fromMe || false;
            const name = msg.pushName || number;

            addToChat(number, name, text, ts, fromMe);
        }
    });

    return sock;
}

connectToWhatsApp().catch(err => {
    logger.error(err, 'Error fatal al iniciar');
    process.exit(1);
});