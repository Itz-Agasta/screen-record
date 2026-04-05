# NeoNexus AI Interview Copilot

Real-time AI interview assistant for NeoNexus Innovations LLP.

## Monorepo Structure

```
neonexus-copilot/
├── backend/          Python FastAPI — REST API, WebSockets, AI pipeline
├── admin-panel/      Next.js 15    — Web admin dashboard
└── desktop-client/   Electron      — Windows .exe user client
```

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Python | 3.11+ | Backend |
| Node.js | 20 LTS | Admin panel + Electron |
| PostgreSQL | 15+ | Database |

---

## Quick Start

See `SETUP.md` in each subdirectory for detailed instructions, or follow the
condensed steps below.

### 1. Backend

```bash
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # fill in all values
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 2. Admin Panel

```bash
cd admin-panel
npm install
cp .env.local.example .env.local   # set NEXT_PUBLIC_BACKEND_URL
npm run dev    # → http://localhost:3000
```

### 3. Desktop Client (development)

```bash
cd desktop-client
npm install
npm run dev    # starts Vite renderer + Electron concurrently
```

---

## Environment Variables

### Backend `.env`

| Variable | Description |
|----------|-------------|
| `SECRET_KEY` | JWT signing secret (generate with `openssl rand -hex 32`) |
| `DATABASE_URL` | `postgresql+asyncpg://user:pass@localhost:55443/copilit` |
| `ANTHROPIC_API_KEY` | Claude 3.5 Sonnet API key |
| `OPENAI_API_KEY` | GPT-4o-mini API key |
| `CORS_ORIGINS` | JSON array of allowed origins, e.g. `["http://localhost:3000"]` |

### Admin Panel `.env.local`

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_BACKEND_URL` | Backend base URL, e.g. `http://localhost:8000` |

### Desktop Client `src/lib/api.ts` / `.env`

Set `VITE_BACKEND_URL` in a `.env` file at the
desktop-client root (prefix all with `VITE_` for Vite to expose them).

---

## Database Setup

```bash
cd backend
# With the venv active and .env filled in:
alembic upgrade head

# Or let FastAPI auto-create tables on first startup (dev only):
uvicorn main:app --reload
```

To create the first admin account, run the seed script once:

```bash
cd backend
python scripts/seed_admin.py
```

Default seeded credentials:

- Username: `superadmin`
- Password: `admin123`

The admin login uses username + password, not the numeric database id.
Make sure the backend and the seed script point at the same PostgreSQL instance.

---

## Building the Windows .exe

```bash
cd desktop-client
npm run dist:win    # produces release/NeoNexus Copilot Setup x.x.x.exe
```

No FFmpeg binary is required for the current desktop build.

---

## Production Deployment (Hostinger VPS)

1. Clone the repo onto the VPS.
2. Set up PostgreSQL and create the `copilit` database.
3. Fill in `/backend/.env` with production values.
4. Run the backend with `uvicorn` behind Nginx + systemd.
5. Build the admin panel with `npm run build` and serve via Nginx.

See `DEPLOYMENT.md` for the full Nginx + systemd configuration.
