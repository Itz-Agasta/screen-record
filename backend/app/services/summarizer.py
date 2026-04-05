"""
Chunked Hierarchical Summarization Service

Handles long interview transcripts (1hr+) by:
1. Splitting transcript into time-based chunks (default 5 min each)
2. Summarizing each chunk in parallel (cost-effective with gpt-4o-mini)
3. Creating a meta-summary from chunk summaries
4. Optionally extracting key questions and topics

This approach avoids:
- Overwhelming the LLM with massive context
- Hitting token limits on long interviews
- High costs from processing full transcripts with expensive models
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, List, Optional

from app.core.config import settings
from app.services.transcript_buffer import TranscriptLine, TranscriptRingBuffer

log = logging.getLogger(__name__)


@dataclass
class ChunkSummary:
    """Summary of a single transcript chunk."""
    chunk_index: int
    start_time: str  # HH:MM:SS format
    end_time: str  # HH:MM:SS format
    summary: str
    key_questions: List[str]
    key_topics: List[str]
    line_count: int


@dataclass
class SessionSummary:
    """Complete session summary with hierarchical data."""
    meta_summary: str
    chunk_summaries: List[ChunkSummary]
    total_duration_seconds: float
    total_lines: int
    key_questions: List[str]
    key_topics: List[str]
    processing_time_seconds: float


def _openrouter_headers() -> dict[str, str]:
    """Build OpenRouter-specific headers."""
    headers: dict[str, str] = {}
    if settings.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = settings.OPENROUTER_SITE_URL
    if settings.OPENROUTER_APP_NAME:
        headers["X-Title"] = settings.OPENROUTER_APP_NAME
    return headers


async def _openrouter_chat_completion(
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 500,
    timeout_sec: int = 30,
    temperature: float = 0.2,
) -> str:
    """Make a chat completion request to OpenRouter."""
    if not settings.OPENROUTER_API_KEY:
        return ""

    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    body = json.dumps(payload).encode("utf-8")

    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    headers.update(_openrouter_headers())

    req = urllib.request.Request(
        f"{settings.OPENROUTER_BASE_URL.rstrip('/')}/chat/completions",
        data=body,
        headers=headers,
        method="POST",
    )

    def _call() -> dict[str, Any]:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8", errors="ignore"))

    try:
        result = await asyncio.to_thread(_call)
    except urllib.error.HTTPError as exc:
        try:
            err_text = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            err_text = str(exc)
        raise RuntimeError(f"OpenRouter HTTP {exc.code}: {err_text[:240]}") from exc

    choice = ((result.get("choices") or [{}])[0] or {})
    message = choice.get("message") or {}
    content = message.get("content")
    
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        chunks = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                chunks.append(item["text"].strip())
        return "\n".join(chunks).strip()
    return ""


def _format_timestamp(seconds: float) -> str:
    """Format seconds as HH:MM:SS."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _format_chunk_for_llm(lines: List[TranscriptLine], base_time: float) -> str:
    """Format a chunk of transcript lines for LLM processing."""
    formatted = []
    for line in lines:
        elapsed = line.timestamp - base_time
        timestamp = _format_timestamp(elapsed)
        formatted.append(f"[{timestamp}] [{line.speaker}]: {line.text}")
    return "\n".join(formatted)


CHUNK_SUMMARY_SYSTEM_PROMPT = """You are an interview transcript analyzer. Given a chunk of interview transcript, provide:

1. A concise 2-3 sentence summary of what happened in this segment
2. List of key questions asked (if any) - extract exact questions
3. List of main topics discussed

Respond in JSON format:
{
    "summary": "...",
    "key_questions": ["question1", "question2"],
    "key_topics": ["topic1", "topic2"]
}

Focus only on what's explicitly in the transcript. Do not invent content."""


META_SUMMARY_SYSTEM_PROMPT = """You are an interview summary expert. Given summaries of individual chunks from an interview session, create a comprehensive final summary.

Include:
1. Overall interview flow and structure
2. Main topics covered
3. Key questions and how the candidate responded (if visible)
4. Notable moments or highlights
5. Assessment of interview coverage/depth

Be factual - only include what's supported by the chunk summaries. If information is insufficient, say so.

Format:
## Interview Summary
[2-3 paragraph overview]

## Key Topics Covered
- Topic 1
- Topic 2
...

## Notable Questions
- Question 1
- Question 2
...

## Observations
[Any notable patterns or observations]"""


