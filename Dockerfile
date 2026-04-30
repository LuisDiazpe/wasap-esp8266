FROM ubuntu:latest
LABEL authors="Luis Díaz"
FROM node:20-slim

# Directorio de trabajo
WORKDIR /app

# Instalar dependencias primero (capa cacheada)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el código
COPY index.js ./

# La carpeta de sesión se guarda en un volumen persistente.
# En Railway/Fly crea un volumen montado en /app/auth_session
VOLUME ["/app/auth_session"]

EXPOSE 3000

CMD ["node", "index.js"]
ENTRYPOINT ["top", "-b"]