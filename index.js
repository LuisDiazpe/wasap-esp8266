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
        '51933747910',
        '51956274174',
        '51976696005',
        '491623796316',
        '51906782128',
    ],
    maxMessagesPerChat: 50,
    port:      process.env.PORT || 3000,
    authFolder:'./auth_session',
    logLevel:  process.env.LOG_LEVEL || 'info',
};

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────

/**
 * chats = {
 *   '51933747910': {
 *     number: '51933747910',
 *     name: 'Sandry',
 *     unread: 2,
 *     messages: [ { id, text, ts, fromMe } ]
 *   }, ...
 * }
 */
const chats = {};
let   globalMsgId = 0;

// Cola plana (compatibilidad con sketch anterior)
const messageQueue = [];
let   lastMessageId = 0;
let   currentQR     = null;

// ─── LOGGER ───────────────────────────────────────────────────────────────────

const logger       = pino({ level: CONFIG.logLevel }, pino.destination(1));
const silentLogger = pino({ level: 'silent' });

// ─── MAPA LID ─────────────────────────────────────────────────────────────────
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

function addToChat(number, name, text, ts, fromMe) {
    if (!chats[number]) {
        // Al crear el chat, solo usar el nombre si es un mensaje recibido
        chats[number] = { number, name: (!fromMe && name) ? name : number, unread: 0, messages: [] };
    }
    const chat = chats[number];
    // Actualizar nombre solo con mensajes recibidos
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

    logger.info({ number, fromMe, text: text.slice(0, 50) }, 'Mensaje');
}

// ─── EXPRESS ──────────────────────────────────────────────────────────────────

const app = express();

// ── /messages (compatibilidad sketch anterior) ──
app.get('/messages', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ count: messageQueue.filter(m => m.id > since).length,
        messages: messageQueue.filter(m => m.id > since) });
});

// ── /chats — lista de conversaciones ──
app.get('/chats', (req, res) => {
    const list = Object.values(chats).map(c => ({
        number:   c.number,
        name:     c.name,
        unread:   c.unread,
        lastText: c.messages.length > 0 ? c.messages[c.messages.length - 1].text : '',
        lastTs:   c.messages.length > 0 ? c.messages[c.messages.length - 1].ts  : 0,
    }));
    list.sort((a, b) => b.lastTs - a.lastTs);
    res.json({ count: list.length, chats: list });
});

// ── /chats/:number — historial ──
app.get('/chats/:number', (req, res) => {
    const num   = req.params.number;
    const limit = parseInt(req.query.limit) || 30;
    if (!chats[num]) return res.json({ number: num, name: num, unread: 0, messages: [] });
    const chat = chats[num];
    chats[num].unread = 0;
    res.json({ number: chat.number, name: chat.name, unread: 0,
        messages: chat.messages.slice(-limit) });
});

// ── /status ──
app.get('/status', (req, res) => {
    res.json({ connected: global.waConnected || false,
        chats: Object.keys(chats).length, lastMessageId,
        allowedNumbers: CONFIG.allowedNumbers });
});

// ── /clear ──
app.get('/clear', (req, res) => {
    Object.keys(chats).forEach(k => delete chats[k]);
    messageQueue.length = 0;
    lastMessageId = 0;
    res.json({ ok: true });
});

// ── /health ──
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()),
        connected: global.waConnected || false });
});

// ── /qr ──
app.get('/qr', async (req, res) => {
    if (global.waConnected)
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Ya conectado</h2></body></html>');
    if (!currentQR)
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ QR no disponible aún, recarga en unos segundos</h2></body></html>');
    const img = await QRCode.toDataURL(currentQR);
    res.send(`<html><head><meta http-equiv="refresh" content="30"></head>
        <body style="background:#111;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0">
        <p style="color:#fff;font-family:sans-serif;margin-bottom:16px">Escanea con WhatsApp → Dispositivos vinculados</p>
        <img src="${img}" style="width:280px;height:280px"/>
        </body></html>`);
});

app.listen(CONFIG.port, () => logger.info(`Puerto ${CONFIG.port}`));

// ─── BAILEYS ──────────────────────────────────────────────────────────────────

async function connectToWhatsApp() {
    if (!fs.existsSync(CONFIG.authFolder))
        fs.mkdirSync(CONFIG.authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authFolder);
    const { version }          = await fetchLatestBaileysVersion();
    logger.info({ version }, 'WhatsApp Web version');

    const sock = makeWASocket({
        version, logger: silentLogger, printQRInTerminal: false,
        auth: { creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
        syncFullHistory: false, markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts)
            if (c.lid && c.id)
                lidToNumber.set(c.lid.split('@')[0], c.id.split('@')[0]);
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
            logger.info('QR listo → /qr');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            currentQR = null; global.waConnected = true;
            logger.info('✅ Conectado');
        }
        if (connection === 'close') {
            global.waConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            logger.warn({ code }, 'Desconectado');
            if (code !== DisconnectReason.loggedOut) {
                logger.info('Reconectando en 5s...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Logout — borra auth_session/ y re-escanea QR');
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        console.log('>>> upsert:', type);
        for (const m of messages) {
            console.log('>>> key completo:', JSON.stringify(m.key, null, 2));
        }
        if (type !== 'notify') return;

        for (const msg of messages) {
            let jid = msg.key.remoteJid;

            // Resolver LID
            if (jid.endsWith('@lid')) {
                const alt = msg.key.remoteJidAlt || msg.key.senderPn;
                if (alt) { jid = alt; }
                else {
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

            const ts     = Math.floor(msg.messageTimestamp || Date.now() / 1000);
            const fromMe = msg.key.fromMe || false;
            const name   = msg.pushName || number;

            addToChat(number, name, text, ts, fromMe);
        }
    });

    return sock;
}

connectToWhatsApp().catch(err => {
    logger.error(err, 'Error fatal');
    process.exit(1);
});