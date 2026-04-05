"""
app/models/user.py
===================
End-users of the Electron desktop client.

Key business logic encoded here:
  • permitted_sessions — set by Admin; hard ceiling on billable sessions.
  • used_sessions      — incremented atomically by the WS close handler.
    • resume_text        — injected into AI prompt context at session start.
  • job_description    — injected alongside resume_text.
  • custom_prompt      — admin-authored system prompt override per user.

Session availability is exposed via REST at GET /users/me/session-status.
"""

from datetime import datetime
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    # Avoid circular import at runtime; only used for type hints.
    from app.models.session import Session


class User(Base):
    __tablename__ = "users"

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

    # ── Session accounting ───────────────────────────────────────────────
    # permitted_sessions is set by the Admin when creating / editing a user.
    # used_sessions is incremented inside a SELECT … FOR UPDATE transaction
    # when the WebSocket closes, preventing race conditions if a user somehow
    # opens two simultaneous sessions.
    permitted_sessions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    used_sessions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # ── AI context ───────────────────────────────────────────────────────
    # These are pasted by the Admin into the admin panel. They are loaded
    # once at WS connect time and injected into every AI call during
    # that session — NOT re-fetched per transcript segment (perf).
    resume_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    job_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Per-user override for the AI system prompt.
    custom_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Flags ────────────────────────────────────────────────────────────
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # ── Timestamps ───────────────────────────────────────────────────────
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

    # ── Relationships ────────────────────────────────────────────────────
    sessions: Mapped[List["Session"]] = relationship(
        "Session",
        back_populates="user",
        cascade="all, delete-orphan",
        lazy="selectin",       # async-safe: avoids implicit lazy loads
    )

    # ── Computed helpers ─────────────────────────────────────────────────
    @property
    def sessions_remaining(self) -> int:
        return max(0, self.permitted_sessions - self.used_sessions)

    @property
    def has_sessions_available(self) -> bool:
        return self.used_sessions < self.permitted_sessions

    def __repr__(self) -> str:
        return (
            f"<User id={self.id} username={self.username!r} "
            f"used={self.used_sessions}/{self.permitted_sessions}>"
        )
