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
const pino    = require('pino');
const path    = require('path');
const fs      = require('fs');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────

const CONFIG = {
    // Números permitidos en formato internacional SIN + ni espacios.
    // Ejemplo: '34612345678' para un número español +34 612 345 678
    allowedNumbers: [
        '51933747910',  // +51 933 747 910
        '51956274174',  // +51 956 274 174
        '51976696005',  // +51 976 696 005
        '491623796316', // +49 162 3796316
    ],

    // Cuántos mensajes guardar en memoria (los más recientes)
    maxMessages: 20,

    // Puerto del servidor HTTP que consultará el ESP
    port: process.env.PORT || 3000,

    // Carpeta donde Baileys guarda la sesión (evita escanear QR cada vez)
    authFolder: './auth_session',

    // Log level: 'silent' en producción, 'info' para depurar
    logLevel: process.env.LOG_LEVEL || 'info',
};

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────

/** @type {Array<{id:string, from:string, name:string, text:string, ts:number}>} */
const messageQueue = [];

/** Último mensaje leído (para que el ESP sepa si hay algo nuevo) */
let lastMessageId = 0;

// ─── LOGGER ───────────────────────────────────────────────────────────────────

const logger = pino(
    { level: CONFIG.logLevel },
    pino.destination(1) // stdout
);

const silentLogger = pino({ level: 'silent' });



// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Normaliza un JID de WhatsApp al número puro.
 * '34612345678@s.whatsapp.net' → '34612345678'
 */
function jidToNumber(jid) {
    return (jid || '').split('@')[0].split(':')[0];
}

/**
 * Extrae el texto plano de un mensaje de Baileys
 * (soporta texto normal, extended text y botones)
 */
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

/**
 * Añade un mensaje a la cola y recorta si supera el máximo
 */
function enqueue(entry) {
    lastMessageId += 1;
    messageQueue.push({ id: lastMessageId, ...entry });
    if (messageQueue.length > CONFIG.maxMessages) {
        messageQueue.shift();
    }
    logger.info({ from: entry.from, text: entry.text.slice(0, 60) }, 'Mensaje encolado');
}

// ─── SERVIDOR EXPRESS ─────────────────────────────────────────────────────────

const app = express();

/**
 * GET /messages
 * Devuelve todos los mensajes en cola (o sólo los nuevos si se pasa ?since=<id>)
 *
 * El ESP hace: GET /messages?since=<ultimo_id_conocido>
 *
 * Respuesta JSON:
 * {
 *   "count": 2,
 *   "messages": [
 *     { "id": 5, "from": "34612345678", "name": "Mamá", "text": "Hola!", "ts": 1712345678 },
 *     ...
 *   ]
 * }
 */
app.get('/messages', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const msgs  = messageQueue.filter(m => m.id > since);
    res.json({ count: msgs.length, messages: msgs });
});

/**
 * GET /status
 * Estado de la conexión. Útil para depurar desde el ESP o browser.
 */
app.get('/status', (req, res) => {
    res.json({
        connected: global.waConnected || false,
        queueLength: messageQueue.length,
        lastMessageId,
        allowedNumbers: CONFIG.allowedNumbers,
    });
});

/**
 * GET /clear
 * Vacía la cola (útil para pruebas)
 */
app.get('/clear', (req, res) => {
    messageQueue.length = 0;
    lastMessageId = 0;
    res.json({ ok: true });
});


/**
 * GET /health
 * Keepalive para cron-job.org — evita que Render duerma el servidor
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), connected: global.waConnected || false });
});

app.listen(CONFIG.port, () => {
    logger.info(`Servidor HTTP escuchando en puerto ${CONFIG.port}`);
});

// ─── BAILEYS: CONEXIÓN A WHATSAPP ─────────────────────────────────────────────

async function connectToWhatsApp() {
    // Asegurar que existe la carpeta de sesión
    if (!fs.existsSync(CONFIG.authFolder)) {
        fs.mkdirSync(CONFIG.authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authFolder);
    const { version }          = await fetchLatestBaileysVersion();

    logger.info({ version }, 'Versión de WhatsApp Web');

    const sock = makeWASocket({
        version,
        logger: silentLogger,         // Baileys es muy verboso; usamos nuestro logger
        printQRInTerminal: false,     // Lo imprimimos nosotros con qrcode-terminal
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
        },
        // Reduce el consumo de memoria en servidores pequeños
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });

    // ── Guardar credenciales cuando cambian ──
    sock.ev.on('creds.update', saveCreds);

    // ─── MAPA LID → número ────────────────────────────────────────────────────────
    const lidToNumber = new Map();

// Se llena cuando Baileys sincroniza los contactos
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.lid && c.id) {
                const lid    = c.lid.split('@')[0];
                const number = c.id.split('@')[0];
                lidToNumber.set(lid, number);
                console.log(`LID mapeado: ${lid} → ${number}`);
            }
        }
    });

    // ── Manejo de conexión / QR ──
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            logger.info('Escanea el QR con tu WhatsApp → Dispositivos vinculados → Vincular dispositivo');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            global.waConnected = true;
            logger.info('✅ Conectado a WhatsApp');
        }

        if (connection === 'close') {
            global.waConnected = false;
            const code       = lastDisconnect?.error?.output?.statusCode;
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

    // ── Recibir mensajes ──
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        console.log('>>> upsert type:', type, '| msgs:', messages.length); // ← añade esta línea
        if (type !== 'notify') return;

        for (const msg of messages) {
            console.log('>>> jid:', msg.key.remoteJid, '| fromMe:', msg.key.fromMe);
            if (msg.key.fromMe)                          continue;

            // Si viene en formato LID, extraer número real desde senderPn
            let jid = msg.key.remoteJid;
            if (jid.endsWith('@lid')) {
                const senderPn = msg.key.senderPn;
                if (!senderPn) continue;
                jid = senderPn; // ya viene como '51933747910@s.whatsapp.net'
            }

            if (jid.endsWith('@g.us'))      continue;
            if (jid.endsWith('@broadcast')) continue;

            const number = jidToNumber(jid);
            console.log('>>> número extraído:', number, '| en whitelist:', CONFIG.allowedNumbers.includes(number));
            if (!CONFIG.allowedNumbers.includes(number)) continue;

            const text = extractText(msg);
            if (!text) continue;

            enqueue({
                from: number,
                name: msg.pushName || number,
                text,
                ts: Math.floor((msg.messageTimestamp || Date.now() / 1000)),
            });
        }
    });

    return sock;
}

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────

connectToWhatsApp().catch(err => {
    logger.error(err, 'Error fatal al conectar');
    process.exit(1);
});