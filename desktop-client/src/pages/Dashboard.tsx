/**
 * src/pages/Dashboard.tsx
 * =======================
 * Main dashboard view for the NeoNexus Interview Copilot.
 *
 * Flow:
 *   1. User clicks "Start Session" (calls backend /session/start)
 *   2. User presses Spacebar to start recording (MediaRecorder)
 *   3. User presses Spacebar again to stop recording
 *   4. Audio is transcribed via backend /session/transcribe (Deepgram)
 *   5. Transcript is sent to /session/respond for AI answer
 *   6. Conversation is shown in ChatPanel (You right, AI left)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  useStore,
  selectSessionsRemaining,
} from '../lib/store';
import { ChatPanel } from '../components/ChatPanel';
import { SessionCounter } from '../components/SessionCounter';
import { AudioLevelMeter } from '../components/AudioLevelMeter';

export function Dashboard() {
  // ── Store selectors ────────────────────────────────────────────────────────
  const username = useStore((s) => s.username);
  const recordingState = useStore((s) => s.recordingState);
  const sessionsRemaining = useStore(selectSessionsRemaining);

  // ── Store actions ──────────────────────────────────────────────────────────
  const setRecordingState = useStore((s) => s.setRecordingState);
  const setSessionLaunchAllowed = useStore((s) => s.setSessionLaunchAllowed);
  const setStatus = useStore((s) => s.setStatus);
  const setError = useStore((s) => s.setError);
  const syncProfile = useStore((s) => s.syncProfile);
  const decrementSessionsAvailable = useStore((s) => s.decrementSessionsAvailable);

  // ── Chat message actions ───────────────────────────────────────────────────
  const addUserMessage = useStore((s) => s.addUserMessage);
  const beginAssistantMessage = useStore((s) => s.beginAssistantMessage);
  const appendAssistantToken = useStore((s) => s.appendAssistantToken);
  const finaliseAssistantMessage = useStore((s) => s.finaliseAssistantMessage);
  const clearChat = useStore((s) => s.clearChat);

  // ── Local state (transient UI only) ────────────────────────────────────────
  const [sessionActive, setSessionActive] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [debugInfo, setDebugInfo] = useState('');
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcriptHistoryRef = useRef<string[]>([]);
  const spaceDebounceRef = useRef(false);

  const blurActiveElement = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────
  const hasSessionsAvailable = sessionsRemaining > 0;
  const isRecording = recordingState === 'recording';

  // ── Profile sync (poll every 5s) ───────────────────────────────────────────
  useEffect(() => {
    let alive = true;

    const refreshProfile = async () => {
      try {
        const profile = await window.electronAPI.getUserProfile();
        if (!alive) return;

        syncProfile({
          username: profile.username || 'User',
          permittedSessions: profile.permitted_sessions,
          usedSessions: profile.used_sessions,
        });

        const canStart = profile.sessions_remaining > 0;
        setSessionLaunchAllowed(canStart);
      } catch {
        if (!alive) return;
      }
    };

    refreshProfile();
    const timer = window.setInterval(refreshProfile, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [syncProfile, setSessionLaunchAllowed]);

  // ── Start Session ──────────────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    try {
      setStatus('Starting session...');
      const gate = await window.electronAPI.sessionStart();

      if (!gate.allowed) {
        setSessionLaunchAllowed(false);
        setStatus(gate.reason || 'Session not permitted by admin.');
        setError(gate.reason || 'Session not permitted. Contact admin.');
        return;
      }

      setSessionActive(true);
      setSessionLaunchAllowed(true);
      blurActiveElement();
      transcriptHistoryRef.current = [];
      clearChat();
      setStatus('Session started - press Spacebar to record');
      setDebugInfo('Ready to record. Press Spacebar and speak.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to start session.';
      setError(msg);
      setStatus('Failed to start session');
    }
  }, [
    setStatus,
    setError,
    setSessionLaunchAllowed,
    clearChat,
    blurActiveElement,
  ]);

  // ── End Session ────────────────────────────────────────────────────────────
  const endSession = useCallback(async () => {
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecordingState('idle');
    }

    blurActiveElement();
    setSessionActive(false);
    setStatus('Session ended');
    setDebugInfo('');

    try {
      await window.electronAPI.sessionEnd({
        transcript: transcriptHistoryRef.current,
      });
      decrementSessionsAvailable();
    } catch {
      // Silent fail
    }
  }, [
    isRecording,
    setRecordingState,
    setStatus,
    decrementSessionsAvailable,
    blurActiveElement,
  ]);

  // ── Start Recording ────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      console.log('[Dashboard] startRecording: requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[Dashboard] startRecording: microphone access granted');
      setAudioStream(stream);

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        console.log('[Dashboard] recorder.onstop: total chunks =', chunksRef.current.length);
        stream.getTracks().forEach((t) => t.stop());
        setAudioStream(null);

        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
        console.log('[Dashboard] audioBlob size =', audioBlob.size, 'bytes');

        if (audioBlob.size === 0) {
          setStatus('No audio captured - try again');
          setDebugInfo('No audio captured (0 bytes)');
          setRecordingState('idle');
          setProcessing(false);
          return;
        }

        setProcessing(true);
        setRecordingState('uploading');
        setStatus('Transcribing audio...');
        setDebugInfo('Sending audio to backend transcriber (Deepgram)...');

        try {
          const buffer = await audioBlob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            const chunk = bytes.subarray(i, i + 0x8000);
            binary += String.fromCharCode(...chunk);
          }
          const audio_base64 = btoa(binary);
          console.log('[Dashboard] audio_base64 length =', audio_base64.length);

          console.log('[Dashboard] calling sessionTranscribe...');
          const transcribed = await window.electronAPI.sessionTranscribe({
            audio_base64,
            audio_mime_type: 'audio/webm',
          });
          console.log('[Dashboard] sessionTranscribe result:', JSON.stringify(transcribed));

          const lines = transcribed.transcript || [];
          const text = lines.filter((l) => l.trim()).join(' ').trim();

          if (!text) {
            setStatus('No speech detected - try again');
            setDebugInfo('Transcriber returned empty transcript');
            setRecordingState('idle');
            setProcessing(false);
            return;
          }

          // Right side user message
          addUserMessage(text);
          transcriptHistoryRef.current.push(text);

          setDebugInfo(`Transcribed: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
          setStatus('Getting AI answer...');

          console.log('[Dashboard] calling sessionRespond...');
          const result = await window.electronAPI.sessionRespond({
            utterance: text,
            history: transcriptHistoryRef.current.slice(-20),
          });
          console.log('[Dashboard] sessionRespond result:', JSON.stringify(result).slice(0, 500));

          if (result.should_respond && result.answer) {
            // Left side assistant message
            beginAssistantMessage();
            appendAssistantToken(result.answer);
            finaliseAssistantMessage();
            setStatus('Answer ready - press Spacebar to record again');
            setDebugInfo('AI answer displayed');
          } else {
            setStatus(result.reason || 'No answer generated - try again');
            setDebugInfo(result.reason || 'AI decided not to respond');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to process audio';
          setError(msg);
          setDebugInfo(`Error: ${msg}`);
        } finally {
          setRecordingState('idle');
          setProcessing(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecordingState('recording');
      setStatus('Recording... press Spacebar to stop');
      setDebugInfo('Listening for your voice...');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied';
      setError(msg);
      setDebugInfo('Could not access microphone');
      setRecordingState('error');
    }
  }, [
    setRecordingState,
    setStatus,
    setError,
    addUserMessage,
    beginAssistantMessage,
    appendAssistantToken,
    finaliseAssistantMessage,
  ]);

  // ── Stop Recording ─────────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setRecordingState('stopping');
      setStatus('Processing...');
    }
  }, [setRecordingState, setStatus]);

  // ── Spacebar Handler ───────────────────────────────────────────────────────
  const handleSpacebar = useCallback(
    (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !sessionActive) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (e.repeat || processing) {
        return;
      }

      if (spaceDebounceRef.current) return;
      spaceDebounceRef.current = true;
      setTimeout(() => {
        spaceDebounceRef.current = false;
      }, 300);

      blurActiveElement();
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    },
    [isRecording, sessionActive, processing, startRecording, stopRecording, blurActiveElement]
  );

  const preventSpacebarKeyup = useCallback(
    (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !sessionActive) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    [sessionActive]
  );

  // ── Attach/detach spacebar listener ────────────────────────────────────────
  useEffect(() => {
    window.addEventListener('keydown', handleSpacebar, true);
    window.addEventListener('keyup', preventSpacebarKeyup, true);
    return () => {
      window.removeEventListener('keydown', handleSpacebar, true);
      window.removeEventListener('keyup', preventSpacebarKeyup, true);
    };
  }, [handleSpacebar, preventSpacebarKeyup]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 14px 10px',
          borderBottom: '1px solid var(--bg-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p
              style={{
                color: 'var(--text-muted)',
                fontSize: '9.5px',
                letterSpacing: '0.08em',
                fontWeight: 500,
              }}
            >
              SIGNED IN AS
            </p>
            <p
              style={{
                color: 'var(--text-primary)',
                fontSize: '13px',
                fontWeight: 500,
                marginTop: '1px',
              }}
            >
              {username}
            </p>
          </div>
        </div>

        <SessionCounter />

        {!sessionActive && hasSessionsAvailable && (
          <button
            type="button"
            onClick={startSession}
            onMouseUp={(e) => e.currentTarget.blur()}
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
        )}

        {!sessionActive && !hasSessionsAvailable && (
          <p style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
            No sessions remaining - contact admin
          </p>
        )}

        {sessionActive && (
          <button
            type="button"
            onClick={endSession}
            onMouseUp={(e) => e.currentTarget.blur()}
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
        )}
      </div>

      {/* Recording indicator */}
      {sessionActive && (
        <div
          style={{
            margin: '8px 14px 0',
            padding: '10px 12px',
            border: isRecording ? '1px solid #ef4444' : '1px solid var(--bg-border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: isRecording ? '#ef4444' : 'var(--text-muted)',
            textAlign: 'center',
            fontWeight: isRecording ? 700 : 400,
            background: isRecording ? 'rgba(239,68,68,0.08)' : 'transparent',
            flexShrink: 0,
          }}
        >
          {isRecording
            ? 'RECORDING - Press Spacebar to stop'
            : processing
              ? 'Processing audio...'
              : 'Press Spacebar to record'}

          <AudioLevelMeter stream={audioStream} isRecording={isRecording} />
        </div>
      )}

      {/* Debug */}
      {sessionActive && debugInfo && (
        <div
          style={{
            margin: '4px 14px 0',
            padding: '6px 8px',
            border: '1px solid var(--bg-border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
            flexShrink: 0,
          }}
        >
          {debugInfo}
        </div>
      )}

      {/* Conversation header */}
      <div
        style={{
          padding: '7px 14px 5px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: '9px',
            letterSpacing: '0.1em',
            fontWeight: 500,
          }}
        >
          CONVERSATION
        </span>
        <div style={{ flex: 1, height: '1px', background: 'var(--bg-border)' }} />
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: '8px',
            opacity: 0.6,
          }}
        >
          You → Right | AI → Left
        </span>
      </div>

      <ChatPanel />
    </div>
  );
}
