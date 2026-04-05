"""
app/core/database.py
=====================
Async SQLAlchemy engine, session factory, and declarative Base.

All DB access in this project is fully async (asyncpg driver).
Never use synchronous Session outside of Alembic env.py.
"""

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
# pool_pre_ping=True — drop stale connections that survived a Postgres restart.
# pool_size / max_overflow — tune for Hostinger VPS RAM; these are conservative.
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,          # log SQL in debug mode only
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)


# ---------------------------------------------------------------------------
# Session factory
# ---------------------------------------------------------------------------
# expire_on_commit=False is required with async sessions: after `await
# session.commit()` SQLAlchemy must NOT try to lazily reload attributes
# (there's no implicit IO in async context).
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


# ---------------------------------------------------------------------------
# Declarative base
# ---------------------------------------------------------------------------
class Base(DeclarativeBase):
    """All ORM models inherit from this base."""
    pass
