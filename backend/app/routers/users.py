"""
app/routers/users.py
=====================
User-facing endpoints consumed by the Electron .exe.

Routes
------
GET /users/me                  — full profile of the authenticated user
GET /users/me/session-status   — lightweight session capacity summary

The session-status endpoint returns only the fields needed for lightweight
capacity indicators in client UIs.
"""

import json
import logging
import re
import base64
import io
import asyncio
import time
import urllib.request
import urllib.parse
import urllib.error
from typing import Any

from fastapi import APIRouter, Depends
from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import get_current_user
from app.dependencies.db import get_db
from app.models.user import User
from intelligence.main import (
    SessionRuntimeRegistry,
    build_master_from_env,
    MasterLLM,
    SessionOrchestratorRuntime,
    BouncerModel,
    TranscriptBuffer,
)
from app.services.transcript_buffer import transcript_registry
from app.services.summarizer import summarize_session, quick_summary_from_lines
from app.schemas import (
    UserOut,
    UserSessionStatus,
    SessionStartResponse,
    SessionRespondRequest,
    SessionRespondResponse,
    SessionTranscribeRequest,
    SessionTranscribeResponse,
    SessionEndRequest,
    SessionEndResponse,
    SessionHelpRequest,
    SessionHelpResponse,
)

log = logging.getLogger(__name__)
router = APIRouter()

_live_bouncer = BouncerModel()
_live_master: MasterLLM | None = None


def _get_live_master() -> MasterLLM:
    global _live_master
    if _live_master is None:
        try:
            _live_master = build_master_from_env()
        except Exception as exc:
            log.warning("Falling back to mock live master due to init failure: %s", exc)
            _live_master = MasterLLM(
                model=settings.OPENROUTER_LIVE_MODEL,
                api_key=None,
                base_url=settings.OPENROUTER_BASE_URL,
                app_name=settings.OPENROUTER_APP_NAME,
                site_url=settings.OPENROUTER_SITE_URL,
                use_mock=True,
            )
    return _live_master


def _build_session_runtime() -> SessionOrchestratorRuntime:
    return SessionOrchestratorRuntime(
        buffer=TranscriptBuffer(window_seconds=25.0),
        bouncer=_live_bouncer,
        master=_get_live_master(),
        cooldown_sec=6.0,
    )


live_runtime_registry = SessionRuntimeRegistry(_build_session_runtime)

QUESTION_PREFIXES = (
    "who", "what", "when", "where", "why", "how", "can", "could",
    "would", "should", "is", "are", "do", "does", "did", "will",
    "tell", "describe", "explain", "share", "discuss", "walk", "talk", "give",
)

LIVE_ASSISTANT_SYSTEM_PROMPT = (
    "You are an expert interview copilot. The user is in a live interview and needs a concise, "
    "well-structured answer they can speak naturally.\n\n"
    "Rules:\n"
    "- Give a clear, direct answer to the question asked.\n"
    "- Use natural spoken language — write as if the candidate is speaking.\n"
    "- Include a brief definition or core concept first, then a practical example.\n"
    "- Mention trade-offs, pros/cons, or key considerations where relevant.\n"
    "- Keep it concise (3-5 short paragraphs or bullet points max).\n"
    "- Use bold for key technical terms to make them easy to scan.\n"
    "- Do NOT use filler like 'Here's a good answer' or 'You could say'.\n"
    "- If the input is not a clear question, still provide a helpful response based on context.\n"
    "- Ground your answer in the provided resume and job description context."
)


def _openrouter_headers() -> dict[str, str]:
    headers: dict[str, str] = {}
    if settings.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = settings.OPENROUTER_SITE_URL
    if settings.OPENROUTER_APP_NAME:
        headers["X-Title"] = settings.OPENROUTER_APP_NAME
    return headers


def _extract_message_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    chunks.append(text.strip())
        return "\n".join(chunks).strip()
    return ""


def _normalize_micro_response(answer: str) -> str:
    text = (answer or "").strip()
    if not text:
        return "[STANDBY]"
    if text == "[STANDBY]":
        return text

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    bullets = [line for line in lines if line.startswith(("-", "*", "•"))]

    if not bullets:
        # Convert compact prose into bullet lines when model drifts.
        chunks = [chunk.strip() for chunk in re.split(r"(?<=[.!?])\s+", text) if chunk.strip()]
        bullets = [f"- {chunk}" for chunk in chunks]

    normalized: list[str] = []
    for raw in bullets[:3]:
        line = raw
        if not line.startswith("-"):
            line = f"- {line.lstrip('*• ').strip()}"
        words = line.split()
        if len(words) > 15:
            line = " ".join(words[:15])
        normalized.append(line)

    return "\n".join(normalized) if normalized else "[STANDBY]"


