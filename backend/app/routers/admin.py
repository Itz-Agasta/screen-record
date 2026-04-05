"""
app/routers/admin.py
=====================
Admin-only endpoints.  Every route requires a valid JWT with role="admin"
(enforced by the ``get_current_admin`` dependency).

Routes
------
POST   /admin/users               — create a new user
GET    /admin/users               — list all users
GET    /admin/users/{user_id}     — get a single user
PATCH  /admin/users/{user_id}     — update user (sessions, resume, JD, prompt)
DELETE /admin/users/{user_id}     — soft-delete (sets is_active=False)

POST   /admin/admins              — create another admin account
GET    /admin/me                  — return current admin profile
"""

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.dependencies.auth import get_current_admin
from app.dependencies.db import get_db
from app.models.admin import Admin
from app.models.user import User
from app.schemas import (
    AdminCreate, AdminOut,
    UserCreate, UserUpdate, UserOut,
)

log = logging.getLogger(__name__)
router = APIRouter()

# Every route in this file requires admin auth — the dependency is injected
# into each handler individually so FastAPI includes it in the OpenAPI spec.
AdminDep = Depends(get_current_admin)


# ---------------------------------------------------------------------------
# Admin self-management
# ---------------------------------------------------------------------------

@router.get(
    "/me",
    response_model=AdminOut,
    summary="Get current admin profile",
)
async def get_admin_me(
    admin: Admin = AdminDep,
) -> Admin:
    return admin


@router.post(
    "/admins",
    response_model=AdminOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new admin account",
)
async def create_admin(
    body: AdminCreate,
    db: AsyncSession = Depends(get_db),
    _admin: Admin = AdminDep,         # auth guard; result unused
) -> Admin:
    # Uniqueness check
    existing = await db.execute(
        select(Admin).where(
            (Admin.username == body.username) | (Admin.email == body.email)
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An admin with that username or email already exists.",
        )

    new_admin = Admin(
        username=body.username,
        email=body.email,
        password_hash=hash_password(body.password),
    )
    db.add(new_admin)
    await db.flush()
    await db.refresh(new_admin)
    log.info("New admin created: '%s' (id=%d).", new_admin.username, new_admin.id)
    return new_admin


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

@router.post(
    "/users",
    response_model=UserOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new end-user",
)
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    _admin: Admin = AdminDep,
) -> User:
    # Uniqueness check
    existing = await db.execute(
        select(User).where(
            (User.username == body.username) | (User.email == body.email)
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with that username or email already exists.",
        )

    user = User(
        username=body.username,
        email=body.email,
        password_hash=hash_password(body.password),
        permitted_sessions=body.permitted_sessions,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    log.info(
        "New user created: '%s' (id=%d) with %d permitted sessions.",
        user.username, user.id, user.permitted_sessions,
    )
    return user


@router.get(
    "/users",
    response_model=List[UserOut],
    summary="List all users",
)
async def list_users(
    db: AsyncSession = Depends(get_db),
    _admin: Admin = AdminDep,
) -> List[User]:
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    return list(result.scalars().all())


@router.get(
    "/users/{user_id}",
    response_model=UserOut,
    summary="Get a single user by ID",
)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: Admin = AdminDep,
) -> User:
    return await _get_user_or_404(db, user_id)


@router.patch(
    "/users/{user_id}",
    response_model=UserOut,
    summary="Update user — sessions, resume, JD, custom prompt, password",
)
async def update_user(
    user_id: int,
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    _admin: Admin = AdminDep,
) -> User:
    """
    PATCH semantics — only supplied fields are updated.

    This is the primary endpoint the admin panel uses to:
      • Set/increase permitted_sessions
      • Paste the candidate's resume
      • Paste the target job description
      • Write a custom system prompt for Claude
      • Reset the user's password
      • Deactivate / reactivate the account
    """
    user = await _get_user_or_404(db, user_id)

    update_data = body.model_dump(exclude_unset=True)

    # Hash new password before storing if provided.
    if "password" in update_data:
        update_data["password_hash"] = hash_password(update_data.pop("password"))

    for field, value in update_data.items():
        setattr(user, field, value)

    await db.flush()
    await db.refresh(user)
    log.info("User id=%d updated: %s", user_id, list(update_data.keys()))
    return user


@router.delete(
    "/users/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Soft-delete a user (sets is_active=False)",
)
async def deactivate_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: Admin = AdminDep,
) -> None:
    """
    Soft-delete: sets is_active=False rather than removing the row.
    The user's sessions and transcripts are preserved for audit purposes.
    To permanently delete, remove the row directly in Postgres.
    """
    user = await _get_user_or_404(db, user_id)
    user.is_active = False
    await db.flush()
    log.info("User id=%d deactivated.", user_id)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

async def _get_user_or_404(db: AsyncSession, user_id: int) -> User:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with id={user_id} not found.",
        )
    return user
