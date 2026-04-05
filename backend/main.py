"""
NeoNexus AI Interview Copilot — FastAPI Application Entry Point
================================================================
Wires together core REST routers, CORS, and startup lifecycle.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.core.config import settings
from app.core.database import engine, Base

# ── ORM models must be imported before create_all so SQLAlchemy
#    registers their metadata.  Order matters for FK resolution.
from app.models import admin, user, session  # noqa: F401

from app.routers import auth, admin as admin_router, users
from app.websockets import deepgram_router

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("neonexus")


# ---------------------------------------------------------------------------
# Lifespan — runs once on startup and once on shutdown
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────
    log.info("Starting NeoNexus Copilot backend …")

    # Create all tables that don't yet exist when enabled.
    # In production, prefer Alembic migrations.
    if settings.DB_AUTO_CREATE_ON_STARTUP:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        log.info("Database tables verified / created.")
    else:
        log.info("Skipped table auto-create on startup (DB_AUTO_CREATE_ON_STARTUP=false).")

    yield  # ← application runs here

    # ── Shutdown ─────────────────────────────────────────────────────────
    log.info("Shutting down NeoNexus Copilot backend.")
    await engine.dispose()


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------
app = FastAPI(
    title="NeoNexus AI Interview Copilot",
    description=(
        "Admin and user management API for NeoNexus Copilot."
    ),
    version="1.0.0",
    docs_url="/docs" if settings.DEBUG else None,   # hide Swagger in prod
    redoc_url="/redoc" if settings.DEBUG else None,
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
# Allow the admin panel origin(s) and the Electron app (file://).
# Tighten allowed_origins in production — never leave ["*"].
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# REST routers
# ---------------------------------------------------------------------------
app.include_router(
    auth.router,
    prefix="/auth",
    tags=["Authentication"],
)

app.include_router(
    admin_router.router,
    prefix="/admin",
    tags=["Admin — User Management"],
)

app.include_router(
    users.router,
    prefix="/users",
    tags=["Users"],
)

# ---------------------------------------------------------------------------
# WebSocket routers
# ---------------------------------------------------------------------------
app.include_router(
    deepgram_router,
    prefix="/ws",
    tags=["WebSocket"],
)


# ---------------------------------------------------------------------------
# Health check (used by Hostinger load-balancer / uptime monitors)
# ---------------------------------------------------------------------------
@app.get("/health", tags=["Health"], include_in_schema=False)
async def health_check():
    db_ok = False
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception as exc:
        log.warning("Health DB check failed: %s", exc)

    return {
        "status": "ok" if db_ok else "degraded",
        "version": app.version,
        "database": "ok" if db_ok else "unreachable",
    }
