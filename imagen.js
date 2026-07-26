'use strict';

const { spawn } = require('child_process');

function aGrises(inputBuffer, w, h, contraste) {
    return new Promise((resolve, reject) => {
        // eq aumenta el contraste antes de convertir (util para stickers/memes)
        const filtros = [
            `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
        ];
        if (contraste) filtros.push('eq=contrast=1.8');
        filtros.push('format=gray');

        const ff = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-vf', filtros.join(','),
            '-f', 'rawvideo',
            '-pix_fmt', 'gray',
            'pipe:1',
        ]);

        const trozos = [];
        ff.stdout.on('data', d => trozos.push(d));
        let err = '';
        ff.stderr.on('data', d => { err += d.toString(); });

        ff.on('close', code => {
            if (code !== 0) return reject(new Error('ffmpeg: ' + err.slice(-300)));
            const todo = Buffer.concat(trozos);
            const porFrame = w * h;
            const n = Math.floor(todo.length / porFrame);
            if (n === 0) return reject(new Error('Sin frames'));
            const frames = [];
            for (let i = 0; i < n; i++)
                frames.push(todo.subarray(i * porFrame, (i + 1) * porFrame));
            resolve({ frames, w, h });
        });
        ff.on('error', reject);
        ff.stdin.on('error', () => {});
        ff.stdin.end(inputBuffer);
    });
}

// Dithering Floyd-Steinberg (para fotos)
function ditherFS(gris, w, h) {
    const buf = new Int16Array(w * h);
    for (let i = 0; i < w * h; i++) buf[i] = gris[i];
    const bpf = Math.ceil(w / 8);
    const salida = Buffer.alloc(bpf * h, 0);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const viejo = buf[i];
            const nuevo = viejo < 128 ? 0 : 255;
            const error = viejo - nuevo;
            if (nuevo === 255) salida[y * bpf + (x >> 3)] |= (0x80 >> (x & 7));
            if (x + 1 < w)              buf[i + 1]     += (error * 7) >> 4;
            if (y + 1 < h) {
                if (x > 0)              buf[i + w - 1] += (error * 3) >> 4;
                buf[i + w]     += (error * 5) >> 4;
                if (x + 1 < w)          buf[i + w + 1] += (error * 1) >> 4;
            }
        }
    }
    return salida;
}

// Umbral simple con nivel ajustable (para stickers/memes: zonas definidas)
function umbral(gris, w, h, nivel) {
    const bpf = Math.ceil(w / 8);
    const salida = Buffer.alloc(bpf * h, 0);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
            if (gris[y * w + x] >= nivel)
                salida[y * bpf + (x >> 3)] |= (0x80 >> (x & 7));
    return salida;
}

// modo: 'foto' usa dithering; 'contraste' usa umbral de alto contraste
async function aBitmapOLED(inputBuffer, w, h, maxFrames, modo) {
    const usarContraste = (modo === 'contraste');
    const { frames } = await aGrises(inputBuffer, w, h, usarContraste);
    const usar = frames.slice(0, maxFrames || frames.length);
    return {
        w, h,
        frames: usar.map(f => usarContraste ? umbral(f, w, h, 128) : ditherFS(f, w, h)),
    };
}

module.exports = { aBitmapOLED };