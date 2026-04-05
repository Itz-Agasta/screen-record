#!/usr/bin/env python3
"""
backend/scripts/seed_admin.py
==============================
One-shot script to create the first admin account.
Run this ONCE before logging in to the admin panel for the first time.

Usage (from the backend/ directory with venv active):
    python scripts/seed_admin.py

    # Or with custom values:
    ADMIN_USERNAME=myadmin ADMIN_PASSWORD=MyPass123! python scripts/seed_admin.py
"""

import asyncio
import os
import sys

# Make sure we can import from the backend package
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.database import AsyncSessionLocal, engine, Base
from app.models.admin import Admin
from app.models.user import User      # noqa — needed for metadata
from app.models.session import Session  # noqa — needed for metadata
from app.core.security import hash_password
from sqlalchemy import select


async def seed():
    username = os.getenv("ADMIN_USERNAME", "superadmin")
    email    = os.getenv("ADMIN_EMAIL",    "admin@neonexus.io")
    password = os.getenv("ADMIN_PASSWORD", "admin123")

    # Ensure tables exist
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as db:
        # Check if admin already exists
        result = await db.execute(
            select(Admin).where(Admin.username == username)
        )
        existing = result.scalar_one_or_none()

        if existing:
            print(f"[!] Admin '{username}' already exists (id={existing.id}). Skipping.")
            return

        admin = Admin(
            username=username,
            email=email,
            password_hash=hash_password(password),
        )
        db.add(admin)
        await db.commit()
        await db.refresh(admin)

        print(f"[✓] Admin account created:")
        print(f"    Username : {admin.username}")
        print(f"    Email    : {admin.email}")
        print(f"    ID       : {admin.id}")
        print(f"")
        print(f"[!] Log in at http://localhost:3000 and CHANGE THE PASSWORD immediately.")


if __name__ == "__main__":
    asyncio.run(seed())