def _format_orchestrator_answer(lines: list[str]) -> str:
    cleaned = [line.strip() for line in lines if isinstance(line, str) and line.strip()]
    if not cleaned:
        return ""

    normalized: list[str] = []
    for line in cleaned[:3]:
        if line.startswith(("-", "*", "•")):
            normalized.append(f"- {line.lstrip('-*• ').strip()}")
        else:
            normalized.append(f"- {line}")
    return "\n".join(normalized)


def _build_rag_context(user: User, plan: dict[str, Any] | None) -> str:
    job_name = (plan or {}).get("job_name") or "this interview"
    resume_text = ((plan or {}).get("resume_text") or user.resume_text or "").strip()
    job_description = ((plan or {}).get("job_description") or user.job_description or "").strip()
    custom_prompt = ((plan or {}).get("prompt") or "").strip()
    return (
        f"Interview Job: {job_name}\n"
        f"Resume Context:\n{resume_text[:3000]}\n\n"
        f"Job Description:\n{job_description[:3000]}\n\n"
        f"Admin Prompt:\n{custom_prompt[:2000]}"
    )


def _fallback_live_answer(question: str, user: User, plan: dict[str, Any] | None) -> str:
    """Produce a deterministic live response when model output is [STANDBY]."""
    q = (question or "").strip().casefold()
    resume_text = ((plan or {}).get("resume_text") or user.resume_text or "").strip()
    job_name = ((plan or {}).get("job_name") or "the role").strip()

    if any(token in q for token in ("introduce", "tell me about yourself", "about yourself")):
        first_line = next((ln.strip() for ln in re.split(r"[\n\.]+", resume_text) if ln.strip()), "")
        if first_line:
            return (
                f"- I am applying for **{job_name}**.\n"
                f"- Background: {first_line[:110]}.\n"
                "- I can map my skills directly to this role."
            )
        return (
            f"- I am applying for **{job_name}**.\n"
            "- I focus on backend engineering and practical delivery.\n"
            "- I can share a relevant project example next."
        )

    what_is_match = re.search(r"\bwhat is\s+([a-z0-9\-\s]{2,40})", q)
    if what_is_match:
        topic = what_is_match.group(1).strip(" .,!?")
        return (
            f"- **{topic.title()}** is a core concept in software engineering.\n"
            "- It helps improve correctness, maintainability, and design quality.\n"
            "- I can explain it with a practical example."
        )

    return (
        "- I captured your question and can answer it directly.\n"
        "- I will keep the response concise and role-relevant.\n"
        "- Ask for more detail and I will expand with examples."
    )


async def _openrouter_chat_completion(
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 400,
    timeout_sec: int | None = None,
) -> str:
    if not settings.OPENROUTER_API_KEY:
        return ""

    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.2,
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
        with urllib.request.urlopen(req, timeout=timeout_sec or settings.OPENROUTER_HTTP_TIMEOUT_SEC) as resp:  # noqa: S310
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
    return _extract_message_text(message.get("content"))


def _chat_client_and_model(provider: str) -> tuple[AsyncOpenAI | None, str | None]:
    p = (provider or "").strip().lower()

    if p == "openrouter" and settings.OPENROUTER_API_KEY:
        try:
            return (
                AsyncOpenAI(
                    api_key=settings.OPENROUTER_API_KEY,
                    base_url=settings.OPENROUTER_BASE_URL,
                    default_headers=_openrouter_headers(),
                ),
                settings.OPENROUTER_LIVE_MODEL,
            )
        except Exception as exc:
            log.warning("OpenRouter client init failed: %s", exc)

    if p == "openai" and settings.OPENAI_API_KEY:
        try:
            return (AsyncOpenAI(api_key=settings.OPENAI_API_KEY), settings.OPENAI_SUMMARY_MODEL)
        except Exception as exc:
            log.warning("OpenAI client init failed: %s", exc)

    # Fallback order: OpenRouter, then OpenAI.
    if settings.OPENROUTER_API_KEY:
        try:
            return (
                AsyncOpenAI(
                    api_key=settings.OPENROUTER_API_KEY,
                    base_url=settings.OPENROUTER_BASE_URL,
                    default_headers=_openrouter_headers(),
                ),
                settings.OPENROUTER_LIVE_MODEL,
            )
        except Exception as exc:
            log.warning("OpenRouter fallback client init failed: %s", exc)
    if settings.OPENAI_API_KEY:
        try:
            return (AsyncOpenAI(api_key=settings.OPENAI_API_KEY), settings.OPENAI_SUMMARY_MODEL)
        except Exception as exc:
            log.warning("OpenAI fallback client init failed: %s", exc)

    return None, None


