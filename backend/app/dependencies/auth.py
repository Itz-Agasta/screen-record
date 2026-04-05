"""
app/dependencies/auth.py
=========================
Reusable FastAPI dependencies for JWT extraction and role guards.

Three dependency tiers:
  get_current_user_payload  — decode JWT, return raw payload dict
  get_current_user          — resolve payload → User ORM row
  get_current_admin         — resolve payload → Admin ORM row

Both REST routes and the WebSocket endpoint use these.  The WS handler
extracts the token from the query-string (browsers can't set WS headers).
"""

import logging
from typing import Annotated

from fastapi import Depends, HTTPException, Query, WebSocket, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_access_token
from app.dependencies.db import get_db
from app.models.admin import Admin
from app.models.user import User

log = logging.getLogger(__name__)

# FastAPI's OAuth2 scheme — extracts Bearer token from Authorization header.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

# ---------------------------------------------------------------------------
# Shared JWT decoder
# ---------------------------------------------------------------------------

async def get_current_user_payload(
    token: Annotated[str, Depends(oauth2_scheme)],
) -> dict:
    """Decode the JWT and return its payload.  Raises 401 on failure."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        return decode_access_token(token)
    except JWTError as exc:
        log.warning("JWT decode failed: %s", exc)
        raise credentials_exception


# ---------------------------------------------------------------------------
# User dependency
# ---------------------------------------------------------------------------

async def get_current_user(
    payload: Annotated[dict, Depends(get_current_user_payload)],
    db: AsyncSession = Depends(get_db),
) -> User:
    """Resolve JWT payload → active User row."""
    if payload.get("role") != "user":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User token required.",
        )
    user_id: str | None = payload.get("sub")
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid token payload.")

    result = await db.execute(select(User).where(User.id == int(user_id)))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or deactivated.",
        )
    return user


# ---------------------------------------------------------------------------
# Admin dependency
# ---------------------------------------------------------------------------

async def get_current_admin(
    payload: Annotated[dict, Depends(get_current_user_payload)],
    db: AsyncSession = Depends(get_db),
) -> Admin:
    """Resolve JWT payload → active Admin row."""
    if payload.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required.",
        )
    admin_id: str | None = payload.get("sub")
    if admin_id is None:
        raise HTTPException(status_code=401, detail="Invalid token payload.")

    result = await db.execute(select(Admin).where(Admin.id == int(admin_id)))
    admin = result.scalar_one_or_none()

    if admin is None or not admin.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin not found or deactivated.",
        )
    return admin


# ---------------------------------------------------------------------------
# WebSocket token extractor
# ---------------------------------------------------------------------------
# WebSocket clients cannot set HTTP headers, so the JWT is passed as a
# query parameter:  wss://host/ws/some-endpoint?token=<jwt>

async def get_ws_user(
    websocket: WebSocket,
    token: str = Query(..., description="JWT Bearer token"),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Validate the JWT from the WS query-string and return the active User.
    Closes the WebSocket with code 4001 on auth failure instead of raising
    an HTTP exception (HTTP exceptions don't work mid-WS handshake).
    """
    try:
        payload = decode_access_token(token)
    except JWTError:
        await websocket.close(code=4001, reason="Invalid or expired token.")
        raise RuntimeError("WS auth failed — connection closed.")

    if payload.get("role") != "user":
        await websocket.close(code=4003, reason="User role required.")
        raise RuntimeError("WS auth failed — wrong role.")

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == int(user_id)))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active:
        await websocket.close(code=4004, reason="User not found or inactive.")
        raise RuntimeError("WS auth failed — user inactive.")

    return user
