"""
app/core/security.py
=====================
Password hashing (bcrypt) and JWT creation / verification.
Keep this module free of DB imports to avoid circular dependencies.
"""

from datetime import datetime, timedelta, timezone
import logging
from typing import Any, Union

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    """Return bcrypt hash of *plain* password."""
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if *plain* matches *hashed*."""
    try:
        return pwd_context.verify(plain, hashed)
    except (ValueError, RuntimeError) as exc:
        # Some bcrypt/passlib version combinations can raise backend errors
        # during verification. Treat as non-match instead of crashing login.
        log.warning("Password verification backend error: %s", exc)
        return False


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------
def create_access_token(
    subject: Union[str, Any],
    role: str,
    expires_delta: timedelta | None = None,
) -> str:
    """
    Create a signed JWT.

    Parameters
    ----------
    subject:
        Typically the user's integer ID as a string.
    role:
        Either ``"admin"`` or ``"user"``.  Stored in the ``role`` claim so
        dependencies can enforce endpoint-level access control without an
        extra DB query.
    expires_delta:
        Override the default expiry (ACCESS_TOKEN_EXPIRE_MINUTES).
    """
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    payload = {
        "sub": str(subject),
        "role": role,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> dict:
    """
    Decode and verify a JWT.  Raises ``JWTError`` on failure.

    Returns the raw payload dict — callers extract ``sub`` and ``role``.
    """
    return jwt.decode(
        token,
        settings.SECRET_KEY,
        algorithms=[settings.ALGORITHM],
    )
