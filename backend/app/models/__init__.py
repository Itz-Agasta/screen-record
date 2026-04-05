"""
app/models/__init__.py
=======================
Explicit re-exports ensure that SQLAlchemy's MetaData registry is fully
populated before `Base.metadata.create_all()` runs in main.py.

Import order matters: Admin has no FKs, User references nothing external,
Session references User — so Admin → User → Session.
"""

from app.models.admin import Admin       # noqa: F401
from app.models.user import User         # noqa: F401
from app.models.session import Session   # noqa: F401

__all__ = ["Admin", "User", "Session"]
