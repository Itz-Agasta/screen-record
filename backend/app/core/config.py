"""
app/core/config.py
==================
All runtime configuration is read from environment variables (or a .env
file).  Pydantic's BaseSettings validates types and raises a clear error
on startup if a required value is missing — no silent None surprises.
"""

from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # ── Application ──────────────────────────────────────────────────────
    APP_NAME: str = "NeoNexus AI Interview Copilot"
    DEBUG: bool = False
    SECRET_KEY: str                          # must be set in .env
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 8   # 8 hours for desktop app UX

    # ── Database ─────────────────────────────────────────────────────────
    # Example: postgresql+asyncpg://user:pass@localhost:5432/neonexus
    DATABASE_URL: str
    DB_AUTO_CREATE_ON_STARTUP: bool = True

    # ── CORS ─────────────────────────────────────────────────────────────
    # Comma-separated list parsed into a Python list automatically.
    # Add your admin panel URL(s) here.  "file://" covers Electron in dev.
    CORS_ORIGINS: List[str] = [
        "http://localhost:3001",   # admin panel dev server
        "file://",                 # Electron renderer
    ]

    # ── File storage ─────────────────────────────────────────────────────
    VIDEO_STORAGE_PATH: str = "/var/www/videos"
    MAX_UPLOAD_SIZE_MB: int = 4096            # 4 GB ceiling per upload

    # ── AI / External APIs ───────────────────────────────────────────────
    ANTHROPIC_API_KEY: str | None = None
    OPENAI_API_KEY: str | None = None
    OPENROUTER_API_KEY: str | None = None
    OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1"
    OPENROUTER_SITE_URL: str | None = None
    OPENROUTER_APP_NAME: str = "NeoNexus Copilot"
    OPENROUTER_HTTP_TIMEOUT_SEC: int = 12
    LIVE_RESPONSE_TIMEOUT_SEC: int = 8
    TRANSCRIBE_HTTP_TIMEOUT_SEC: int = 8
    DEEPGRAM_API_KEY: str | None = None

    # Legacy Deepgram options retained for compatibility.
    DEEPGRAM_MODEL: str = "nova-2"
    DEEPGRAM_LANGUAGE: str = "en-US"
    DEEPGRAM_ENCODING: str = "linear16"
    DEEPGRAM_SAMPLE_RATE: int = 16000

    # Claude model used for live Q&A
    LIVE_LLM_PROVIDER: str = "openrouter"  # openrouter | anthropic
    CLAUDE_MODEL: str = "claude-sonnet-4-20250514"
    OPENROUTER_LIVE_MODEL: str = "openai/gpt-4o"
    CLAUDE_MAX_TOKENS: int = 1024

    # GPT model used for post-session summarization
    SUMMARY_LLM_PROVIDER: str = "openrouter"  # openrouter | openai
    OPENAI_SUMMARY_MODEL: str = "gpt-4o-mini"
    OPENROUTER_SUMMARY_MODEL: str = "openai/gpt-4o-mini"
    OPENAI_SUMMARY_MAX_TOKENS: int = 1024

    # ── Pydantic v2 config ────────────────────────────────────────────────
    @field_validator("DATABASE_URL")
    @classmethod
    def validate_database_url(cls, value: str) -> str:
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "DATABASE_URL must use PostgreSQL with asyncpg, e.g. "
                "postgresql+asyncpg://user:pass@host:5432/dbname"
            )
        return value

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[2] / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=True,
    )


@lru_cache
def get_settings() -> Settings:
    """
    Return a cached singleton Settings instance.
    Import this function — not `settings` directly — when you need
    to override settings in tests (use `get_settings.cache_clear()`).
    """
    return Settings()


# Module-level convenience alias used throughout the app.
settings: Settings = get_settings()
