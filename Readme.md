# WhatsApp → ESP8266 · Servidor Node.js

Servidor que conecta tu WhatsApp a través de Baileys, filtra mensajes por número y los expone via HTTP para que el ESP8266 los consulte.

---

## Estructura

```
whatsapp-esp-server/
├── index.js        ← servidor principal
├── package.json
├── Dockerfile      ← para Railway / Render / Fly.io
└── auth_session/   ← se crea sola al escanear el QR
```

---

## Configuración rápida

1. **Edita `index.js`**, sección `CONFIG`:

```js
allowedNumbers: [
  '34612345678',   // ← pon aquí los números en formato internacional, sin + ni espacios
  '34698765432',
],
maxMessages: 20,  // cuántos mensajes guardar en memoria
port: 3000,
```

2. **Instala dependencias:**

```bash
npm install
```

3. **Arranca:**

```bash
npm start
```

4. **Escanea el QR** que aparece en la terminal con tu WhatsApp
   → Dispositivos vinculados → Vincular dispositivo.

5. La sesión se guarda en `auth_session/`. La próxima vez que arranques **no necesitas escanear el QR** salvo que cierres sesión desde el móvil.

---

## Endpoints

| Endpoint | Descripción |
|---|---|
| `GET /messages` | Todos los mensajes en cola |
| `GET /messages?since=<id>` | Solo mensajes con id > N (para el ESP) |
| `GET /status` | Estado de la conexión |
| `GET /clear` | Vacía la cola |

### Ejemplo de respuesta `/messages`

```json
{
  "count": 2,
  "messages": [
    { "id": 1, "from": "34612345678", "name": "Mamá", "text": "¿Estás en casa?", "ts": 1712345678 },
    { "id": 2, "from": "34698765432", "name": "Juan",  "text": "Llego en 10 min", "ts": 1712345690 }
  ]
}
```

---

## Despliegue en Railway (gratis)

1. Crea una cuenta en [railway.app](https://railway.app)
2. Nuevo proyecto → Deploy from GitHub (sube este repo) o usa el CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. En Railway, ve a **Variables** y añade si quieres:
    - `PORT=3000`
    - `LOG_LEVEL=info`
4. **Importante:** crea un **volumen persistente** montado en `/app/auth_session` para que la sesión QR sobreviva los reinicios.
    - En Railway: pestaña Volumes → Add Volume → mount path `/app/auth_session`

5. Obtén la URL pública de tu servicio (ej. `https://mi-wa-server.up.railway.app`) — esa es la que metes en el sketch del ESP.

---

## Despliegue en Render (gratis)

1. Nuevo Web Service → conecta tu repo
2. Build command: `npm install`
3. Start command: `node index.js`
4. Crea un **Persistent Disk** montado en `/app/auth_session`

---

## Notas importantes

- **Una sesión = un dispositivo.** WhatsApp solo permite tener la sesión abierta en un número limitado de dispositivos. Ciérrala desde el móvil si necesitas reabrirla.
- Los mensajes de grupos e imágenes/audios se ignoran deliberadamente. Solo llegan textos de los números en la whitelist.
- El servidor no guarda mensajes en disco; si se reinicia, la cola se vacía (el ESP simplemente no recibirá los mensajes anteriores al reinicio).