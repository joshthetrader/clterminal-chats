# Railway Deployment Instructions

This service powers Anonymous Chat and Live News aggregation for Crypto Legends Terminal.

## Files Included

- `src/index.js` — Fastify server with WebSocket endpoints for chat (`/ws`) and news (`/ws-news`), REST endpoints `/api/messages/:room` and `/api/news`.
- `package.json` — Dependencies (`fastify`, `@fastify/websocket`, `@fastify/cors`, `pg`, `ws`).
- `package-lock.json`
- `Procfile` — Declares the web process.
- `railway.toml`, `railway.json` — Base Railway configs.
- `.railwayignore`, `.gitignore`, `SECURITY.md`.

## Railway Setup

1. Create or select a Railway project and add a new service from GitHub.
2. Choose this repo `joshthetrader/clterminal-chats`.
3. Use defaults:
   - Root Directory: `/` (empty)
   - Build Command: (empty)
   - Start Command: (empty; Procfile will run `web: node src/index.js`)

## Environment Variables

Required/Recommended:

- `NODE_ENV=production`
- `PORT` — provided by Railway automatically.
- `CORS_ORIGIN=https://your-app-domain.com` — set to your app origin for production.
- `DATABASE_URL` — Postgres URL if you want persistence (recommended). When set, both chat and news will store to Postgres in separate tables.
- `PGSSLMODE=require` — for managed Postgres with TLS.

Optional:

- `CHAT_AUTH_REQUIRED` — (not used currently) placeholder for future auth.

## Data Storage

- Chat messages: `chat_messages` table (created automatically on boot if `DATABASE_URL` is set). Otherwise stored in memory with file fallback `data/messages.json`.
- News items: `news_items` table (created automatically on boot if `DATABASE_URL` is set). Otherwise stored in memory with file fallback `data/news.json`.

## Endpoints

- `GET /health` — health check.
- `GET /version` — server version.
- `GET /api/messages/:room?limit=50` — recent chat messages (default room `global`).
- `GET /api/news?limit=100` — recent news items.
- `GET /ws` — WebSocket for chat.
- `GET /ws-news` — WebSocket for live news.

## External News Sources

On startup, the server connects to:

- `wss://wss.phoenixnews.io`
- `wss://news.treeofalpha.com/ws`

Messages are normalized and stored in `news_items` (or memory/file), then broadcast to `/ws-news`.

## Verify Deployment

After deploy:

1. Check logs show:
   - `Chat server running on :PORT`
   - Connections established to PhoenixNews/TreeOfAlpha.
2. Open:
   - `https://<railway-app-domain>/health` → `{ ok: true }`
   - `https://<railway-app-domain>/api/news?limit=5` → `{ items: [...] }`
3. WebSocket test:
   - `wss://<railway-app-domain>/ws-news` should receive items as they arrive.

## Frontend Configuration

Set `VITE_CHAT_WS_URL` in the frontend (Crypto Legends Terminal) to your Railway websockets URL, e.g.:

```
VITE_CHAT_WS_URL=wss://<railway-app-domain>/ws
```

The frontend Live News will derive:

- HTTP base: `https://<railway-app-domain>` → `GET /api/news?limit=100`
- News WS: `wss://<railway-app-domain>/ws-news`

## Deploy

Push to `main` on GitHub; Railway auto-deploys if connected. Otherwise, trigger manual deploy in Railway UI.

Rollback is handled by reverting the Git commit.