async def summarize_chunk(
    lines: List[TranscriptLine],
    chunk_index: int,
    base_time: float,
    model: str = "openai/gpt-4o-mini",
) -> ChunkSummary:
    """Summarize a single chunk of transcript."""
    if not lines:
        return ChunkSummary(
            chunk_index=chunk_index,
            start_time="00:00:00",
            end_time="00:00:00",
            summary="Empty chunk",
            key_questions=[],
            key_topics=[],
            line_count=0,
        )
    
    start_time = _format_timestamp(lines[0].timestamp - base_time)
    end_time = _format_timestamp(lines[-1].timestamp - base_time)
    
    # Format transcript for LLM
    transcript_text = _format_chunk_for_llm(lines, base_time)
    
    # Truncate if too long (keep ~8000 chars to stay well under token limits)
    if len(transcript_text) > 8000:
        transcript_text = transcript_text[:8000] + "\n[... truncated ...]"
    
    messages = [
        {"role": "system", "content": CHUNK_SUMMARY_SYSTEM_PROMPT},
        {"role": "user", "content": f"Transcript chunk {chunk_index + 1}:\n\n{transcript_text}"},
    ]
    
    try:
        response = await _openrouter_chat_completion(
            model=model,
            messages=messages,
            max_tokens=400,
            timeout_sec=20,
        )
        
        # Parse JSON response
        # Try to extract JSON from the response (handle markdown code blocks)
        json_match = re.search(r'```(?:json)?\s*(.*?)\s*```', response, re.DOTALL)
        if json_match:
            response = json_match.group(1)
        
        data = json.loads(response)
        
        return ChunkSummary(
            chunk_index=chunk_index,
            start_time=start_time,
            end_time=end_time,
            summary=data.get("summary", ""),
            key_questions=data.get("key_questions", [])[:5],  # Limit to 5
            key_topics=data.get("key_topics", [])[:5],
            line_count=len(lines),
        )
    except json.JSONDecodeError:
        # Fallback: use raw response as summary
        return ChunkSummary(
            chunk_index=chunk_index,
            start_time=start_time,
            end_time=end_time,
            summary=response[:500] if response else "Unable to summarize chunk",
            key_questions=[],
            key_topics=[],
            line_count=len(lines),
        )
    except Exception as exc:
        log.warning("Chunk %d summarization failed: %s", chunk_index, exc)
        return ChunkSummary(
            chunk_index=chunk_index,
            start_time=start_time,
            end_time=end_time,
            summary=f"Chunk summarization failed: {str(exc)[:100]}",
            key_questions=[],
            key_topics=[],
            line_count=len(lines),
        )


async def create_meta_summary(
    chunk_summaries: List[ChunkSummary],
    job_name: Optional[str] = None,
    model: str = "openai/gpt-4o-mini",
) -> str:
    """Create a meta-summary from individual chunk summaries."""
    if not chunk_summaries:
        return "No transcript data available for summarization."
    
    # Build input from chunk summaries
    chunks_text = []
    for cs in chunk_summaries:
        chunk_info = f"**Segment {cs.chunk_index + 1}** ({cs.start_time} - {cs.end_time}):\n"
        chunk_info += f"Summary: {cs.summary}\n"
        if cs.key_questions:
            chunk_info += f"Questions: {', '.join(cs.key_questions)}\n"
        if cs.key_topics:
            chunk_info += f"Topics: {', '.join(cs.key_topics)}\n"
        chunks_text.append(chunk_info)
    
    combined = "\n\n".join(chunks_text)
    
    # Truncate if too long
    if len(combined) > 12000:
        combined = combined[:12000] + "\n[... additional segments truncated ...]"
    
    context = f"Interview for: {job_name}\n\n" if job_name else ""
    
    messages = [
        {"role": "system", "content": META_SUMMARY_SYSTEM_PROMPT},
        {"role": "user", "content": f"{context}Segment summaries:\n\n{combined}"},
    ]
    
    try:
        response = await _openrouter_chat_completion(
            model=model,
            messages=messages,
            max_tokens=800,
            timeout_sec=30,
        )
        return response if response else "Unable to generate meta-summary."
    except Exception as exc:
        log.warning("Meta-summary generation failed: %s", exc)
        # Fallback: concatenate chunk summaries
        fallback = f"## Interview Summary for {job_name or 'Session'}\n\n"
        for cs in chunk_summaries:
            fallback += f"**{cs.start_time} - {cs.end_time}**: {cs.summary}\n\n"
        return fallback


