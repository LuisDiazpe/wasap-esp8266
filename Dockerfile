FROM node:22-slim

# Instalar ffmpeg para convertir audio WAV → Opus (notas de voz de WhatsApp)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

RUN mkdir -p /app/auth_session

EXPOSE 3000

CMD ["node", "index.js"]