def _summary_client_and_model() -> tuple[AsyncOpenAI | None, str | None]:
    p = (settings.SUMMARY_LLM_PROVIDER or "").strip().lower()

    if p == "openrouter" and settings.OPENROUTER_API_KEY:
        try:
            return (
                AsyncOpenAI(
                    api_key=settings.OPENROUTER_API_KEY,
                    base_url=settings.OPENROUTER_BASE_URL,
                    default_headers=_openrouter_headers(),
                ),
                settings.OPENROUTER_SUMMARY_MODEL,
            )
        except Exception as exc:
            log.warning("OpenRouter summary client init failed: %s", exc)

    if p == "openai" and settings.OPENAI_API_KEY:
        try:
            return (AsyncOpenAI(api_key=settings.OPENAI_API_KEY), settings.OPENAI_SUMMARY_MODEL)
        except Exception as exc:
            log.warning("OpenAI summary client init failed: %s", exc)

    # Fallback order: OpenRouter, then OpenAI.
    if settings.OPENROUTER_API_KEY:
        try:
            return (
                AsyncOpenAI(
                    api_key=settings.OPENROUTER_API_KEY,
                    base_url=settings.OPENROUTER_BASE_URL,
                    default_headers=_openrouter_headers(),
                ),
                settings.OPENROUTER_SUMMARY_MODEL,
            )
        except Exception as exc:
            log.warning("OpenRouter summary fallback client init failed: %s", exc)
    if settings.OPENAI_API_KEY:
        try:
            return (AsyncOpenAI(api_key=settings.OPENAI_API_KEY), settings.OPENAI_SUMMARY_MODEL)
        except Exception as exc:
            log.warning("OpenAI summary fallback client init failed: %s", exc)

    return None, None


