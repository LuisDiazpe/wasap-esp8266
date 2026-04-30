'use strict';

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcode  = require('qrcode-terminal');
const QRCode  = require('qrcode');
const pino    = require('pino');
const fs      = require('fs');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────

const CONFIG = {
    allowedNumbers: [
        '51933747910',  // +51 933 747 910
        '51956274174',  // +51 956 274 174
        '51976696005',  // +51 976 696 005
        '491623796316', // +49 162 3796316
    ],
    maxMessages:  20,
    port:         process.env.PORT || 3000,
    authFolder:   './auth_session',
    logLevel:     process.env.LOG_LEVEL || 'info',
};

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────

const messageQueue = [];
let lastMessageId  = 0;
let currentQR      = null;

// ─── LOGGER ───────────────────────────────────────────────────────────────────

const logger = pino(
    { level: CONFIG.logLevel },
    pino.destination(1)
);
const silentLogger = pino({ level: 'silent' });

// ─── MAPA LID → número ────────────────────────────────────────────────────────
const lidToNumber = new Map();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

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

function enqueue(entry) {
    lastMessageId += 1;
    messageQueue.push({ id: lastMessageId, ...entry });
    if (messageQueue.length > CONFIG.maxMessages) messageQueue.shift();
    logger.info({ from: entry.from, text: entry.text.slice(0, 60) }, 'Mensaje encolado');
}

// ─── SERVIDOR EXPRESS ─────────────────────────────────────────────────────────

const app = express();

app.get('/messages', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const msgs  = messageQueue.filter(m => m.id > since);
    res.json({ count: msgs.length, messages: msgs });
});

app.get('/status', (req, res) => {
    res.json({
        connected:      global.waConnected || false,
        queueLength:    messageQueue.length,
        lastMessageId,
        allowedNumbers: CONFIG.allowedNumbers,
    });
});

app.get('/clear', (req, res) => {
    messageQueue.length = 0;
    lastMessageId = 0;
    res.json({ ok: true });
});

app.get('/health', (req, res) => {
    res.json({
        status:    'ok',
        uptime:    Math.floor(process.uptime()),
        connected: global.waConnected || false,
    });
});

app.get('/qr', async (req, res) => {
    if (global.waConnected) {
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Ya conectado a WhatsApp</h2></body></html>');
    }
    if (!currentQR) {
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ QR aún no disponible. Espera unos segundos y recarga.</h2></body></html>');
    }
    try {
        const img = await QRCode.toDataURL(currentQR);
        res.send(`
            <html>
            <head><meta http-equiv="refresh" content="30"></head>
            <body style="background:#111;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0">
                <p style="color:#fff;font-family:sans-serif;margin-bottom:16px">Escanea con WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
                <img src="${img}" style="width:280px;height:280px"/>
                <p style="color:#888;font-family:sans-serif;font-size:12px;margin-top:12px">La página se recarga automáticamente cada 30s</p>
            </body>
            </html>
        `);
    } catch (e) {
        res.status(500).send('Error generando QR');
    }
});

app.listen(CONFIG.port, () => {
    logger.info(`Servidor HTTP escuchando en puerto ${CONFIG.port}`);
});

// ─── BAILEYS ──────────────────────────────────────────────────────────────────

async function connectToWhatsApp() {
    if (!fs.existsSync(CONFIG.authFolder)) {
        fs.mkdirSync(CONFIG.authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authFolder);
    const { version }          = await fetchLatestBaileysVersion();

    logger.info({ version }, 'Versión de WhatsApp Web');

    const sock = makeWASocket({
        version,
        logger:              silentLogger,
        printQRInTerminal:   false,
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
        },
        syncFullHistory:     false,
        markOnlineOnConnect: false,
    });

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
            logger.info('QR listo → visita /qr en el navegador para escanearlo');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            currentQR          = null;
            global.waConnected = true;
            logger.info('✅ Conectado a WhatsApp');
        }

        if (connection === 'close') {
            global.waConnected = false;
            const code            = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            logger.warn({ code }, 'Conexión cerrada');

            if (shouldReconnect) {
                logger.info('Reconectando en 5 s...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Sesión cerrada (logout). Borra auth_session/ y vuelve a escanear el QR.');
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            let jid = msg.key.remoteJid;

            if (jid.endsWith('@lid')) {
                const senderPn = msg.key.senderPn;
                if (senderPn) {
                    jid = senderPn;
                } else {
                    const mapped = lidToNumber.get(jid.split('@')[0]);
                    if (!mapped) continue;
                    jid = mapped + '@s.whatsapp.net';
                }
            }

            if (jid.endsWith('@g.us'))      continue;
            if (jid.endsWith('@broadcast')) continue;

            const number = jidToNumber(jid);
            if (!CONFIG.allowedNumbers.includes(number)) continue;

            const text = extractText(msg);
            if (!text) continue;

            enqueue({
                from: number,
                name: msg.pushName || number,
                text,
                ts:   Math.floor(msg.messageTimestamp || Date.now() / 1000),
            });
        }
    });

    return sock;
}

connectToWhatsApp().catch(err => {
    logger.error(err, 'Error fatal al conectar');
    process.exit(1);
});