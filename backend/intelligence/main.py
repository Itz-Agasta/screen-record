"""
NeoNexus Copilot - Real-Time Intelligence Orchestration Engine

Pipeline implemented here:
1) Sliding window transcript buffer (last 15-30 seconds)
2) Fast "Bouncer" classifier loop (cheap intent + targeting gate)
3) Prosody + turn-taking cues from STT metadata
4) Trigger lock -> Master LLM structured output
5) Debounce/cooldown to prevent overlapping answers

Run:
    python backend/intelligence/main.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Deque

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, Field, ValidationError

try:
    import websockets
except Exception:  # pragma: no cover - optional runtime dependency import
    websockets = None


load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()
OPENROUTER_MODEL = os.getenv("OPENROUTER_LIVE_MODEL", os.getenv("OPENAI_MODEL", "openai/gpt-4o-mini")).strip()
OPENROUTER_SITE_URL = os.getenv("OPENROUTER_SITE_URL", "").strip()
OPENROUTER_APP_NAME = os.getenv("OPENROUTER_APP_NAME", "NeoNexus Copilot").strip()
USE_MOCK_LLM = os.getenv("USE_MOCK_LLM", "false").strip().lower() in {"1", "true", "yes"}
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "").strip()
DEEPGRAM_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-2").strip()
DEEPGRAM_LANGUAGE = os.getenv("DEEPGRAM_LANGUAGE", "en-US").strip()
DEEPGRAM_REALTIME_URL = os.getenv("DEEPGRAM_REALTIME_URL", "wss://api.deepgram.com/v1/listen").strip()

# Window + concurrency controls
BUFFER_WINDOW_SEC = float(os.getenv("BUFFER_WINDOW_SEC", "25"))
BOUNCER_INTERVAL_SEC = float(os.getenv("BOUNCER_INTERVAL_SEC", "0.35"))
COOLDOWN_SEC = float(os.getenv("COOLDOWN_SEC", "6"))

# Optional semantic targeting hint
TARGET_NAME = os.getenv("TARGET_NAME", "suvam").strip().lower()


class MasterDecision(BaseModel):
    action_required: bool
    detected_question: str | None = None
    neonexus_response: list[str] = Field(default_factory=list, max_length=3)


@dataclass(slots=True)
class STTSegment:
    ts: float
    speaker: str
    text: str
    pitch_rise: float
    pause_after_ms: int


class TranscriptBuffer:
    """Rolling 15-30s transcript memory.

    New segments append to the right; old segments are dropped by timestamp.
    The buffer remains small and context-relevant even with continuous speech.
    """

    def __init__(self, window_seconds: float = 25.0) -> None:
        self.window_seconds = max(1.0, window_seconds)
        self._segments: Deque[STTSegment] = deque()
        self._lock = asyncio.Lock()

    async def append(self, segment: STTSegment) -> None:
        async with self._lock:
            self._segments.append(segment)
            self._prune(segment.ts)

    async def snapshot(self) -> list[STTSegment]:
        now = time.monotonic()
        async with self._lock:
            self._prune(now)
            return list(self._segments)

    async def clear(self) -> None:
        async with self._lock:
            self._segments.clear()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self._segments and self._segments[0].ts < cutoff:
            self._segments.popleft()


@dataclass(slots=True)
class BouncerDecision:
    should_trigger: bool
    locked_question: str | None
    confidence: float
    reason: str


class BouncerModel:
    """Fast semantic gate before expensive LLM calls.

    Uses lightweight heuristics over text + prosody metadata:
    - syntactic cues (what/how/why/can you...)
    - targeting cues (your name / direct second-person addressing)
    - acoustic cues (pitch rise + pause micro-break)
    """

    STARTER_RE = re.compile(
        r"\b(what|why|how|who|when|where|can you|could you|would you|do you|did you|introduce|tell me|walk me through|explain|describe)\b",
        re.IGNORECASE,
    )

    def evaluate(self, segments: list[STTSegment]) -> BouncerDecision:
        if not segments:
            return BouncerDecision(False, None, 0.0, "empty buffer")

        # Prefer recent interviewer-like segments.
        recent = segments[-4:]
        merged = " ".join(s.text.strip() for s in recent if s.text.strip())
        if not merged:
            return BouncerDecision(False, None, 0.0, "no usable text")

        text_l = merged.lower()
        has_qmark = "?" in merged
        has_starter = bool(self.STARTER_RE.search(text_l))
        has_targeting = (TARGET_NAME and TARGET_NAME in text_l) or (" you " in f" {text_l} ")

        # Prosody/turn-taking hints from STT metadata.
        latest = recent[-1]
        prosody_hint = latest.pitch_rise >= 0.45
        pause_hint = latest.pause_after_ms >= 220

        confidence = 0.0
        if has_qmark:
            confidence += 0.45
        if has_starter:
            confidence += 0.40
        if has_targeting:
            confidence += 0.15
        if prosody_hint:
            confidence += 0.07
        if pause_hint:
            confidence += 0.08

        should_trigger = confidence >= 0.55
        if not should_trigger:
            return BouncerDecision(False, None, confidence, "below threshold")

        # Lock the actionable question span.
        locked = self._extract_question_span(merged)
        return BouncerDecision(True, locked, confidence, "triggered")

    def _extract_question_span(self, merged_text: str) -> str:
        lowered = merged_text.lower()
        m = self.STARTER_RE.search(lowered)
        if not m:
            return merged_text.strip()
        return merged_text[m.start() :].strip(" ,.-")


MASTER_SYSTEM_PROMPT = """
You are NeoNexus Copilot's master reasoning model.

