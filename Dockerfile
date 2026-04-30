FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

RUN mkdir -p /app/auth_session

EXPOSE 3000

CMD ["node", "index.js"]