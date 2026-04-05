"""
app/dependencies/db.py
=======================
FastAPI dependency that yields an AsyncSession and guarantees
commit-on-success / rollback-on-exception semantics.
"""

from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Yield a database session for the duration of one request.

    Usage in a route:
        async def my_route(db: AsyncSession = Depends(get_db)): ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
