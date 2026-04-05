"""
app/routers/auth.py
====================
Authentication endpoints.

POST /auth/login
    Accepts username + password.
    Checks both the admins table and the users table.
    Returns a signed JWT with a ``role`` claim so every subsequent
    request knows which privilege tier made it.

Why a single /login endpoint instead of /admin/login + /user/login:
    The Electron .exe and admin panel both POST to the same URL.
    The role in the JWT response tells the caller which UI to show.
    Keeping one endpoint reduces surface area and avoids password-spray
    attacks having two separate targets to enumerate.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import verify_password, create_access_token
from app.dependencies.db import get_db
from app.models.admin import Admin
from app.models.user import User
from app.schemas import LoginRequest, TokenResponse

log = logging.getLogger(__name__)
router = APIRouter()


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Login for admins and users",
)
async def login(
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """
    Authenticate with username + password.

    Checks admins first, then users.  Returns a JWT with:
      - ``sub``  : str(entity_id)
      - ``role`` : "admin" | "user"
      - ``exp``  : configured expiry
    """
    # ── 1. Try admin table ────────────────────────────────────────────────
    result = await db.execute(
        select(Admin).where(Admin.username == body.username)
    )
    admin = result.scalar_one_or_none()

    if admin and verify_password(body.password, admin.password_hash):
        if not admin.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin account is deactivated.",
            )
        token = create_access_token(subject=admin.id, role="admin")
        log.info("Admin '%s' (id=%d) logged in.", admin.username, admin.id)
        return TokenResponse(
            access_token=token,
            role="admin",
            user_id=admin.id,
        )

    # ── 2. Try user table ─────────────────────────────────────────────────
    result = await db.execute(
        select(User).where(User.username == body.username)
    )
    user = result.scalar_one_or_none()

    if user and verify_password(body.password, user.password_hash):
        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="User account is deactivated. Contact your administrator.",
            )
        token = create_access_token(subject=user.id, role="user")
        log.info("User '%s' (id=%d) logged in.", user.username, user.id)
        return TokenResponse(
            access_token=token,
            role="user",
            user_id=user.id,
        )

    # ── 3. Both failed — return generic 401 (don't leak which was wrong) ─
    log.warning("Failed login attempt for username='%s'.", body.username)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Incorrect username or password.",
        headers={"WWW-Authenticate": "Bearer"},
    )