async def summarize_session(
    buffer: TranscriptRingBuffer,
    job_name: Optional[str] = None,
    chunk_duration_seconds: float = 300.0,  # 5 minutes
    model: str = "openai/gpt-4o-mini",
    max_parallel_chunks: int = 5,
) -> SessionSummary:
    """
    Generate a hierarchical summary of the entire session.
    
    Pipeline:
    1. Get transcript chunks from buffer (time-based splitting)
    2. Summarize chunks in parallel (with concurrency limit)
    3. Generate meta-summary from chunk summaries
    4. Aggregate key questions and topics
    
    Args:
        buffer: TranscriptRingBuffer with session data
        job_name: Optional job/interview name for context
        chunk_duration_seconds: Target duration per chunk (default 5 min)
        model: LLM model to use (default gpt-4o-mini for cost efficiency)
        max_parallel_chunks: Max chunks to process in parallel
    
    Returns:
        SessionSummary with hierarchical data
    """
    start_time = time.time()
    
    # Get chunks from buffer
    chunks = await buffer.get_transcript_chunks(chunk_duration_seconds)
    stats = await buffer.get_stats()
    
    if not chunks:
        return SessionSummary(
            meta_summary="No transcript data captured during this session.",
            chunk_summaries=[],
            total_duration_seconds=stats.get("session_duration_seconds", 0),
            total_lines=0,
            key_questions=[],
            key_topics=[],
            processing_time_seconds=time.time() - start_time,
        )
    
    base_time = stats.get("created_at", time.time())
    
    # Summarize chunks in parallel with concurrency limit
    semaphore = asyncio.Semaphore(max_parallel_chunks)
    
    async def summarize_with_limit(lines: List[TranscriptLine], idx: int) -> ChunkSummary:
        async with semaphore:
            return await summarize_chunk(lines, idx, base_time, model)
    
    # Create tasks for all chunks
    tasks = [
        summarize_with_limit(chunk_lines, idx)
        for idx, chunk_lines in enumerate(chunks)
    ]
    
    # Run all chunk summaries in parallel
    chunk_summaries = await asyncio.gather(*tasks)
    
    # Generate meta-summary
    meta_summary = await create_meta_summary(chunk_summaries, job_name, model)
    
    # Aggregate key questions and topics (deduplicate)
    all_questions = []
    all_topics = []
    seen_questions = set()
    seen_topics = set()
    
    for cs in chunk_summaries:
        for q in cs.key_questions:
            q_lower = q.lower().strip()
            if q_lower not in seen_questions:
                seen_questions.add(q_lower)
                all_questions.append(q)
        for t in cs.key_topics:
            t_lower = t.lower().strip()
            if t_lower not in seen_topics:
                seen_topics.add(t_lower)
                all_topics.append(t)
    
    return SessionSummary(
        meta_summary=meta_summary,
        chunk_summaries=chunk_summaries,
        total_duration_seconds=stats.get("session_duration_seconds", 0),
        total_lines=stats.get("total_lines", 0),
        key_questions=all_questions[:20],  # Limit to top 20
        key_topics=all_topics[:15],  # Limit to top 15
        processing_time_seconds=time.time() - start_time,
    )


async def quick_summary_from_lines(
    lines: List[str],
    job_name: Optional[str] = None,
    model: str = "openai/gpt-4o-mini",
) -> str:
    """
    Quick summary for short transcripts (under 200 lines).
    
    Bypasses chunking for efficiency on short sessions.
    Compatible with existing transcript format (list of strings).
    """
    if not lines:
        return "Session ended. No transcript was captured."
    
    joined = "\n".join(lines[-200:])
    
    messages = [
        {
            "role": "system",
            "content": (
                "Generate a concise interview summary strictly grounded in the provided transcript. "
                "Do not invent questions, answers, or candidate behavior. "
                "If transcript evidence is weak, explicitly say evidence was insufficient."
            ),
        },
        {
            "role": "user",
            "content": f"Job: {job_name or 'Interview'}\n\nTranscript:\n{joined[:12000]}",
        },
    ]
    
    try:
        return await _openrouter_chat_completion(
            model=model,
            messages=messages,
            max_tokens=500,
            timeout_sec=30,
        )
    except Exception as exc:
        log.warning("Quick summary generation failed: %s", exc)
        # Fallback
        question_lines = [line for line in lines if "?" in line]
        highlights = "\n".join(f"- {q}" for q in question_lines[:8]) or "- No clear questions detected"
        return (
            f"Session summary for {job_name or 'Interview'}:\n"
            f"- Total transcript lines: {len(lines)}\n"
            f"- Questions detected: {len(question_lines)}\n"
            "Key questions:\n"
            f"{highlights}"
        )
