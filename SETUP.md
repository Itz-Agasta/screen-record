# Local Development Setup Guide

Step-by-step instructions to run all three components on a single machine
for development and testing.

---

## Table of Contents

1. [System Requirements](#1-system-requirements)
2. [PostgreSQL Setup](#2-postgresql-setup)
3. [Backend (FastAPI)](#3-backend-fastapi)
4. [Admin Panel (Next.js)](#4-admin-panel-nextjs)
5. [Desktop Client (Electron)](#5-desktop-client-electron)
6. [First-Run: Seed Admin Account](#6-first-run-seed-admin-account)
7. [Testing the Full Flow](#7-testing-the-full-flow)
8. [Common Issues](#8-common-issues)

---

## 1. System Requirements

### All platforms
- **Node.js 20 LTS** — https://nodejs.org/en/download
- **Python 3.11+** — https://www.python.org/downloads/

### Windows only (for the desktop client)
- No extra media capture tooling is required for the current desktop build.

### Database
- **PostgreSQL 15+** — https://www.postgresql.org/download/

---

## 2. PostgreSQL Setup

### Option A: Local install

```bash
# macOS (Homebrew)
brew install postgresql@15
brew services start postgresql@15

# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql

# Windows
# Use the installer from https://www.postgresql.org/download/windows/
```

### Create the database and user

```sql
-- Connect as postgres superuser
psql -U postgres

CREATE USER neonexus_user WITH PASSWORD 'your_strong_password';
CREATE DATABASE copilit OWNER neonexus_user;
GRANT ALL PRIVILEGES ON DATABASE copilit TO neonexus_user;
\q
```

### Option B: Docker (quickest)

```bash
docker run -d \
  --name neonexus-postgres \
  -e POSTGRES_USER=neonexus_user \
  -e POSTGRES_PASSWORD=your_strong_password \
  -e POSTGRES_DB=copilit \
  -p 55443:5432 \
  postgres:15-alpine
```

---

## 3. Backend (FastAPI)

### 3.1 Create and activate virtual environment

```bash
cd backend

# Create venv
python -m venv venv

# Activate — macOS/Linux
source venv/bin/activate

# Activate — Windows (Command Prompt)
venv\Scripts\activate.bat

# Activate — Windows (PowerShell)
venv\Scripts\Activate.ps1
```

### 3.2 Install dependencies

```bash
pip install -r requirements.txt
```

### 3.3 Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```env
# Generate a strong secret:
# python -c "import secrets; print(secrets.token_hex(32))"
SECRET_KEY=your_generated_secret_here
DEBUG=true

DATABASE_URL=postgresql+asyncpg://neonexus_user:your_strong_password@127.0.0.1:55443/copilit

CORS_ORIGINS=["http://localhost:3000","file://"]

ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

### 3.4 Run database migrations

```bash
# Option A: Alembic (recommended for production)
alembic upgrade head

# Option B: Auto-create on startup (fine for dev — FastAPI does this)
# Just start the server and tables are created automatically.
```

### 3.5 Start the backend

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

You should see:
```
INFO  Starting NeoNexus Copilot backend …
INFO  Database tables verified / created.
INFO  Application startup complete.
```

Swagger UI is available at **http://127.0.0.1:8000/docs** (when `DEBUG=true`).

---

## 4. Admin Panel (Next.js)

### 4.1 Install dependencies

```bash
cd admin-panel
npm install
```

### 4.2 Configure environment

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
```

### 4.3 Start the dev server

```bash
npm run dev
```

Admin panel is available at **http://localhost:3000**.

You will be redirected to `/login`. Use the admin credentials you'll seed
in step 6.

---

## 5. Desktop Client (Electron)

### 5.1 Install dependencies

```bash
cd desktop-client
npm install
```

### 5.2 Configure environment

Create a `.env` file in the `desktop-client/` root:

```env
VITE_BACKEND_URL=http://127.0.0.1:8000
```

### 5.3 Start in development mode

```bash
npm run dev
```

This runs two processes concurrently:
- `vite` — builds and serves the React renderer on `http://localhost:5173`
- `electron .` — opens the Electron window pointing to the Vite dev server

> **Windows note**: No FFmpeg setup is required for the current desktop build.

### 5.4 Build the Windows installer (optional)

```bash
# Must be run on Windows
npm run dist:win
# Output: release/NeoNexus Copilot Setup 1.0.0.exe
```

---

## 6. First-Run: Seed Admin Account

The `/admin/admins` endpoint requires an existing admin JWT, so we seed
the first account directly via a Python script.

With the **backend venv active** and the backend **not running**:

```bash
cd backend
python scripts/seed_admin.py
```

Or do it manually in Python:

```python
# Run from backend/ directory with venv active
import asyncio
from app.core.database import AsyncSessionLocal
from app.models.admin import Admin
from app.core.security import hash_password

async def seed():
    async with AsyncSessionLocal() as db:
        admin = Admin(
            username="superadmin",
            email="admin@neonexus.io",
            password_hash=hash_password("admin123"),
        )
        db.add(admin)
        await db.commit()
        print(f"Admin created: {admin.username}")

asyncio.run(seed())
```

Now log in to the admin panel at http://localhost:3000 with:
- **Username**: `superadmin`
- **Password**: `admin123`

If login still returns 401, verify the backend is using the same PostgreSQL
database you seeded. The local Docker stack listens on port 55443.

---

## 7. Testing the Full Flow

With all three components running:

### Step 1 — Create a test user

1. Open **http://localhost:3000** → log in as admin
2. Navigate to **Users → New User**
3. Fill in:
   - Username: `testuser`
   - Email: `test@example.com`
   - Password: `TestPass123!`
   - Permitted Sessions: `5`
   - Paste any resume text and job description
4. Click **Create User**

### Step 2 — Log in on the desktop client

1. Open the **Electron app** (started with `npm run dev` in `desktop-client/`)
2. Log in with `testuser` / `TestPass123!`
3. You should see: `Sessions: 0 / 5`

### Step 3 — Verify user data in admin panel

1. Navigate to **Users** in the admin panel
2. Open the test user profile
3. Confirm account status and permitted sessions are shown correctly

---

## 8. Common Issues

### Backend won't start — `asyncpg.exceptions.InvalidAuthorizationSpecificationError`
Your `DATABASE_URL` credentials don't match PostgreSQL. Double-check the
username/password and that the `copilit` database exists.

### Backend won't start — `MODULE_NOT_FOUND` for `app.routers.*`
The `app/routers/__init__.py` is missing. Ensure it exists (it's in the repo
but sometimes git ignores empty files). Create it: `touch app/routers/__init__.py`

### Electron — `Error: Not authenticated`
The JWT wasn't passed to the main process. Ensure `window.electronAPI.login()`
is being called after the REST login — check browser DevTools in the Electron
renderer (open with `Ctrl+Shift+I` in dev mode).

### Admin panel — CORS errors in the browser console
Add `http://localhost:3000` to `CORS_ORIGINS` in `backend/.env` and restart
the backend.

---

## Port Reference

| Service | Port | URL |
|---------|------|-----|
| FastAPI backend | 8000 | http://127.0.0.1:8000 |
| FastAPI Swagger | 8000 | http://127.0.0.1:8000/docs |
| Admin panel | 3000 | http://localhost:3000 |
| Vite renderer | 5173 | http://localhost:5173 |
| PostgreSQL | 55443 (host) -> 5432 (container) | — |
