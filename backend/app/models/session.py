"""
app/models/session.py
======================
Legacy session model retained for compatibility with existing databases.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
import enum

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.user import User


class SessionStatus(str, enum.Enum):
    """
    Postgres-native ENUM via SQLAlchemy.  Stored as a string so it's
    readable in plain psql queries without joining a lookup table.
    """
    active = "active"
    processing = "processing"
    completed = "completed"
    error = "error"


class Session(Base):
    __tablename__ = "sessions"

    # ── Primary key ──────────────────────────────────────────────────────
    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    # ── Foreign key ──────────────────────────────────────────────────────
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # ── Status ───────────────────────────────────────────────────────────
    status: Mapped[SessionStatus] = mapped_column(
        Enum(SessionStatus, name="session_status"),
        default=SessionStatus.active,
        nullable=False,
        index=True,
    )

    # ── Content ──────────────────────────────────────────────────────────
    # transcript_text is built up in memory during the live session and
    # flushed to this column when the WS closes.  Using TEXT (unbounded)
    # since interviews can run 60-90 minutes.
    transcript_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Written by the GPT-4o-mini background task.
    summary_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relative URL served by FastAPI StaticFiles, e.g. "/videos/42.mp4".
    # Absolute path on VPS is settings.VIDEO_STORAGE_PATH/{id}.mp4.
    video_file_url: Mapped[Optional[str]] = mapped_column(
        String(512), nullable=True
    )

    # File size in bytes — stored for admin display and storage audits.
    video_file_size_bytes: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True
    )

    # ── Duration ─────────────────────────────────────────────────────────
    # Populated from the WS close event (end_time - start_time in seconds).
    duration_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Timestamps ───────────────────────────────────────────────────────
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # ── Relationships ────────────────────────────────────────────────────
    user: Mapped["User"] = relationship("User", back_populates="sessions")

    def __repr__(self) -> str:
        return (
            f"<Session id={self.id} user_id={self.user_id} "
            f"status={self.status.value!r}>"
        )
