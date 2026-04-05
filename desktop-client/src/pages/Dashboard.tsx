/**
 * src/pages/Dashboard.tsx
 * ========================
 * The main authenticated view.
 *
 * Layout (420px wide, variable height):
 *   ┌──────────────────────────┐
 *   │  TitleBar (34px)         │  ← in App.tsx above this
 *   ├──────────────────────────┤
 *   │  User header             │  username + session counter
 *   ├──────────────────────────┤
 *   │  AIAnswerPanel (flex 1)  │  streaming answers, scrollable
 *   ├──────────────────────────┤
 *   │  StatusBar (28px)        │  ← in App.tsx below this
 *   └──────────────────────────┘
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { AIAnswerPanel }   from '../components/AIAnswerPanel';
import { SessionCounter }  from '../components/SessionCounter';
import { LiveSessionEngine } from '../lib/live-session';
import { hasPermittedSession } from '../lib/session-config';

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function Dashboard() {
  const username        = useStore((s) => s.username);
  const canStartSession = useStore((s) => s.sessionLaunchAllowed);
  const beginAnswer     = useStore((s) => s.beginAnswer);
  const appendToken     = useStore((s) => s.appendToken);
  const finaliseAnswer  = useStore((s) => s.finaliseAnswer);
  const setStatus       = useStore((s) => s.setStatus);
  const setError        = useStore((s) => s.setError);
  const setSessionLaunchAllowed = useStore((s) => s.setSessionLaunchAllowed);
  const syncProfile = useStore((s) => s.syncProfile);

  const [running, setRunning] = useState(false);
  const [liveDebug, setLiveDebug] = useState({
    segmentsSeen: 0,
    transcribeCalls: 0,
    transcribedLines: 0,
    questionsDetected: 0,
    answersShown: 0,
    lastReason: 'idle',
  });
  const transcriptRef = useRef<string[]>([]);
  const engineRef = useRef<LiveSessionEngine | null>(null);
  const chunkTranscribeInFlightRef = useRef(false);
  const audioChunkQueueRef = useRef<Blob[]>([]);
  const pendingChunkBatchRef = useRef<Blob[]>([]);
  const pendingChunkBytesRef = useRef(0);
  const seenUtterancesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;

    const refreshGate = async () => {
      try {
        const profile = await window.electronAPI.getUserProfile();
        if (!alive) return;
        syncProfile({
          username: profile.username || 'User',
          permittedSessions: profile.permitted_sessions,
          usedSessions: profile.used_sessions,
        });
        setSessionLaunchAllowed(hasPermittedSession(profile.custom_prompt));
      } catch {
        if (!alive) return;
        setSessionLaunchAllowed(false);
      }
    };

    refreshGate();
    const timer = window.setInterval(() => {
      void refreshGate();
    }, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [running, setSessionLaunchAllowed, syncProfile]);

  const startSession = async () => {
    try {
      const gate = await window.electronAPI.sessionStart();
      if (!gate.allowed) {
        setSessionLaunchAllowed(false);
        setStatus(gate.reason || 'Session is not permitted by admin.');
        return;
      }

      transcriptRef.current = [];
      seenUtterancesRef.current = new Set();
      audioChunkQueueRef.current = [];
      pendingChunkBatchRef.current = [];
      pendingChunkBytesRef.current = 0;
      setLiveDebug({
        segmentsSeen: 0,
        transcribeCalls: 0,
        transcribedLines: 0,
        questionsDetected: 0,
        answersShown: 0,
        lastReason: 'listening',
      });

      const processUtterance = async (rawText: string) => {
        const text = rawText.trim();
        if (!text) return;
        const key = text.toLowerCase();
        if (seenUtterancesRef.current.has(key)) return;
        seenUtterancesRef.current.add(key);
        setLiveDebug((s) => ({ ...s, segmentsSeen: s.segmentsSeen + 1 }));

        transcriptRef.current.push(text);
        try {
          const result = await window.electronAPI.sessionRespond({
            utterance: text,
            history: transcriptRef.current.slice(-20),
          });
          if (result.should_respond) {
            setLiveDebug((s) => ({
              ...s,
              questionsDetected: s.questionsDetected + 1,
              lastReason: 'question detected',
            }));
          }
          if (!result.should_respond || !result.answer) {
            if (result.reason) {
              setStatus(result.reason);
              setLiveDebug((s) => ({ ...s, lastReason: result.reason || s.lastReason }));
            }
            return;
          }

          beginAnswer();
          appendToken(result.answer);
          finaliseAnswer();
          setLiveDebug((s) => ({
            ...s,
            answersShown: s.answersShown + 1,
            lastReason: 'answer rendered',
          }));
        } catch (err: any) {
          setError(err?.message || 'Failed to get AI response.');
          setLiveDebug((s) => ({ ...s, lastReason: err?.message || 'sessionRespond failed' }));
        }
      };

      const engine = new LiveSessionEngine({
        onUtterance: async (text) => {
          await processUtterance(text);
        },
        onAudioChunk: async (chunk) => {
          if (!engineRef.current) return;
          // Keep very small chunks out, but do not require large payloads that
          // can delay/skip live transcription on quieter systems.
          if (!chunk || chunk.size < 64) return;

          // Batch small recorder chunks to improve STT quality for partial speech.
          pendingChunkBatchRef.current.push(chunk);
          pendingChunkBytesRef.current += chunk.size;
          const shouldFlushBatch =
            pendingChunkBytesRef.current >= 12000 || pendingChunkBatchRef.current.length >= 3;
          if (!shouldFlushBatch) return;

          const mergedChunk = new Blob(pendingChunkBatchRef.current, {
            type: chunk.type || 'audio/webm',
          });
          pendingChunkBatchRef.current = [];
          pendingChunkBytesRef.current = 0;

          audioChunkQueueRef.current.push(mergedChunk);
          if (audioChunkQueueRef.current.length > 2) {
            // Keep the newest chunks to avoid stale backlog latency.
            audioChunkQueueRef.current.shift();
          }
          if (chunkTranscribeInFlightRef.current) return;

          chunkTranscribeInFlightRef.current = true;
          try {
            while (audioChunkQueueRef.current.length > 0 && engineRef.current) {
              const nextChunk = audioChunkQueueRef.current.shift();
              if (!nextChunk) continue;

              try {
                const audio_base64 = await blobToBase64(nextChunk);
                setLiveDebug((s) => ({ ...s, transcribeCalls: s.transcribeCalls + 1 }));
                const transcribed = await window.electronAPI.sessionTranscribe({
                  audio_base64,
                  audio_mime_type: nextChunk.type || 'audio/webm',
                });

                const lines = transcribed.transcript || [];
                if (lines.length > 0) {
                  setLiveDebug((s) => ({
                    ...s,
                    transcribedLines: s.transcribedLines + lines.length,
                  }));
                }
                for (const line of lines) {
                  await processUtterance(line);
                }
              } catch (err: any) {
                // Surface transient live-transcription issues so users understand why
                // only end-session summary may appear.
                setStatus(err?.message || 'Live transcription delayed; still listening.');
                setLiveDebug((s) => ({ ...s, lastReason: err?.message || 'transcribe failed' }));
              }
            }
          } finally {
            chunkTranscribeInFlightRef.current = false;
          }
        },
        onError: (message) => setError(message),
      });

      engineRef.current = engine;
      await engine.start();
      setRunning(true);
      setStatus('Listening on microphone + speaker audio');
    } catch (err: any) {
      setError(err?.message || 'Unable to start session.');
      setStatus('Session start failed');
    }
  };

  const endSession = async () => {
    if (!engineRef.current) return;

    try {
      const { transcript, audioBlob } = await engineRef.current.stop();
      engineRef.current = null;
      setRunning(false);

      const payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string } = { transcript };
      const needsServerTranscription = transcript.length === 0 && !!audioBlob && audioBlob.size > 0;
      if (needsServerTranscription) {
        setStatus('Transcribing audio on server...');
      } else {
        setStatus('Generating session summary...');
      }

      if (audioBlob && audioBlob.size > 0) {
        payload.audio_base64 = await blobToBase64(audioBlob);
        payload.audio_mime_type = audioBlob.type || 'audio/webm';
      }

      const result = await window.electronAPI.sessionEnd(payload);
      beginAnswer();
      appendToken(`Session Summary:\n\n${result.summary}`);
      finaliseAnswer();

      setSessionLaunchAllowed(false);
      setStatus('Session ended and summary generated');
    } catch (err: any) {
      setError(err?.message || 'Unable to end session.');
      setStatus('Session end failed');
    }
  };

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,       // allows flex children to shrink past content height
      overflow: 'hidden',
    }}>

      {/* ── User header ─────────────────────────────────────────────── */}
      <div style={{
        padding: '12px 14px 10px',
        borderBottom: '1px solid var(--bg-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        flexShrink: 0,
      }}>
        {/* Greeting row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '9.5px', letterSpacing: '0.08em', fontWeight: 500 }}>
              SIGNED IN AS
            </p>
            <p style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 500, marginTop: '1px' }}>
              {username}
            </p>
          </div>
        </div>

        {/* Session counter */}
        <SessionCounter />

        {!running && canStartSession ? (
          <button
            type="button"
            onClick={startSession}
            style={{
              alignSelf: 'flex-start',
              padding: '7px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent)',
              border: 'none',
              color: '#0d1210',
              fontFamily: 'var(--font-ui)',
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              cursor: 'pointer',
            }}
          >
            Start Session
          </button>
        ) : null}

        {running ? (
          <button
            type="button"
            onClick={endSession}
            style={{
              alignSelf: 'flex-start',
              padding: '7px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'transparent',
              border: '1px solid var(--status-error)',
              color: 'var(--status-error)',
              fontFamily: 'var(--font-ui)',
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              cursor: 'pointer',
            }}
          >
            End Session
          </button>
        ) : null}
      </div>

      {/* ── Divider label ────────────────────────────────────────────── */}
      <div style={{
        padding: '7px 14px 5px',
        display: 'flex', alignItems: 'center', gap: '8px',
        flexShrink: 0,
      }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '9px', letterSpacing: '0.1em', fontWeight: 500 }}>
          AI ANSWERS
        </span>
        <div style={{ flex: 1, height: '1px', background: 'var(--bg-border)' }} />
      </div>

      {running ? (
        <div
          style={{
            margin: '0 14px 6px',
            padding: '6px 8px',
            border: '1px solid var(--bg-border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
            flexShrink: 0,
          }}
        >
          SEG={liveDebug.segmentsSeen} | STT={liveDebug.transcribeCalls} | LINES={liveDebug.transcribedLines} | Q={liveDebug.questionsDetected} | A={liveDebug.answersShown}
          <br />
          LAST: {liveDebug.lastReason}
        </div>
      ) : null}

      {/* ── AI answer stream ─────────────────────────────────────────── */}
      <AIAnswerPanel />
    </div>
  );
}