def _parse_config(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if parsed.get("version") != 1 or not isinstance(parsed.get("session_plans"), list):
            return None
        return parsed
    except Exception:
        return None


def _get_active_permitted_plan(config: dict[str, Any] | None) -> tuple[int | None, dict[str, Any] | None]:
    if not config:
        return None, None

    plans = config.get("session_plans") or []
    active_slot = config.get("active_session_slot")

    if isinstance(active_slot, int):
        for idx, plan in enumerate(plans, start=1):
            slot = plan.get("slot") if isinstance(plan, dict) else idx
            state = plan.get("state") if isinstance(plan, dict) else None
            if slot == active_slot and state == "permitted":
                return slot, plan

    for idx, plan in enumerate(plans, start=1):
        if isinstance(plan, dict) and plan.get("state") == "permitted":
            return (plan.get("slot") if isinstance(plan.get("slot"), int) else idx), plan

    return None, None


def _is_question(text: str) -> bool:
    t = text.strip().lower()
    if not t:
        return False
    words = re.findall(r"[a-zA-Z]+", t)
    if len(words) < 3:
        return False
    if "?" in t:
        return True
    return t.startswith(QUESTION_PREFIXES)


def _strip_speaker_prefix(text: str) -> str:
    # Handles common transcript labels such as "Interviewer:" or "Candidate:".
    cleaned = re.sub(r"^\s*[A-Za-z ]{2,20}:\s*", "", text).strip()
    cleaned = re.sub(
        r"^\s*(interviewer|host|panelist|question|q)\b\s*[-:]?\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    ).strip()
    return cleaned


def _trim_filler_prefix(text: str) -> str:
    # Removes repeated conversational fillers and role markers so question cues are detectable.
    cleaned = text
    for _ in range(6):
        nxt = re.sub(
            r"^\s*(um+|uh+|so+|okay|ok|alright|right|well|hmm|like|interviewer|host|panelist|question|q)\b\s*[:,-]?\s*",
            "",
            cleaned,
            flags=re.IGNORECASE,
        ).strip()
        if nxt == cleaned:
            break
        cleaned = nxt
    return cleaned


def _detect_question_text(utterance: str, history: list[str]) -> str | None:
    # Build a small rolling window so fragmented transcript chunks can form one full question.
    window = [h.strip() for h in history[-6:] if isinstance(h, str) and h.strip()]
    if utterance and utterance.strip():
        window.append(utterance.strip())

    if not window:
        return None

    cleaned = [_trim_filler_prefix(_strip_speaker_prefix(line)) for line in window]
    merged = " ".join(cleaned)
    merged = re.sub(r"\s+", " ", merged).strip()

    # Prefer explicit question-mark spans and use the last one as the most recent question.
    qmark_matches = re.findall(r"([^?]{5,}\?)", merged)
    if qmark_matches:
        candidate = qmark_matches[-1].strip()
        if _is_question(candidate):
            return candidate

    # Fallback: scan latest lines for imperative/question-intent prefixes.
    for line in reversed(cleaned):
        if _is_question(line):
            return line.strip()

    # Additional intent cues when punctuation is missing from noisy STT.
    cue_patterns = (
        r"\bcan you\b",
        r"\bcould you\b",
        r"\bwould you\b",
        r"\bhow (do|would|can) you\b",
        r"\bwhat (is|are|would|do)\b",
        r"\bwhy\b",
        r"\bexplain\b",
        r"\btell me\b",
        r"\bwalk me\b",
        r"\bdescribe\b",
    )
    for line in reversed(cleaned):
        low = line.lower().strip()
        if any(re.search(pattern, low) for pattern in cue_patterns) and len(low.split()) >= 4:
            return line.strip()

    return None


async def _generate_answer(question: str, user: User, plan: dict[str, Any] | None, history: list[str]) -> str:
    job_name = (plan or {}).get("job_name") or "this interview"
    resume_text = (plan or {}).get("resume_text") or user.resume_text or ""
    job_description = (plan or {}).get("job_description") or user.job_description or ""
    custom_prompt = (plan or {}).get("prompt") or ""

    messages = [
        {
            "role": "system",
            "content": LIVE_ASSISTANT_SYSTEM_PROMPT,
        },
        {
            "role": "system",
            "content": (
                f"Interview Job: {job_name}\n"
                f"Resume Context:\n{resume_text[:3000]}\n\n"
                f"Job Description:\n{job_description[:3000]}\n\n"
                f"Admin Prompt:\n{custom_prompt[:2000]}"
            ),
        },
    ]

    if history:
        messages.append({
            "role": "system",
            "content": "Recent conversation:\n" + "\n".join(history[-10:]),
        })

    messages.append({
        "role": "user",
        "content": question,
    })

    if settings.OPENROUTER_API_KEY:
        model_candidates = [
            settings.OPENROUTER_LIVE_MODEL,
            "openai/gpt-4o-mini",
        ]
        seen: set[str] = set()
        for candidate in model_candidates:
            model_name = (candidate or "").strip()
            if not model_name or model_name in seen:
                continue
            seen.add(model_name)
            try:
                answer = await _openrouter_chat_completion(
                    model_name,
                    messages,
                    max_tokens=800,
                    timeout_sec=settings.LIVE_RESPONSE_TIMEOUT_SEC,
                )
                if answer:
                    return answer
            except Exception as exc:
                log.warning("OpenRouter answer generation failed for model=%s: %s", model_name, exc)

    client, model = _chat_client_and_model(settings.LIVE_LLM_PROVIDER)
    if client and model:
        try:
            completion = await client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=800,
                temperature=0.3,
            )
            answer = _extract_message_text(completion.choices[0].message.content)
            if answer:
                return answer
        except Exception as exc:
            log.warning("LLM answer generation failed, using fallback: %s", exc)

    return _fallback_live_answer(question, user, plan)


async def _generate_summary(transcript: list[str], user: User, plan: dict[str, Any] | None) -> str:
    if not transcript:
        return "Session ended. No transcript was captured."

    joined = "\n".join(transcript[-200:])
    job_name = (plan or {}).get("job_name") or "Interview"

    summary_messages = [
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
            "content": f"Job: {job_name}\n\nTranscript:\n{joined[:12000]}",
        },
    ]

    if settings.OPENROUTER_API_KEY:
        try:
            summary = await _openrouter_chat_completion(settings.OPENROUTER_SUMMARY_MODEL, summary_messages, max_tokens=500)
            if summary:
                return summary
        except Exception as exc:
            log.warning("OpenRouter summary generation failed, falling back SDK: %s", exc)

    client, model = _summary_client_and_model()
    if client and model:
        try:
            completion = await client.chat.completions.create(
                model=model,
                messages=summary_messages,
                max_tokens=500,
                temperature=0.2,
            )
            summary = _extract_message_text(completion.choices[0].message.content)
            if summary:
                return summary
        except Exception as exc:
            log.warning("LLM summary generation failed, using fallback: %s", exc)

    questions = [line for line in transcript if _is_question(line)]
    highlights = "\n".join(f"- {q}" for q in questions[:8]) or "- No clear questions detected"
    return (
        f"Session summary for {job_name}:\n"
        f"- Total transcript lines: {len(transcript)}\n"
        f"- Questions detected: {len(questions)}\n"
        "Key questions:\n"
        f"{highlights}"
    )


