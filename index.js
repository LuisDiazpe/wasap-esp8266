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

const { createClient } = require('@supabase/supabase-js');

// Cliente de Supabase (opcional: si no hay credenciales, funciona solo en memoria)
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

const CONFIG = {
    allowedNumbers: (process.env.ALLOWED_NUMBERS || '')
        .split(',')
        .map(n => n.trim())
        .filter(Boolean),
    // Mapa numero->apodo, formato: "numero:apodo,numero:apodo"
    nombres: (process.env.NOMBRES || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean)
        .reduce((acc, par) => {
            const [num, nombre] = par.split(':');
            if (num && nombre) acc[num.trim()] = nombre.trim();
            return acc;
        }, {}),
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
    const apodo = CONFIG.nombres[number];

    if (!chats[number]) {
        chats[number] = {
            number,
            name: apodo || ((!fromMe && name) ? name : number),
            unread: 0,
            messages: [],
        };
    }

    const chat = chats[number];
    // El apodo configurado siempre tiene prioridad
    if (apodo) chat.name = apodo;
    else if (!fromMe && name && name !== number) chat.name = name;

    globalMsgId += 1;
    chat.messages.push({ id: globalMsgId, text, ts, fromMe: fromMe || false });

    if (chat.messages.length > CONFIG.maxMessagesPerChat) {
        chat.messages.shift();
    }

    // Guardar en Supabase (sin bloquear)
    if (supabase) {
        supabase.from('mensajes').insert({
            numero: number,
            nombre: chat.name,
            texto: text,
            ts: ts,
            from_me: fromMe || false,
        }).then(({ error }) => {
            if (error) logger.warn({ err: error.message }, 'Error guardando en Supabase');
        });
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

const DIA_MS = 24 * 60 * 60 * 1000;

// Transcribe un buffer de audio OGG usando la API de Groq (Whisper).
// Devuelve el texto o null si falla.
async function transcribirAudio(oggBuffer) {
    if (!process.env.GROQ_API_KEY) {
        logger.warn('Falta GROQ_API_KEY, no se puede transcribir');
        return null;
    }
    try {
        const form = new FormData();
        const blob = new Blob([oggBuffer], { type: 'audio/ogg' });
        form.append('file', blob, 'audio.ogg');
        form.append('model', 'whisper-large-v3-turbo');
        form.append('language', 'es');
        form.append('response_format', 'text');

        const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
            body: form,
        });

        if (!resp.ok) {
            const err = await resp.text();
            logger.warn({ status: resp.status, err: err.slice(0, 200) }, 'Groq fallo');
            return null;
        }
        const texto = (await resp.text()).trim();
        logger.info({ texto: texto.slice(0, 60) }, 'Audio transcrito');
        return texto;
    } catch (e) {
        logger.warn({ err: e.message }, 'Error transcribiendo');
        return null;
    }
}


// Carga el historial reciente desde Supabase al arrancar el servidor
async function cargarHistorial() {
    if (!supabase) return;
    try {
        // Traer mensajes de los ultimos 20 dias, ordenados por fecha
        const desde = Math.floor((Date.now() - 20 * DIA_MS) / 1000);
        const { data, error } = await supabase
            .from('mensajes')
            .select('*')
            .gte('ts', desde)
            .order('ts', { ascending: true });

        if (error) { logger.warn({ err: error.message }, 'No se pudo cargar historial'); return; }

        for (const m of (data || [])) {
            const num = m.numero;
            if (!chats[num]) {
                chats[num] = { number: num, name: m.nombre || num, unread: 0, messages: [] };
            }
            globalMsgId += 1;
            chats[num].messages.push({ id: globalMsgId, text: m.texto, ts: m.ts, fromMe: m.from_me });
            if (CONFIG.nombres[num]) chats[num].name = CONFIG.nombres[num];
            else if (m.nombre) chats[num].name = m.nombre;
        }
        // Recortar cada chat al maximo en memoria
        for (const num of Object.keys(chats)) {
            const msgs = chats[num].messages;
            if (msgs.length > CONFIG.maxMessagesPerChat) {
                chats[num].messages = msgs.slice(-CONFIG.maxMessagesPerChat);
            }
        }
        logger.info({ chats: Object.keys(chats).length }, 'Historial cargado desde Supabase');
    } catch (e) {
        logger.warn({ err: e.message }, 'Error cargando historial');
    }
}

// Limpieza con retencion: cuando el mensaje mas viejo supera los 20 dias,
// borra todo lo anterior a los ultimos 5 dias. Oscila entre 5 y 20 dias.
async function limpiarHistorial() {
    if (!supabase) return;
    try {
        // Buscar el mensaje mas antiguo
        const { data: viejos } = await supabase
            .from('mensajes')
            .select('ts')
            .order('ts', { ascending: true })
            .limit(1);

        if (!viejos || viejos.length === 0) return;

        const masViejo = viejos[0].ts * 1000;
        const edad = Date.now() - masViejo;

        // Si el mas viejo supera los 20 dias, recortar a los ultimos 5
        if (edad >= 20 * DIA_MS) {
            const corte = Math.floor((Date.now() - 5 * DIA_MS) / 1000);
            const { error } = await supabase
                .from('mensajes')
                .delete()
                .lt('ts', corte);
            if (error) logger.warn({ err: error.message }, 'Error en limpieza');
            else logger.info('Historial recortado a los ultimos 5 dias');
        }
    } catch (e) {
        logger.warn({ err: e.message }, 'Error en limpieza de historial');
    }
}

const app = express();

// El audio en streaming se maneja directamente como stream en el endpoint

app.get('/messages', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const msgs = messageQueue.filter(m => m.id > since);
    res.json({ count: msgs.length, messages: msgs });
});

app.get('/chats', (req, res) => {
    // Chats que ya tienen conversacion
    const list = Object.values(chats).map(c => ({
        number: c.number,
        name: c.name,
        unread: c.unread,
        lastText: c.messages.length > 0 ? c.messages[c.messages.length - 1].text : '',
        lastTs: c.messages.length > 0 ? c.messages[c.messages.length - 1].ts : 0,
    }));

    // Anadir los numeros de la whitelist que aun no tienen conversacion
    for (const num of CONFIG.allowedNumbers) {
        if (!chats[num]) {
            list.push({ number: num, name: CONFIG.nombres[num] || num, unread: 0, lastText: '', lastTs: 0 });
        }
    }

    // Ordenar: primero los que tienen mensajes recientes, luego los vacios
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
    const modo = req.query.modo || 'audio';

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

    // Node desempaqueta el chunked automaticamente en los eventos 'data'.
    // Escribimos cada trozo de PCM a ffmpeg a medida que llega.
    let bytesRecibidos = 0;
    req.on('data', chunk => {
        bytesRecibidos += chunk.length;
        ff.stdin.write(chunk);
    });
    req.on('end', () => {
        logger.info({ bytesRecibidos }, 'PCM recibido del ESP');
        ff.stdin.end();
    });

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

// Cargar historial guardado y programar la limpieza diaria
cargarHistorial();
limpiarHistorial();
setInterval(limpiarHistorial, DIA_MS);   // revisar una vez al dia