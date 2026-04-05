"""
app/live_ai.py
===============
Session-scoped transcript buffering and lightweight interview-question detection.

This module is intentionally pure-heuristic (no external API calls) so detection
is fast enough for real-time streaming (<5ms on typical short transcript chunks).
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass

QUESTION_STARTERS = (
    "tell me",
    "introduce",
    "introduce yourself",
    "introduce your self",
    "walk me through",
    "describe",
    "explain",
    "what is",
    "what are",
    "what was",
    "what were",
    "what would",
    "what do",
    "who is",
    "who are",
    "who was",
    "how do",
    "how did",
    "how would",
    "how can",
    "how have",
    "why did",
    "why do",
    "why would",
    "can you",
    "could you",
    "have you",
    "do you",
    "did you",
    "where did",
    "when did",
    "give me an example",
    "tell us",
    "share with me",
    "talk me through",
    "take me through",
)

LEADING_FILLERS = (
    "um",
    "uh",
    "okay",
    "ok",
    "alright",
    "right",
    "well",
    "so",
    "hmm",
    "like",
)

MAX_NON_QUESTION_WORDS = 40
SLIDING_WINDOW_WORDS = 15


@dataclass
class _SessionBuffer:
    text: str = ""


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def _append_text(existing: str, segment: str) -> str:
    if not existing:
        return segment
    return f"{existing} {segment}"


def _tail_words(text: str, word_count: int) -> str:
    words = text.split()
    if len(words) <= word_count:
        return text
    return " ".join(words[-word_count:])


def _strip_speaker_prefix(text: str) -> str:
    # Deepgram/Web Speech can prepend labels like "Interviewer:" or "Host -".
    text = re.sub(r"^\s*[a-z ]{2,20}\s*[:\-]\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^\s*(interviewer|host|panelist|question|q)\b\s*[:\-]?\s*", "", text, flags=re.IGNORECASE)
    return text.strip()


def _strip_leading_fillers(text: str) -> str:
    # Remove repeated discourse fillers so sentence-start starter checks stay reliable.
    cleaned = text.strip()
    for _ in range(6):
        nxt = re.sub(
            r"^\s*(um+|uh+|okay|ok|alright|right|well|so+|hmm+|like)\b\s*[,\-:]?\s*",
            "",
            cleaned,
            flags=re.IGNORECASE,
        ).strip()
        if nxt == cleaned:
            break
        cleaned = nxt
    return cleaned


def _sentence_chunks(text: str) -> list[str]:
    # Split on sentence and pause punctuation so we can evaluate sentence starts.
    return [chunk.strip() for chunk in re.split(r"[.!?,]+", text) if chunk.strip()]


def _has_sentence_start_starter(text: str) -> bool:
    for raw_sentence in _sentence_chunks(text):
        sentence = _strip_leading_fillers(_strip_speaker_prefix(raw_sentence)).casefold()
        if not sentence:
            continue
        for starter in QUESTION_STARTERS:
            # Condition #2: starter appears at the beginning of a sentence.
            if sentence.startswith(starter):
                return True
    return False


def _contains_starter_anywhere(text: str) -> bool:
    # STT often emits interviewer prompts with lead-in words such as
    # "he asked", "interviewer asked", or "can you please ...".
    # We accept starter phrases anywhere in the sentence to avoid missing
    # valid interview questions in noisy real-time transcripts.
    lowered = text.casefold()
    for starter in QUESTION_STARTERS:
        if re.search(rf"\b{re.escape(starter)}\b", lowered):
            return True
    return False


def _extract_question_span(text: str) -> str:
    # When STT includes lead-in narration ("interviewer asked..."), keep only
    # the actionable question phrase starting from the earliest known starter.
    normalized = _normalize(text)
    lowered = normalized.casefold()

    best_index: int | None = None
    for starter in QUESTION_STARTERS:
        match = re.search(rf"\b{re.escape(starter)}\b", lowered)
        if not match:
            continue
        idx = match.start()
        if best_index is None or idx < best_index:
            best_index = idx

    if best_index is None:
        return normalized

    extracted = normalized[best_index:].strip(" ,.-")
    return extracted or normalized


async def detect_question(buffer: str) -> bool:
    """
    Return True when buffer is judged to contain a complete interview question.

    Detection rules:
    1) Buffer ends with '?'
    2) A question-starter is at the beginning of any sentence
    3) Buffer ends with '.' or ',' and starter exists earlier in buffer
    """
    text = _normalize(buffer)
    if not text:
        return False

    lowered = _strip_speaker_prefix(text).casefold()

    if lowered.endswith("?"):
        return True

    has_sentence_start_starter = _has_sentence_start_starter(lowered)
    if has_sentence_start_starter:
        return True

    # Fallback: accept starter phrases anywhere in the buffer so prompts like
    # "interviewer asked to introduce yourself" still trigger live response.
    if _contains_starter_anywhere(lowered):
        return True

    if lowered.endswith((".", ",")) and has_sentence_start_starter:
        return True

    return False


class LiveAIQuestionRouter:
    """
    Maintains per-session rolling buffers and emits one complete question at trigger time.

    The key is controlled by the caller (for this project we use user/session identity).
    """

    def __init__(self) -> None:
        self._buffers: dict[str, _SessionBuffer] = {}
        self._lock = asyncio.Lock()

    async def clear(self, session_key: str) -> None:
        async with self._lock:
            self._buffers.pop(session_key, None)

    async def ingest_segment(self, session_key: str, segment: str) -> str | None:
        cleaned_segment = _normalize(segment)
        if not cleaned_segment:
            return None

        async with self._lock:
            buf = self._buffers.get(session_key)
            if buf is None:
                buf = _SessionBuffer()
                self._buffers[session_key] = buf

            # Accumulation phase.
            buf.text = _append_text(buf.text, cleaned_segment)
            buf.text = _normalize(buf.text)

            # Detection phase.
            is_question = await detect_question(buf.text)
            if is_question:
                # Trigger phase: emit full buffer and clear for next question.
                # Feed only the actual question span to the AI while still using
                # full buffered context for detection.
                question_text = _extract_question_span(buf.text)
                buf.text = ""
                return question_text

            # Non-question handling: keep tail window to avoid stale context growth.
            if len(buf.text.split()) > MAX_NON_QUESTION_WORDS:
                buf.text = _tail_words(buf.text, SLIDING_WINDOW_WORDS)

            return None


live_ai_router = LiveAIQuestionRouter()