Input:
- locked_question: question chunk extracted by a fast bouncer
- transcript_window: chaotic recent transcript context
- retrieved_rag_context: external context (resume/JD/company)

Task:
1) Decide if the locked_question is truly directed to the user.
2) If yes, return action_required=true with max 3 concise technical bullets.
3) If no, return action_required=false and empty response.

Return strict JSON only with keys:
action_required, detected_question, neonexus_response
""".strip()


class MasterLLM:
    def __init__(
        self,
        model: str,
        api_key: str | None,
        base_url: str | None,
        app_name: str | None,
        site_url: str | None,
        use_mock: bool,
    ) -> None:
        self.model = model
        self.use_mock = use_mock
        if api_key and not use_mock:
            default_headers: dict[str, str] = {}
            if site_url:
                default_headers["HTTP-Referer"] = site_url
            if app_name:
                default_headers["X-Title"] = app_name

            self.client = OpenAI(
                api_key=api_key,
                base_url=base_url or None,
                default_headers=default_headers or None,
            )
        else:
            self.client = None

    async def run(self, locked_question: str, transcript_window: str, retrieved_rag_context: str) -> MasterDecision:
        if self.use_mock or self.client is None:
            return self._mock(locked_question)

        payload = {
            "locked_question": locked_question,
            "transcript_window": transcript_window,
            "retrieved_rag_context": retrieved_rag_context,
        }

        def _call() -> str:
            completion = self.client.chat.completions.create(
                model=self.model,
                temperature=0.1,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": MASTER_SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps(payload)},
                ],
            )
            return (completion.choices[0].message.content or "").strip()

        raw = await asyncio.to_thread(_call)
        if not raw:
            raise ValueError("Master LLM returned empty output")

        return MasterDecision.model_validate(json.loads(raw))

    def _mock(self, locked_question: str) -> MasterDecision:
        q = locked_question.lower()
        if "introduce" in q:
            return MasterDecision(
                action_required=True,
                detected_question="Introduce yourself.",
                neonexus_response=[
                    "I build **Python/FastAPI** backend systems for production workloads.",
                    "I specialize in **async pipelines**, reliability, and observability.",
                    "I map technical decisions to measurable business impact.",
                ],
            )
        if any(x in q for x in ("what", "how", "why", "can you", "explain")):
            return MasterDecision(
                action_required=True,
                detected_question=locked_question,
                neonexus_response=[
                    "Start with a crisp definition and assumptions.",
                    "Add one production-grade example with trade-offs.",
                    "Close with impact on performance/reliability.",
                ],
            )
        return MasterDecision(action_required=False, detected_question=None, neonexus_response=[])


def build_master_from_env() -> MasterLLM:
    return MasterLLM(
        model=OPENROUTER_MODEL,
        api_key=OPENROUTER_API_KEY or None,
        base_url=OPENROUTER_BASE_URL,
        app_name=OPENROUTER_APP_NAME,
        site_url=OPENROUTER_SITE_URL,
        use_mock=(USE_MOCK_LLM or not OPENROUTER_API_KEY),
    )


class SessionOrchestratorRuntime:
    """Reusable per-session runtime with lock + cooldown + dedupe."""

    def __init__(
        self,
        buffer: TranscriptBuffer,
        bouncer: BouncerModel,
        master: MasterLLM,
        cooldown_sec: float = COOLDOWN_SEC,
    ) -> None:
        self.buffer = buffer
        self.bouncer = bouncer
        self.master = master
        self.cooldown_sec = max(0.5, cooldown_sec)

        self.cooldown_until = 0.0
        self.answer_in_flight = False
        self._gate_lock = asyncio.Lock()
        self._last_locked_question = ""

    async def reset(self) -> None:
        async with self._gate_lock:
            self.cooldown_until = 0.0
            self.answer_in_flight = False
            self._last_locked_question = ""
            await self.buffer.clear()

    async def process_segment(
        self,
        segment: STTSegment,
        external_history: list[str] | None = None,
        retrieved_rag_context: str = "",
    ) -> dict[str, Any] | None:
        await self.buffer.append(segment)

        now = time.monotonic()
        if self.answer_in_flight or now < self.cooldown_until:
            return None

        async with self._gate_lock:
            now = time.monotonic()
            if self.answer_in_flight or now < self.cooldown_until:
                return None

            segments = await self.buffer.snapshot()
            decision = self.bouncer.evaluate(segments)
            if not decision.should_trigger or not decision.locked_question:
                return None

            locked_norm = decision.locked_question.strip().casefold()
            if locked_norm and locked_norm == self._last_locked_question and now < (self.cooldown_until + 1.0):
                return None

            self.answer_in_flight = True
            try:
                history_tail = " ".join((external_history or [])[-12:]).strip()
                segment_window = " ".join(s.text for s in segments if s.text.strip()).strip()
                transcript_window = " ".join(part for part in (history_tail, segment_window) if part).strip()

                master_out = await self.master.run(
                    locked_question=decision.locked_question,
                    transcript_window=transcript_window,
                    retrieved_rag_context=retrieved_rag_context,
                )

                payload = {
                    "action_required": master_out.action_required,
                    "detected_question": master_out.detected_question,
                    "neonexus_response": master_out.neonexus_response,
                    "bouncer_confidence": round(decision.confidence, 3),
                    "bouncer_reason": decision.reason,
                }

                if master_out.action_required:
                    self._last_locked_question = locked_norm
                    await self.buffer.clear()

                self.cooldown_until = time.monotonic() + self.cooldown_sec
                return payload if master_out.action_required else None
            finally:
                self.answer_in_flight = False


class SessionRuntimeRegistry:
    """In-memory runtime registry keyed by session/user ids."""

    def __init__(self, factory: Callable[[], SessionOrchestratorRuntime]) -> None:
        self._factory = factory
        self._runtimes: dict[str, SessionOrchestratorRuntime] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> SessionOrchestratorRuntime:
        async with self._lock:
            runtime = self._runtimes.get(key)
            if runtime is None:
                runtime = self._factory()
                self._runtimes[key] = runtime
            return runtime

    async def clear(self, key: str) -> None:
        async with self._lock:
            runtime = self._runtimes.pop(key, None)
        if runtime is not None:
            await runtime.reset()


class DeepgramRealtimeAdapter:
    """Optional Deepgram websocket adapter that emits STTSegment callbacks.

    This adapter is designed for production streaming pipelines where audio
    chunks are fed continuously and callbacks push normalized segments into
    the orchestrator runtime.
    """

    def __init__(
        self,
        on_segment: Callable[[STTSegment], Awaitable[None] | None],
        api_key: str | None = None,
        model: str = DEEPGRAM_MODEL,
        language: str = DEEPGRAM_LANGUAGE,
        ws_url: str = DEEPGRAM_REALTIME_URL,
    ) -> None:
        self.on_segment = on_segment
        self.api_key = (api_key or DEEPGRAM_API_KEY).strip()
        self.model = model
        self.language = language
        self.ws_url = ws_url
        self._ws: Any = None
        self._receiver_task: asyncio.Task[Any] | None = None

    async def connect(self) -> None:
        if websockets is None:
            raise RuntimeError("websockets package unavailable; install uvicorn[standard] dependencies")
        if not self.api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is required for realtime websocket")

        url = f"{self.ws_url}?model={self.model}&language={self.language}&punctuate=true&smart_format=true&interim_results=true"
        self._ws = await websockets.connect(url, extra_headers={"Authorization": f"Token {self.api_key}"})
        self._receiver_task = asyncio.create_task(self._receiver_loop(), name="deepgram-receiver")

    async def send_audio(self, audio_chunk: bytes) -> None:
        if not self._ws:
            raise RuntimeError("Deepgram websocket is not connected")
        if audio_chunk:
            await self._ws.send(audio_chunk)

    async def close(self) -> None:
        if self._receiver_task:
            self._receiver_task.cancel()
            self._receiver_task = None
        if self._ws:
            try:
                await self._ws.close()
            finally:
                self._ws = None

    async def _receiver_loop(self) -> None:
        assert self._ws is not None
        async for message in self._ws:
            try:
                data = json.loads(message)
            except Exception:
                continue

            if data.get("type") != "Results":
                continue

            channel = data.get("channel") or {}
            alternatives = channel.get("alternatives") or [{}]
            alt = alternatives[0] if alternatives else {}
            text = (alt.get("transcript") or "").strip()
            if not text:
                continue

            words = alt.get("words") or []
            speaker = "interviewer"
            if words and isinstance(words[0], dict) and words[0].get("speaker") is not None:
                speaker = f"speaker-{words[0].get('speaker')}"

            pitch_rise = 0.55 if text.endswith("?") else 0.2
            pause_after_ms = 260 if bool(data.get("speech_final")) else 120

            segment = STTSegment(
                ts=time.monotonic(),
                speaker=speaker,
                text=text,
                pitch_rise=pitch_rise,
                pause_after_ms=pause_after_ms,
            )
            result = self.on_segment(segment)
            if asyncio.iscoroutine(result):
                await result


async def mock_stt_stream(out_queue: asyncio.Queue[STTSegment]) -> None:
    """Mock Deepgram-like stream with text + prosody metadata.

    In production, replace this with websocket callbacks and feed actual
    pitch/turn-taking metadata from your STT provider.
    """
    scripted = [
        ("interviewer", "okay everyone let's continue", 0.10, 120),
        ("interviewer", "suvam can you introduce yourself", 0.62, 310),
        ("panelist", "and tell us about your backend experience", 0.55, 260),
        ("candidate", "yes certainly", 0.18, 90),
        ("interviewer", "what is polymorphism in python", 0.61, 280),
        ("interviewer", "how would you scale a fastapi service", 0.58, 240),
    ]

    idx = 0
    while True:
        speaker, text, pitch_rise, pause_after_ms = scripted[idx % len(scripted)]
        idx += 1
        seg = STTSegment(
            ts=time.monotonic(),
            speaker=speaker,
            text=text,
            pitch_rise=pitch_rise,
            pause_after_ms=pause_after_ms,
        )
        await out_queue.put(seg)
        await asyncio.sleep(random.uniform(0.25, 0.8))


class IntelligenceOrchestrator:
    def __init__(self, buffer: TranscriptBuffer, bouncer: BouncerModel, master: MasterLLM) -> None:
        self.buffer = buffer
        self.bouncer = bouncer
        self.master = master
        self.cooldown_until = 0.0
        self.answer_in_flight = False

    async def run(self) -> None:
        queue: asyncio.Queue[STTSegment] = asyncio.Queue(maxsize=400)

        tasks = [
            asyncio.create_task(mock_stt_stream(queue), name="stt-producer"),
            asyncio.create_task(self._ingest_loop(queue), name="ingest-loop"),
            asyncio.create_task(self._bouncer_loop(), name="bouncer-loop"),
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            for t in tasks:
                t.cancel()

    async def _ingest_loop(self, queue: asyncio.Queue[STTSegment]) -> None:
        while True:
            seg = await queue.get()
            await self.buffer.append(seg)
            logging.info(
                "[STT] speaker=%s text=%r pitch=%.2f pause_ms=%d",
                seg.speaker,
                seg.text,
                seg.pitch_rise,
                seg.pause_after_ms,
            )
            queue.task_done()

    async def _bouncer_loop(self) -> None:
        while True:
            try:
                now = time.monotonic()
                if self.answer_in_flight or now < self.cooldown_until:
                    await asyncio.sleep(BOUNCER_INTERVAL_SEC)
                    continue

                segments = await self.buffer.snapshot()
                decision = self.bouncer.evaluate(segments)
                if not decision.should_trigger or not decision.locked_question:
                    await asyncio.sleep(BOUNCER_INTERVAL_SEC)
                    continue

                self.answer_in_flight = True

                transcript_window = " ".join(s.text for s in segments)
                rag_context = "[RAG_PLACEHOLDER] resume + job_description + company_context"

                master_out = await self.master.run(
                    locked_question=decision.locked_question,
                    transcript_window=transcript_window,
                    retrieved_rag_context=rag_context,
                )

                if master_out.action_required:
                    payload = {
                        "action_required": master_out.action_required,
                        "detected_question": master_out.detected_question,
                        "neonexus_response": master_out.neonexus_response,
                        "bouncer_confidence": round(decision.confidence, 3),
                        "bouncer_reason": decision.reason,
                    }
                    print("\n=== UI PAYLOAD ===")
                    print(json.dumps(payload, indent=2))
                    print("==================\n")

                    # Lock consumed; clear rolling buffer for next question cycle.
                    await self.buffer.clear()

                # Debounce always after trigger attempt to avoid overlap/retrigger storms.
                self.cooldown_until = time.monotonic() + COOLDOWN_SEC
                self.answer_in_flight = False

            except ValidationError as exc:
                logging.warning("Structured output parse failure: %s", exc)
                self.answer_in_flight = False
            except json.JSONDecodeError as exc:
                logging.warning("Master LLM JSON parse failure: %s", exc)
                self.answer_in_flight = False
            except Exception as exc:
                logging.exception("Bouncer loop error: %s", exc)
                self.answer_in_flight = False
            finally:
                await asyncio.sleep(BOUNCER_INTERVAL_SEC)


async def async_main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")

    if not OPENROUTER_API_KEY and not USE_MOCK_LLM:
        logging.warning("OPENROUTER_API_KEY missing; running in mock LLM mode.")

    buffer = TranscriptBuffer(window_seconds=BUFFER_WINDOW_SEC)
    bouncer = BouncerModel()
    master = MasterLLM(
        model=OPENROUTER_MODEL,
        api_key=OPENROUTER_API_KEY or None,
        base_url=OPENROUTER_BASE_URL,
        app_name=OPENROUTER_APP_NAME,
        site_url=OPENROUTER_SITE_URL,
        use_mock=(USE_MOCK_LLM or not OPENROUTER_API_KEY),
    )

    orchestrator = IntelligenceOrchestrator(buffer=buffer, bouncer=bouncer, master=master)
    await orchestrator.run()


def main() -> None:
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        print("\nNeoNexus intelligence engine stopped.")


if __name__ == "__main__":
    main()
