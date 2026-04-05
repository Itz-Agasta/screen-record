# backend/app/websockets/__init__.py
"""
WebSocket endpoints for real-time communication.
"""

from .deepgram_stream import router as deepgram_router

__all__ = ["deepgram_router"]