async def _transcribe_audio(audio_b64: str, mime_type: str | None) -> list[str]:
    if not audio_b64:
        log.info("transcribe: empty audio payload")
        return []

    try:
        audio_bytes = base64.b64decode(audio_b64)
    except Exception:
        log.warning("transcribe: invalid base64 payload")
        return []

    if not audio_bytes:
        log.info("transcribe: decoded audio is empty")
        return []

    log.info(
        "transcribe: received payload mime=%s bytes=%s",
        mime_type or "unknown",
        len(audio_bytes),
    )

    ext = "webm"
    if mime_type:
        if "wav" in mime_type:
            ext = "wav"
        elif "mpeg" in mime_type or "mp3" in mime_type:
            ext = "mp3"
        elif "ogg" in mime_type:
            ext = "ogg"
        elif "m4a" in mime_type or "mp4" in mime_type:
            ext = "m4a"

    # Prefer Deepgram when configured.
    if settings.DEEPGRAM_API_KEY:
        try:
            started_at = time.perf_counter()
            log.info("transcribe: provider=deepgram model=%s language=%s", settings.DEEPGRAM_MODEL, settings.DEEPGRAM_LANGUAGE)
            query = urllib.parse.urlencode(
                {
                    "model": settings.DEEPGRAM_MODEL,
                    "language": settings.DEEPGRAM_LANGUAGE,
                    "smart_format": "true",
                    "punctuate": "true",
                    "diarize": "true",
                }
            )
            url = f"https://api.deepgram.com/v1/listen?{query}"

            content_type = mime_type or {
                "wav": "audio/wav",
                "mp3": "audio/mpeg",
                "ogg": "audio/ogg",
                "m4a": "audio/mp4",
            }.get(ext, "audio/webm")

            req = urllib.request.Request(
                url,
                data=audio_bytes,
                headers={
                    "Authorization": f"Token {settings.DEEPGRAM_API_KEY}",
                    "Content-Type": content_type,
                },
                method="POST",
            )

            def _call_deepgram() -> dict[str, Any]:
                with urllib.request.urlopen(req, timeout=settings.TRANSCRIBE_HTTP_TIMEOUT_SEC) as resp:  # noqa: S310
                    payload = resp.read().decode("utf-8", errors="ignore")
                    return json.loads(payload)

            result = await asyncio.to_thread(_call_deepgram)
            text = (
                (((result.get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}])[0].get("transcript")
                or ""
            ).strip()
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            log.info(
                "transcribe: provider=deepgram done elapsed_ms=%s chars=%s",
                elapsed_ms,
                len(text),
            )
            if text:
                return [line.strip() for line in re.split(r"[\n\.]+", text) if line.strip()]
        except Exception as exc:
            log.warning("Deepgram transcription failed, falling back: %s", exc)
    else:
        log.info("transcribe: DEEPGRAM_API_KEY missing, skipping Deepgram")

    try:
        # OpenAI Whisper endpoint is the most reliable path for transcription.
        # If only OpenRouter key is configured, try OpenRouter's OpenAI-compatible
        # endpoint; if unsupported, we gracefully return an empty transcript.
        if settings.OPENAI_API_KEY:
            log.info("transcribe: provider=openai-whisper")
            client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        elif settings.OPENROUTER_API_KEY:
            log.info("transcribe: provider=openrouter-openai-compatible")
            client = AsyncOpenAI(
                api_key=settings.OPENROUTER_API_KEY,
                base_url=settings.OPENROUTER_BASE_URL,
                default_headers=_openrouter_headers(),
            )
        else:
            log.warning("transcribe: no provider key configured")
            return []

        file_like = io.BytesIO(audio_bytes)
        file_like.name = f"session_audio.{ext}"
        started_at = time.perf_counter()
        transcription = await asyncio.wait_for(
            client.audio.transcriptions.create(
                model="whisper-1",
                file=file_like,
            ),
            timeout=settings.TRANSCRIBE_HTTP_TIMEOUT_SEC,
        )
        text = (transcription.text or "").strip()
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        log.info(
            "transcribe: provider=whisper done elapsed_ms=%s chars=%s",
            elapsed_ms,
            len(text),
        )
        if not text:
            return []
        return [line.strip() for line in re.split(r"[\n\.]+", text) if line.strip()]
    except Exception as exc:
        log.warning("Audio transcription failed: %s", exc)
        return []


