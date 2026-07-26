'use strict';

const { spawn } = require('child_process');

// Convierte un buffer de imagen (jpg, png, webp, incluso webp animado)
// a una secuencia de frames en escala de grises del tamano pedido.
// Devuelve { frames: [Buffer gris], w, h }
function aGrises(inputBuffer, w, h) {
    return new Promise((resolve, reject) => {
        const filtro = `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`;

        const ff = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-vf', filtro,
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
            for (let i = 0; i < n; i++) {
                frames.push(todo.subarray(i * porFrame, (i + 1) * porFrame));
            }
            resolve({ frames, w, h });
        });

        ff.on('error', reject);
        ff.stdin.on('error', () => {});
        ff.stdin.end(inputBuffer);
    });
}

// Aplica dithering Floyd-Steinberg a un frame gris y lo empaqueta en bits.
// Formato de salida: filas de ceil(w/8) bytes, bit mas significativo = pixel
// mas a la izquierda. Es el formato que espera drawBitmap de Adafruit_GFX.
function ditherYEmpaquetar(gris, w, h) {
    // Copia en enteros para poder propagar el error
    const buf = new Int16Array(w * h);
    for (let i = 0; i < w * h; i++) buf[i] = gris[i];

    const bytesPorFila = Math.ceil(w / 8);
    const salida = Buffer.alloc(bytesPorFila * h, 0);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const viejo = buf[i];
            const nuevo = viejo < 128 ? 0 : 255;
            const error = viejo - nuevo;

            if (nuevo === 255) {
                salida[y * bytesPorFila + (x >> 3)] |= (0x80 >> (x & 7));
            }

            // Repartir el error a los vecinos (Floyd-Steinberg)
            if (x + 1 < w)              buf[i + 1]        += (error * 7) >> 4;
            if (y + 1 < h) {
                if (x > 0)              buf[i + w - 1]    += (error * 3) >> 4;
                buf[i + w]        += (error * 5) >> 4;
                if (x + 1 < w)          buf[i + w + 1]    += (error * 1) >> 4;
            }
        }
    }
    return salida;
}

// Convierte una imagen a frames listos para la OLED.
// Devuelve { w, h, frames: [Buffer empaquetado] }
async function aBitmapOLED(inputBuffer, w, h, maxFrames) {
    const { frames } = await aGrises(inputBuffer, w, h);
    const usar = frames.slice(0, maxFrames || frames.length);
    return {
        w, h,
        frames: usar.map(f => ditherYEmpaquetar(f, w, h)),
    };
}

module.exports = { aBitmapOLED };