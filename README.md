# Poker Platform

Multiplayer poker engine with a Python backend and a browser + desktop client. Website players and desktop app players share the same rooms in real time.

## Stack

| Layer | Tech |
|---|---|
| Game engine | Python — pure logic, no I/O |
| API | FastAPI · Pydantic v2 · Vercel serverless |
| State | Upstash Redis (distributed lock + room persistence) |
| Frontend | Vanilla JS · polling transport |
| Desktop | Electron — wraps the web UI, connects to the same backend |

## Architecture

```
poker/
├── lib/
│   ├── engine.py   # game rules, hand eval, AI bots — zero I/O
│   ├── router.py   # 16 FastAPI routes
│   ├── store.py    # Redis persistence + asyncio fallback
│   └── models.py   # Pydantic models
├── src/main.js     # browser client (polling)
├── desktop/        # Electron desktop app
└── index.html
```

Clean boundary: `engine.py` knows nothing about HTTP or Redis. `router.py` handles requests. `store.py` handles state. Frontend calls the API and renders what comes back.

## Run locally

**Backend**
```bash
pip install fastapi httpx mangum uvicorn
uvicorn api.poker:app --port 4242
```

**Desktop app**
```bash
cd poker/desktop
npm install
npm start
```

## Multiplayer

All clients — website and desktop — point to the same Vercel backend. Set `POKER_API_BASE` to your deployment URL in `poker/desktop/preload.js` for cross-platform rooms.

Add Redis for persistent multiplayer:
```
KV_REST_API_URL=<upstash url>
KV_REST_API_TOKEN=<upstash token>
```

Without Redis, state is stored per-instance (solo / local play only).