@router.get(
    "/me",
    response_model=UserOut,
    summary="Get authenticated user's full profile",
)
async def get_me(
    user: User = Depends(get_current_user),
) -> User:
    """
    Returns the full user record.

    The .exe calls this once after login to populate the UI
    (username display, session counter).  The resume/JD/custom_prompt
    fields are intentionally included here but are only sent over the
    WebSocket to the backend — they are never rendered in the renderer
    process UI.
    """
    return user


@router.get(
    "/me/session-status",
    response_model=UserSessionStatus,
    summary="Check session availability",
)
async def get_session_status(
    user: User = Depends(get_current_user),
) -> UserSessionStatus:
    """
        Lightweight endpoint for clients.

        Returns only the four fields needed for capacity display:
      • permitted_sessions
      • used_sessions
      • sessions_remaining   (computed: permitted - used, floored at 0)
      • has_sessions_available  (bool: used < permitted)
    """
    return UserSessionStatus(
        user_id=user.id,
        permitted_sessions=user.permitted_sessions,
        used_sessions=user.used_sessions,
        sessions_remaining=user.sessions_remaining,
        has_sessions_available=user.has_sessions_available,
    )


@router.post(
    "/me/session/start",
    response_model=SessionStartResponse,
    summary="Start a user session only when admin has permitted one",
)
async def start_session(
    user: User = Depends(get_current_user),
) -> SessionStartResponse:
    session_key = f"user:{user.id}"
    # Always reset any stale in-memory rolling buffer when starting a session.
    await live_runtime_registry.clear(session_key)

    config = _parse_config(user.custom_prompt)
    active_slot, _plan = _get_active_permitted_plan(config)

    if active_slot is None:
        return SessionStartResponse(
            allowed=False,
            reason="No permitted session found. Ask admin to permit a session first.",
        )

    return SessionStartResponse(allowed=True, active_slot=active_slot)


@router.post(
    "/me/session/respond",
    response_model=SessionRespondResponse,
    summary="Return AI answer for the user's transcribed utterance",
)
async def respond_session(
    body: SessionRespondRequest,
    user: User = Depends(get_current_user),
) -> SessionRespondResponse:
    try:
        config = _parse_config(user.custom_prompt)
        _slot, plan = _get_active_permitted_plan(config)
        if plan is None:
            return SessionRespondResponse(
                should_respond=False,
                reason="No permitted session is active.",
            )

        utterance = (body.utterance or "").strip()
        if not utterance:
            return SessionRespondResponse(
                should_respond=False,
                reason="No utterance provided.",
            )

        log.info(
            "session/respond: user_id=%s utterance_len=%s",
            user.id,
            len(utterance),
        )

        answer = await _generate_answer(utterance, user, plan, body.history or [])

        if not answer or answer == "[STANDBY]":
            return SessionRespondResponse(
                should_respond=False,
                reason="No actionable response generated.",
            )

        log.info("session/respond: user_id=%s answer_len=%s", user.id, len(answer))
        return SessionRespondResponse(should_respond=True, answer=answer)
    except TimeoutError:
        return SessionRespondResponse(
            should_respond=True,
            answer="The AI provider timed out. Please retry.",
            reason="Provider timeout",
        )
    except Exception as exc:
        log.exception("session respond failed for user_id=%s: %s", user.id, exc)
        return SessionRespondResponse(
            should_respond=True,
            answer="I captured your question, but the AI provider is temporarily unavailable. Please retry.",
            reason="Provider fallback",
        )


