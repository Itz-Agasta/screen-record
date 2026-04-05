"""
app/models/admin.py
====================
Admin accounts can log in to the admin panel and manage Users.
Kept deliberately separate from User so the two roles never share a table
— avoids privilege-escalation mistakes at the ORM level.
"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Admin(Base):
    __tablename__ = "admins"

    # ── Primary key ──────────────────────────────────────────────────────
    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    # ── Identity ─────────────────────────────────────────────────────────
    username: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(
        String(254), unique=True, nullable=False, index=True
    )
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)

    # ── Flags ────────────────────────────────────────────────────────────
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # ── Timestamps ───────────────────────────────────────────────────────
    # server_default makes Postgres fill this on INSERT with no Python overhead.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<Admin id={self.id} username={self.username!r}>"
