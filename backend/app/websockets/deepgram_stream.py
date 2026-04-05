"""
Deepgram Streaming WebSocket Proxy

Proxies audio from Electron client to Deepgram's real-time API.
- Client sends audio chunks over WebSocket
- Backend forwards to Deepgram (keeps API key secure)
- Deepgram sends back transcripts
- Backend forwards transcripts to client AND stores in ring buffer

This enables:
1. Real-time transcript display in client
2. Hotkey help with context from ring buffer
3. End-of-session summarization from full transcript

Protocol:
- Client → Backend: Binary audio chunks (16-bit PCM or WebM)
- Backend → Client: JSON messages with transcript updates

Connection URL:
  wss://backend/ws/deepgram/stream?token=<jwt>
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, Query
from starlette.websockets import WebSocketState

from app.core.config import settings
from app.dependencies.auth import get_ws_user
from app.dependencies.db import get_db
from app.models.user import User
from app.services.transcript_buffer import transcript_registry, TranscriptLine

log = logging.getLogger(__name__)

router = APIRouter()

# Deepgram WebSocket URL with query params
DEEPGRAM_WS_BASE = "wss://api.deepgram.com/v1/listen"


def _build_deepgram_url() -> str:
    """Build Deepgram WebSocket URL with configured options."""
    params = {
        "model": settings.DEEPGRAM_MODEL,
        "language": settings.DEEPGRAM_LANGUAGE,
        "punctuate": "true",
        "smart_format": "true",
        "interim_results": "true",  # Get real-time updates
        "diarize": "true",  # Speaker detection
    }

    # The desktop app streams MediaRecorder chunks (WebM/Opus). For containerized
    # audio, omitting encoding/sample_rate lets Deepgram auto-detect reliably.
    # If you switch the client to raw PCM bytes in the future, add explicit
    # encoding/sample_rate back.
    query_string = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{DEEPGRAM_WS_BASE}?{query_string}"


async def _parse_deepgram_message(data: dict[str, Any]) -> Optional[TranscriptLine]:
    """
    Parse Deepgram WebSocket message into TranscriptLine.
    
    Deepgram sends:
    - type: "Results" for transcript data
    - channel.alternatives[0].transcript: the text
    - speech_final: true when utterance is complete
    - is_final: true when transcript won't change
    """
    if data.get("type") != "Results":
        return None
    
    channel = data.get("channel") or {}
    alternatives = channel.get("alternatives") or [{}]
    alt = alternatives[0] if alternatives else {}
    
    text = (alt.get("transcript") or "").strip()
    if not text:
        return None
    
    # Extract speaker from diarization
    words = alt.get("words") or []
    speaker = "speaker-0"
    if words and isinstance(words[0], dict):
        speaker_id = words[0].get("speaker")
        if speaker_id is not None:
            speaker = f"speaker-{speaker_id}"
    
    # Confidence score
    confidence = alt.get("confidence", 1.0)
    
    # is_final means transcript won't change
    # speech_final means speaker has paused
    is_final = bool(data.get("is_final", False))
    
    return TranscriptLine(
        timestamp=time.time(),
        speaker=speaker,
        text=text,
        is_final=is_final,
        confidence=confidence,
    )


class DeepgramProxyConnection:
    """
    Manages a single proxied connection between client and Deepgram.
    
    Handles:
    - WebSocket lifecycle
    - Audio forwarding (client → Deepgram)
    - Transcript forwarding (Deepgram → client)
    - Ring buffer storage
    """
    
    def __init__(
        self,
        client_ws: WebSocket,
        user: User,
        session_id: str,
    ) -> None:
        self.client_ws = client_ws
        self.user = user
        self.session_id = session_id
        self._deepgram_ws: Any = None
        self._receive_task: Optional[asyncio.Task] = None
        self._closed = False
    
    async def connect_deepgram(self) -> bool:
        """Establish connection to Deepgram WebSocket."""
        if not settings.DEEPGRAM_API_KEY:
            log.error("DEEPGRAM_API_KEY not configured")
            return False
        
        try:
            import websockets
        except ImportError:
            log.error("websockets package not available")
            return False
        
        url = _build_deepgram_url()
        headers = {"Authorization": f"Token {settings.DEEPGRAM_API_KEY}"}
        
        try:
            connect_kwargs = {
                "ping_interval": 20,
                "ping_timeout": 10,
            }

            # websockets>=14 renamed extra_headers -> additional_headers.
            # Support both to avoid runtime failures across environments.
            try:
                self._deepgram_ws = await websockets.connect(
                    url,
                    additional_headers=headers,
                    **connect_kwargs,
                )
            except TypeError as exc:
                if "additional_headers" not in str(exc):
                    raise
                self._deepgram_ws = await websockets.connect(
                    url,
                    extra_headers=headers,
                    **connect_kwargs,
                )
            log.info(
                "Connected to Deepgram for user_id=%s session=%s",
                self.user.id,
                self.session_id,
            )
            return True
        except Exception as exc:
            log.error("Failed to connect to Deepgram: %s", exc)
            return False
    
    async def start_receiving(self) -> None:
        """Start task to receive and forward Deepgram transcripts."""
        self._receive_task = asyncio.create_task(
            self._receive_loop(),
            name=f"deepgram-receive-{self.session_id}",
        )
    
    async def send_audio(self, audio_chunk: bytes) -> None:
        """Forward audio chunk to Deepgram."""
        if self._deepgram_ws and not self._closed:
            try:
                await self._deepgram_ws.send(audio_chunk)
            except Exception as exc:
                log.warning("Failed to send audio to Deepgram: %s", exc)
    
    async def close(self) -> None:
        """Clean up connections."""
        self._closed = True
        
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None
        
        if self._deepgram_ws:
            try:
                # Send close message to Deepgram
                await self._deepgram_ws.send(json.dumps({"type": "CloseStream"}))
                await self._deepgram_ws.close()
            except Exception:
                pass
            self._deepgram_ws = None
        
        log.info(
            "Closed Deepgram connection for user_id=%s session=%s",
            self.user.id,
            self.session_id,
        )
    
    async def _receive_loop(self) -> None:
        """Receive transcripts from Deepgram and forward to client."""
        if not self._deepgram_ws:
            return
        
        buffer = await transcript_registry.get_or_create(self.session_id)
        
        try:
            async for message in self._deepgram_ws:
                if self._closed:
                    break
                
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                
                # Parse transcript
                line = await _parse_deepgram_message(data)
                
                if line:
                    # Store in ring buffer
                    await buffer.append(line)
                    
                    # Forward to client
                    client_message = {
                        "type": "transcript",
                        "speaker": line.speaker,
                        "text": line.text,
                        "is_final": line.is_final,
                        "confidence": line.confidence,
                        "timestamp": line.timestamp,
                    }
                    
                    if self.client_ws.client_state == WebSocketState.CONNECTED:
                        await self.client_ws.send_json(client_message)
                
                # Forward metadata messages (like speech_started)
                elif data.get("type") in ("Metadata", "SpeechStarted"):
                    if self.client_ws.client_state == WebSocketState.CONNECTED:
                        await self.client_ws.send_json({
                            "type": data.get("type", "").lower(),
                            "data": data,
                        })
        
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Deepgram receive loop error: %s", exc)
            if not self._closed and self.client_ws.client_state == WebSocketState.CONNECTED:
                await self.client_ws.send_json({
                    "type": "error",
                    "message": f"Deepgram connection error: {str(exc)[:100]}",
                })


@router.websocket("/deepgram/stream")
async def deepgram_stream_proxy(
    websocket: WebSocket,
    token: str = Query(..., description="JWT Bearer token"),
    db = Depends(get_db),
):
    """
    WebSocket endpoint for Deepgram audio streaming.
    
    Protocol:
    1. Client connects with JWT token in query param
    2. Server validates auth and connects to Deepgram
    3. Client sends binary audio chunks
    4. Server forwards audio to Deepgram
    5. Server sends JSON transcript updates back to client
    
    Client messages:
    - Binary: Audio chunk to transcribe
    - JSON {"type": "close"}: End stream gracefully
    
    Server messages:
    - {"type": "connected", "session_id": "..."}: Connection established
    - {"type": "transcript", "speaker": "...", "text": "...", "is_final": bool}
    - {"type": "error", "message": "..."}
    - {"type": "closed"}
    """
    # Authenticate
    try:
        user = await get_ws_user(websocket, token, db)
    except RuntimeError:
        # Auth failed, connection already closed by get_ws_user
        return
    
    # Accept the WebSocket
    await websocket.accept()
    
    # Generate session ID
    session_id = f"user:{user.id}:stream:{int(time.time())}"
    
    # Create proxy connection
    proxy = DeepgramProxyConnection(
        client_ws=websocket,
        user=user,
        session_id=session_id,
    )
    
    try:
        # Connect to Deepgram
        if not await proxy.connect_deepgram():
            await websocket.send_json({
                "type": "error",
                "message": "Failed to connect to Deepgram. Check API key configuration.",
            })
            await websocket.close(code=1011, reason="Deepgram connection failed")
            return
        
        # Start receiving transcripts
        await proxy.start_receiving()
        
        # Notify client we're connected
        await websocket.send_json({
            "type": "connected",
            "session_id": session_id,
        })
        
        # Main loop: receive audio from client
        while True:
            try:
                message = await websocket.receive()
                
                if message["type"] == "websocket.disconnect":
                    break
                
                if "bytes" in message:
                    # Binary audio chunk
                    await proxy.send_audio(message["bytes"])
                
                elif "text" in message:
                    # JSON control message
                    try:
                        data = json.loads(message["text"])
                        if data.get("type") == "close":
                            break
                    except json.JSONDecodeError:
                        pass
            
            except WebSocketDisconnect:
                break
    
    finally:
        await proxy.close()
        
        # Send close confirmation if still connected
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                await websocket.send_json({"type": "closed"})
                await websocket.close()
            except Exception:
                pass
        
        log.info(
            "Deepgram stream ended for user_id=%s session=%s",
            user.id,
            session_id,
        )


@router.websocket("/transcript/status")
async def transcript_status(
    websocket: WebSocket,
    token: str = Query(..., description="JWT Bearer token"),
    session_id: str = Query(..., description="Session ID from stream connection"),
    db = Depends(get_db),
):
    """
    WebSocket endpoint to get transcript buffer status.
    
    Useful for debugging and monitoring.
    """
    try:
        user = await get_ws_user(websocket, token, db)
    except RuntimeError:
        return
    
    await websocket.accept()
    
    try:
        buffer = await transcript_registry.get(session_id)
        if not buffer:
            await websocket.send_json({
                "type": "error",
                "message": f"No buffer found for session {session_id}",
            })
            return
        
        stats = await buffer.get_stats()
        await websocket.send_json({
            "type": "status",
            "session_id": session_id,
            "stats": stats,
        })
    
    finally:
        await websocket.close()