@router.post(
    "/me/session/transcribe",
    response_model=SessionTranscribeResponse,
    summary="Transcribe a live audio chunk for session response fallback",
)
async def transcribe_session_chunk(
    body: SessionTranscribeRequest,
    user: User = Depends(get_current_user),
) -> SessionTranscribeResponse:
    log.info(
        "session/transcribe: user_id=%s mime=%s b64_chars=%s",
        user.id,
        body.audio_mime_type or "unknown",
        len(body.audio_base64 or ""),
    )
    lines = await _transcribe_audio(body.audio_base64, body.audio_mime_type)
    log.info(
        "session/transcribe: user_id=%s transcript_lines=%s",
        user.id,
        len(lines),
    )
    return SessionTranscribeResponse(transcript=lines)


@router.post(
    "/me/session/end",
    response_model=SessionEndResponse,
    summary="End session, generate summary, and persist it to active plan",
)
async def end_session(
    body: SessionEndRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionEndResponse:
    session_key = f"user:{user.id}"

    # Re-load user in the route's DB session to ensure updates are persisted
    # with this request transaction.
    db_user = await db.get(User, user.id)
    if db_user is None:
        return SessionEndResponse(summary="User not found.")

    config = _parse_config(db_user.custom_prompt)
    slot, plan = _get_active_permitted_plan(config)

    if slot is None or plan is None or config is None:
        await live_runtime_registry.clear(session_key)
        return SessionEndResponse(summary="No active permitted session found to end.")

    job_name = (plan or {}).get("job_name") or "Interview"
    summary = ""

    # Try chunked summarization first if we have a streaming session
    if body.session_id:
        buffer = await transcript_registry.get(body.session_id)
        if buffer:
            stats = await buffer.get_stats()
            total_lines = stats.get("total_lines", 0)
            
            log.info(
                "session/end: using chunked summarization for session=%s total_lines=%s",
                body.session_id,
                total_lines,
            )
            
            try:
                if total_lines > 50:
                    # Use chunked hierarchical summarization for longer transcripts
                    session_summary = await summarize_session(
                        buffer=buffer,
                        job_name=job_name,
                        chunk_duration_seconds=300.0,  # 5 minute chunks
                        model=settings.OPENROUTER_SUMMARY_MODEL,
                        max_parallel_chunks=5,
                    )
                    summary = session_summary.meta_summary
                    
                    log.info(
                        "session/end: chunked summary complete chunks=%s processing_time=%.2fs",
                        len(session_summary.chunk_summaries),
                        session_summary.processing_time_seconds,
                    )
                else:
                    # For shorter sessions, use quick summary
                    transcript_text = await buffer.get_full_transcript_text()
                    lines = [line.strip() for line in transcript_text.split("\n") if line.strip()]
                    summary = await quick_summary_from_lines(lines, job_name)
                
                # Clean up the buffer after summarization
                await transcript_registry.remove(body.session_id)
                
            except Exception as exc:
                log.exception("Chunked summarization failed: %s", exc)
                # Fall through to legacy summarization

    # Fallback to legacy summarization if chunked didn't work
    if not summary:
        cleaned = [re.sub(r"\s+", " ", line).strip() for line in body.transcript if line and line.strip()]
        if not cleaned and body.audio_base64:
            cleaned = await _transcribe_audio(body.audio_base64, body.audio_mime_type)

        try:
            summary = await _generate_summary(cleaned, db_user, plan)
        except Exception as exc:
            log.exception("summary generation failed for user_id=%s: %s", db_user.id, exc)
            summary = "Session ended, but summary generation failed due to provider issues. Please retry with network/API check."

    plans = config.get("session_plans") or []
    for idx, item in enumerate(plans, start=1):
        if not isinstance(item, dict):
            continue
        current_slot = item.get("slot") if isinstance(item.get("slot"), int) else idx
        if current_slot == slot:
            item["summary"] = summary
            item["state"] = "ended"
            break

    config["active_session_slot"] = None
    db_user.custom_prompt = json.dumps(config)
    db_user.used_sessions = min(db_user.permitted_sessions, db_user.used_sessions + 1)
    await db.flush()

    # Session ended, so drop rolling transcript buffer for this user.
    await live_runtime_registry.clear(session_key)

    return SessionEndResponse(summary=summary)


# ---------------------------------------------------------------------------
# Hotkey Help - Real-time answer assistance
# ---------------------------------------------------------------------------

HELP_SYSTEM_PROMPT = (
    "You are an expert interview copilot. The user is in a live interview and just triggered "
    "the help hotkey to get help with a question they heard.\n\n"
    "You are given the last few lines of the interview transcript as context.\n\n"
    "Rules:\n"
    "- Identify the question being asked (if any)\n"
    "- Provide a clear, direct answer the candidate can speak naturally\n"
    "- Use natural spoken language — write as if the candidate is speaking\n"
    "- Include a brief definition/concept first, then a practical example if helpful\n"
    "- Keep it concise (3-5 short paragraphs or bullet points max)\n"
    "- Use **bold** for key technical terms to make them easy to scan\n"
    "- If no clear question, provide helpful context based on the transcript\n"
    "- Ground your answer in the provided resume and job description context"
)


async def _generate_help_answer(
    context: str,
    user: User,
    plan: dict[str, Any] | None,
) -> str:
    """Generate AI help response based on transcript context."""
    job_name = (plan or {}).get("job_name") or "this interview"
    resume_text = (plan or {}).get("resume_text") or user.resume_text or ""
    job_description = (plan or {}).get("job_description") or user.job_description or ""
    custom_prompt = (plan or {}).get("prompt") or ""

    messages = [
        {
            "role": "system",
            "content": HELP_SYSTEM_PROMPT,
        },
        {
            "role": "system",
            "content": (
                f"Interview Job: {job_name}\n"
                f"Resume Context:\n{resume_text[:3000]}\n\n"
                f"Job Description:\n{job_description[:3000]}\n\n"
                f"Admin Prompt:\n{custom_prompt[:2000]}"
            ),
        },
        {
            "role": "user",
            "content": f"Recent transcript:\n{context}\n\nHelp me answer this.",
        },
    ]

    if settings.OPENROUTER_API_KEY:
        model_candidates = [
            settings.OPENROUTER_LIVE_MODEL,
            "openai/gpt-4o-mini",
        ]
        seen: set[str] = set()
        for candidate in model_candidates:
            model_name = (candidate or "").strip()
            if not model_name or model_name in seen:
                continue
            seen.add(model_name)
            try:
                answer = await _openrouter_chat_completion(
                    model_name,
                    messages,
                    max_tokens=600,
                    timeout_sec=settings.LIVE_RESPONSE_TIMEOUT_SEC,
                )
                if answer:
                    return answer
            except Exception as exc:
                log.warning("Help generation failed for model=%s: %s", model_name, exc)

    # Fallback
    return (
        "I captured the context but the AI provider timed out.\n"
        "- Try to identify the core question being asked\n"
        "- Give a structured answer with definition, example, and trade-offs\n"
        "- Keep your response concise and role-relevant"
    )


@router.post(
    "/me/session/help",
    response_model=SessionHelpResponse,
    summary="Get AI help based on recent transcript context (hotkey assistance)",
)
async def session_help(
    body: SessionHelpRequest,
    user: User = Depends(get_current_user),
) -> SessionHelpResponse:
    """
    Get AI-generated answer help based on the last N lines of transcript.
    
    This endpoint is called when the user presses the configured help hotkey during a live
    interview. It retrieves context from the transcript ring buffer and
    generates a helpful response.
    
    The context is displayed in the ChatPanel as a user message (right side),
    and the AI response is displayed as an assistant message (left side).
    """
    try:
        # Get the transcript buffer for this session
        buffer = await transcript_registry.get(body.session_id)
        
        if buffer is None:
            return SessionHelpResponse(
                success=False,
                reason=f"No active transcript buffer for session {body.session_id}. "
                       "Make sure streaming is connected.",
            )
        
        # Get recent context
        context = await buffer.get_recent_text(count=body.context_lines)
        
        if not context.strip():
            return SessionHelpResponse(
                success=False,
                reason="No transcript context available yet. Wait for some audio to be transcribed.",
            )
        
        log.info(
            "session/help: user_id=%s session=%s context_lines=%s",
            user.id,
            body.session_id,
            body.context_lines,
        )
        
        # Get user's active plan for RAG context
        config = _parse_config(user.custom_prompt)
        _slot, plan = _get_active_permitted_plan(config)
        
        # Generate help answer
        answer = await _generate_help_answer(context, user, plan)
        
        log.info(
            "session/help: user_id=%s answer_len=%s",
            user.id,
            len(answer),
        )
        
        return SessionHelpResponse(
            success=True,
            context=context,
            answer=answer,
        )
    
    except TimeoutError:
        return SessionHelpResponse(
            success=False,
            reason="AI provider timed out. Please try again.",
        )
    except Exception as exc:
        log.exception("session/help failed for user_id=%s: %s", user.id, exc)
        return SessionHelpResponse(
            success=False,
            reason=f"Help generation failed: {str(exc)[:100]}",
        )
