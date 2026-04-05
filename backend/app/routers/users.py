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
    BouncerModel,
    MasterLLM,
    SessionOrchestratorRuntime,
    SessionRuntimeRegistry,
    STTSegment,
    TranscriptBuffer,
    build_master_from_env,
)
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
    "You are an elite, invisible, real-time technical assistant for high-stakes meetings and interviews. "
    "Monitor messy transcript input and answer only when a direct question is clearly asked to the user. "
    "Output must be micro-responses: 2-3 bullet points maximum, each max 15 words. "
    "Bold the most critical technical term in each bullet. "
    "No chitchat, no framing text, no explanations outside bullets. "
    "Prioritize resume/job/admin prompt context for alignment. "
    "If unsure or no direct question: output exactly [STANDBY]."
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
        {
            "role": "system",
            "content": "Recent transcript:\n" + "\n".join(history[-12:]),
        },
        {
            "role": "user",
            "content": question,
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
                    max_tokens=400,
                    timeout_sec=settings.LIVE_RESPONSE_TIMEOUT_SEC,
                )
                if answer:
                    normalized = _normalize_micro_response(answer)
                    if normalized != "[STANDBY]":
                        return normalized
            except Exception as exc:
                log.warning("OpenRouter answer generation failed for model=%s: %s", model_name, exc)

    client, model = _chat_client_and_model(settings.LIVE_LLM_PROVIDER)
    if client and model:
        try:
            completion = await client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=400,
                temperature=0.2,
            )
            answer = _extract_message_text(completion.choices[0].message.content)
            if answer:
                normalized = _normalize_micro_response(answer)
                if normalized != "[STANDBY]":
                    return normalized
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
        return []

    try:
        audio_bytes = base64.b64decode(audio_b64)
    except Exception:
        return []

    if not audio_bytes:
        return []

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
            if text:
                return [line.strip() for line in re.split(r"[\n\.]+", text) if line.strip()]
        except Exception as exc:
            log.warning("Deepgram transcription failed, falling back: %s", exc)

    try:
        # OpenAI Whisper endpoint is the most reliable path for transcription.
        # If only OpenRouter key is configured, try OpenRouter's OpenAI-compatible
        # endpoint; if unsupported, we gracefully return an empty transcript.
        if settings.OPENAI_API_KEY:
            client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        elif settings.OPENROUTER_API_KEY:
            client = AsyncOpenAI(
                api_key=settings.OPENROUTER_API_KEY,
                base_url=settings.OPENROUTER_BASE_URL,
                default_headers=_openrouter_headers(),
            )
        else:
            return []

        file_like = io.BytesIO(audio_bytes)
        file_like.name = f"session_audio.{ext}"
        transcription = await asyncio.wait_for(
            client.audio.transcriptions.create(
                model="whisper-1",
                file=file_like,
            ),
            timeout=settings.TRANSCRIBE_HTTP_TIMEOUT_SEC,
        )
        text = (transcription.text or "").strip()
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
    summary="Return AI response only for question utterances",
)
async def respond_session(
    body: SessionRespondRequest,
    user: User = Depends(get_current_user),
) -> SessionRespondResponse:
    try:
        session_key = f"user:{user.id}"

        config = _parse_config(user.custom_prompt)
        _slot, plan = _get_active_permitted_plan(config)
        if plan is None:
            return SessionRespondResponse(
                should_respond=False,
                reason="No permitted session is active.",
            )

        runtime = await live_runtime_registry.get(session_key)
        utterance = (body.utterance or "").strip()
        low_utt = f" {utterance.casefold()} "
        starts_like_question = bool(re.match(r"^(who|what|when|where|why|how|can|could|would|do|does|did|is|are)\b", utterance.casefold()))
        has_direct_ask = any(phrase in low_utt for phrase in (" can you ", " could you ", " would you ", " tell me ", " explain "))
        inferred_pitch = 0.6 if (utterance.endswith("?") or starts_like_question or has_direct_ask) else 0.25
        inferred_pause = 260 if (utterance.endswith(("?", ".", "!")) or len(utterance.split()) >= 5 or has_direct_ask or starts_like_question) else 120

        pitch_rise = body.pitch_rise if body.pitch_rise is not None else inferred_pitch
        pause_after_ms = body.pause_after_ms if body.pause_after_ms is not None else inferred_pause
        segment = STTSegment(
            ts=time.monotonic(),
            speaker=(body.speaker or "interviewer").strip() or "interviewer",
            text=utterance,
            pitch_rise=pitch_rise,
            pause_after_ms=pause_after_ms,
        )

        payload = await asyncio.wait_for(
            runtime.process_segment(
                segment,
                external_history=body.history,
                retrieved_rag_context=_build_rag_context(user, plan),
            ),
            timeout=settings.LIVE_RESPONSE_TIMEOUT_SEC,
        )
        if not payload:
            return SessionRespondResponse(
                should_respond=False,
                reason="No complete interview question detected.",
            )

        answer = _format_orchestrator_answer(payload.get("neonexus_response") or [])
        if not answer:
            return SessionRespondResponse(
                should_respond=False,
                reason="No actionable response generated.",
            )

        return SessionRespondResponse(should_respond=True, answer=answer)
    except TimeoutError:
        return SessionRespondResponse(
            should_respond=True,
            answer="[STANDBY]",
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
    _user: User = Depends(get_current_user),
) -> SessionTranscribeResponse:
    lines = await _transcribe_audio(body.audio_base64, body.audio_mime_type)
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
