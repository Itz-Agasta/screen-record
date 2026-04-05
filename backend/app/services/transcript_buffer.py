"""
TranscriptRingBuffer - Session-scoped transcript storage with dual-purpose access.

This service provides:
1. Full transcript accumulation for end-of-session summarization
2. Fast access to last N lines for real-time help hotkey requests
3. Thread-safe operations for concurrent WebSocket streaming

Design decisions:
- Line-based storage (not time-based) since we need context lines for help
- Stores both rolling buffer (last ~100 lines) and full transcript separately
- Full transcript grows unbounded during session (1hr interview ≈ 3000-5000 lines)
- Ring buffer provides O(1) access to recent context
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional


@dataclass(slots=True)
class TranscriptLine:
    """A single line of transcript with metadata."""
    timestamp: float  # Unix timestamp when received
    speaker: str  # Speaker label (e.g., "speaker-0", "interviewer", "candidate")
    text: str  # Transcript text
    is_final: bool = True  # False for interim results
    confidence: float = 1.0  # STT confidence score


@dataclass
class TranscriptRingBuffer:
    """
    Dual-purpose transcript buffer for interview sessions.
    
    Maintains both:
    - A ring buffer of recent lines (configurable, default 100) for quick context
    - A full transcript list for end-of-session summarization
    
    Thread-safe for concurrent WebSocket streaming and help requests.
    """
    
    max_ring_size: int = 100  # Rolling buffer capacity
    _ring: Deque[TranscriptLine] = field(default_factory=deque)
    _full_transcript: List[TranscriptLine] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _created_at: float = field(default_factory=time.time)
    _last_updated: float = field(default_factory=time.time)
    
    def __post_init__(self) -> None:
        # Ensure ring has maxlen set
        self._ring = deque(maxlen=self.max_ring_size)
    
    async def append(self, line: TranscriptLine) -> None:
        """
        Append a transcript line to both buffers.
        
        For interim results (is_final=False), only update ring buffer.
        For final results, append to both ring and full transcript.
        """
        async with self._lock:
            self._last_updated = time.time()
            
            if line.is_final:
                # Final result: add to both buffers
                self._ring.append(line)
                self._full_transcript.append(line)
            else:
                # Interim result: only update ring (replace last interim if exists)
                if self._ring and not self._ring[-1].is_final:
                    self._ring.pop()
                self._ring.append(line)
    
    async def append_text(
        self,
        text: str,
        speaker: str = "unknown",
        is_final: bool = True,
        confidence: float = 1.0,
    ) -> None:
        """Convenience method to append raw text."""
        line = TranscriptLine(
            timestamp=time.time(),
            speaker=speaker,
            text=text.strip(),
            is_final=is_final,
            confidence=confidence,
        )
        await self.append(line)
    
    async def get_recent_lines(self, count: int = 4) -> List[TranscriptLine]:
        """
        Get the last N lines from the ring buffer.
        
        Used for live help requests - returns last 3-4 lines of context.
        Only returns final results, filters out interim.
        """
        async with self._lock:
            final_lines = [line for line in self._ring if line.is_final]
            return final_lines[-count:] if count < len(final_lines) else final_lines
    
    async def get_recent_text(self, count: int = 4) -> str:
        """
        Get last N lines as formatted text for LLM context.
        
        Format: "[speaker]: text" for each line, newline separated.
        """
        lines = await self.get_recent_lines(count)
        return "\n".join(f"[{line.speaker}]: {line.text}" for line in lines)
    
    async def get_full_transcript(self) -> List[TranscriptLine]:
        """
        Get the complete transcript for summarization.
        
        Returns a copy to prevent mutation during iteration.
        """
        async with self._lock:
            return list(self._full_transcript)
    
    async def get_full_transcript_text(self) -> str:
        """
        Get complete transcript as formatted text.
        
        Format: "[HH:MM:SS] [speaker]: text" for each line.
        """
        lines = await self.get_full_transcript()
        if not lines:
            return ""
        
        # Calculate relative timestamps from session start
        base_time = self._created_at
        
        formatted = []
        for line in lines:
            elapsed = line.timestamp - base_time
            hours = int(elapsed // 3600)
            minutes = int((elapsed % 3600) // 60)
            seconds = int(elapsed % 60)
            timestamp = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
            formatted.append(f"[{timestamp}] [{line.speaker}]: {line.text}")
        
        return "\n".join(formatted)
    
    async def get_transcript_chunks(
        self,
        chunk_duration_seconds: float = 300.0,  # 5 minutes default
    ) -> List[List[TranscriptLine]]:
        """
        Split transcript into time-based chunks for parallel summarization.
        
        Args:
            chunk_duration_seconds: Target duration per chunk (default 5 min)
        
        Returns:
            List of transcript line lists, each covering ~chunk_duration_seconds
        """
        lines = await self.get_full_transcript()
        if not lines:
            return []
        
        chunks: List[List[TranscriptLine]] = []
        current_chunk: List[TranscriptLine] = []
        chunk_start_time = lines[0].timestamp
        
        for line in lines:
            # Check if we should start a new chunk
            if line.timestamp - chunk_start_time >= chunk_duration_seconds and current_chunk:
                chunks.append(current_chunk)
                current_chunk = []
                chunk_start_time = line.timestamp
            
            current_chunk.append(line)
        
        # Don't forget the last chunk
        if current_chunk:
            chunks.append(current_chunk)
        
        return chunks
    
    async def get_stats(self) -> dict:
        """Get buffer statistics for monitoring/debugging."""
        async with self._lock:
            total_lines = len(self._full_transcript)
            ring_lines = len(self._ring)
            duration = self._last_updated - self._created_at
            
            return {
                "total_lines": total_lines,
                "ring_buffer_lines": ring_lines,
                "ring_buffer_capacity": self.max_ring_size,
                "session_duration_seconds": round(duration, 2),
                "created_at": self._created_at,
                "last_updated": self._last_updated,
            }
    
    async def clear(self) -> None:
        """Clear all buffers. Use when session ends or resets."""
        async with self._lock:
            self._ring.clear()
            self._full_transcript.clear()
            self._created_at = time.time()
            self._last_updated = time.time()


class TranscriptBufferRegistry:
    """
    Registry for managing per-session transcript buffers.
    
    Keys are typically session IDs or user IDs depending on your needs.
    Provides automatic cleanup of old sessions.
    """
    
    def __init__(self, max_ring_size: int = 100) -> None:
        self._buffers: dict[str, TranscriptRingBuffer] = {}
        self._lock = asyncio.Lock()
        self._max_ring_size = max_ring_size
    
    async def get_or_create(self, session_id: str) -> TranscriptRingBuffer:
        """Get existing buffer or create new one for session."""
        async with self._lock:
            if session_id not in self._buffers:
                self._buffers[session_id] = TranscriptRingBuffer(
                    max_ring_size=self._max_ring_size
                )
            return self._buffers[session_id]
    
    async def get(self, session_id: str) -> Optional[TranscriptRingBuffer]:
        """Get buffer if exists, None otherwise."""
        async with self._lock:
            return self._buffers.get(session_id)
    
    async def remove(self, session_id: str) -> Optional[TranscriptRingBuffer]:
        """Remove and return buffer for session (for cleanup after summarization)."""
        async with self._lock:
            return self._buffers.pop(session_id, None)
    
    async def list_sessions(self) -> List[str]:
        """List all active session IDs."""
        async with self._lock:
            return list(self._buffers.keys())
    
    async def cleanup_old_sessions(self, max_age_seconds: float = 7200.0) -> int:
        """
        Remove sessions older than max_age_seconds (default 2 hours).
        
        Returns number of sessions cleaned up.
        """
        now = time.time()
        to_remove = []
        
        async with self._lock:
            for session_id, buffer in self._buffers.items():
                stats = await buffer.get_stats()
                if now - stats["last_updated"] > max_age_seconds:
                    to_remove.append(session_id)
            
            for session_id in to_remove:
                del self._buffers[session_id]
        
        return len(to_remove)


# Global registry instance - import this in your routers
transcript_registry = TranscriptBufferRegistry(max_ring_size=100)
