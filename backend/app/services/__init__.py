"""
Backend services module.

Contains business logic services that are used across routers.
"""

from .transcript_buffer import (
    TranscriptLine,
    TranscriptRingBuffer,
    TranscriptBufferRegistry,
    transcript_registry,
)
from .summarizer import (
    ChunkSummary,
    SessionSummary,
    summarize_chunk,
    create_meta_summary,
    summarize_session,
    quick_summary_from_lines,
)

__all__ = [
    # Transcript buffer
    "TranscriptLine",
    "TranscriptRingBuffer",
    "TranscriptBufferRegistry",
    "transcript_registry",
    # Summarizer
    "ChunkSummary",
    "SessionSummary",
    "summarize_chunk",
    "create_meta_summary",
    "summarize_session",
    "quick_summary_from_lines",
]
