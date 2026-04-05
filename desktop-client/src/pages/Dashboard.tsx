/**
 * src/pages/Dashboard.tsx
 * =======================
 * Main dashboard view for the NeoNexus Interview Copilot.
 *
 * New Flow (Continuous Streaming):
 *   1. User clicks "Start Session" - connects to Deepgram via backend WebSocket proxy
 *   2. Audio streams continuously to Deepgram, transcript appears in real-time
 *   3. User presses Shift to get AI help (sends last N lines to /session/help)
 *   4. AI response appears in ChatPanel (user context → right, AI answer → left)
 *   5. User clicks "End Session" - generates chunked summary, saves audio
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  useStore,
  selectSessionsRemaining,
  selectIsStreaming,
  selectCanStartStreaming,
  TranscriptLine,
} from '../lib/store';
import { ChatPanel } from '../components/ChatPanel';
import { SessionCounter } from '../components/SessionCounter';
import { AudioLevelMeter } from '../components/AudioLevelMeter';
import type { TranscriptUpdate, StreamStatus } from '../types/electron.d';

export function Dashboard() {
  // ── Store selectors ────────────────────────────────────────────────────────
  const username = useStore((s) => s.username);
  const sessionsRemaining = useStore(selectSessionsRemaining);
  const streamingState = useStore((s) => s.streamingState);
  const sessionId = useStore((s) => s.sessionId);
  const liveTranscript = useStore((s) => s.liveTranscript);
  const interimText = useStore((s) => s.interimText);
  const isStreaming = useStore(selectIsStreaming);
  const canStartStreaming = useStore(selectCanStartStreaming);

  // ── Store actions ──────────────────────────────────────────────────────────
  const setStreamingState = useStore((s) => s.setStreamingState);
  const setSessionId = useStore((s) => s.setSessionId);
  const addTranscriptLine = useStore((s) => s.addTranscriptLine);
  const updateInterimText = useStore((s) => s.updateInterimText);
  const clearTranscript = useStore((s) => s.clearTranscript);
  const setIsRecordingAudio = useStore((s) => s.setIsRecordingAudio);
  const setAudioFilePath = useStore((s) => s.setAudioFilePath);
  const setSessionLaunchAllowed = useStore((s) => s.setSessionLaunchAllowed);
  const setStatus = useStore((s) => s.setStatus);
  const setError = useStore((s) => s.setError);
  const syncProfile = useStore((s) => s.syncProfile);
  const decrementSessionsAvailable = useStore((s) => s.decrementSessionsAvailable);

  // ── Chat message actions ───────────────────────────────────────────────────
  const addUserMessage = useStore((s) => s.addUserMessage);
  const setAssistantMessage = useStore((s) => s.setAssistantMessage);
  const clearChat = useStore((s) => s.clearChat);

  // ── Local state (transient UI only) ────────────────────────────────────────
  const [processing, setProcessing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [debugInfo, setDebugInfo] = useState('');
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const helpHotkeyDebounceRef = useRef(false);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupFnsRef = useRef<(() => void)[]>([]);

  const blurActiveElement = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────
  const hasSessionsAvailable = sessionsRemaining > 0;
  const sessionActive = streamingState === 'connected' || streamingState === 'connecting';

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

  // ── Setup streaming event listeners ────────────────────────────────────────
  useEffect(() => {
    // Listen for transcript updates
    const unsubTranscript = window.electronAPI.onStreamTranscript((data: TranscriptUpdate) => {
      if (data.is_final) {
        addTranscriptLine({
          speaker: data.speaker,
          text: data.text,
          isFinal: true,
          confidence: data.confidence,
          timestamp: new Date(data.timestamp),
        });
      } else {
        updateInterimText(data.text);
      }
    });

    // Listen for connection status changes
    const unsubStatus = window.electronAPI.onStreamStatus((data: StreamStatus) => {
      console.log('[Dashboard] Stream status:', data);
      if (data.status === 'connected') {
        setStreamingState('connected');
        setStatus('Streaming - listening...');
        setDebugInfo('Connected to Deepgram. Speak to see transcript.');
      } else if (data.status === 'disconnected') {
        setStreamingState('disconnected');
        setStatus('Disconnected');
        setDebugInfo(data.message || 'Stream disconnected');
      } else if (data.status === 'error') {
        setStreamingState('error');
        setError(data.message || 'Stream error');
        setDebugInfo(`Error: ${data.message}`);
      }
    });

    cleanupFnsRef.current = [unsubTranscript, unsubStatus];

    return () => {
      cleanupFnsRef.current.forEach(fn => fn());
      cleanupFnsRef.current = [];
    };
  }, [addTranscriptLine, updateInterimText, setStreamingState, setStatus, setError]);

  // ── Start Session (connect streaming) ──────────────────────────────────────
  const startSession = useCallback(async () => {
    try {
      setIsConnecting(true);
      setStatus('Starting session...');
      setStreamingState('connecting');
      
      // First, call backend to check session permissions
      const gate = await window.electronAPI.sessionStart();

      if (!gate.allowed) {
        setSessionLaunchAllowed(false);
        setStreamingState('disconnected');
        setIsConnecting(false);
        setStatus(gate.reason || 'Session not permitted by admin.');
        setError(gate.reason || 'Session not permitted. Contact admin.');
        return;
      }

      // Get microphone access
      console.log('[Dashboard] Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        } 
      });
      console.log('[Dashboard] Microphone access granted');
      setAudioStream(stream);

      // Connect to streaming WebSocket
      const connectResult = await window.electronAPI.streamConnect();
      if (!connectResult.success) {
        stream.getTracks().forEach(t => t.stop());
        setAudioStream(null);
        setStreamingState('error');
        setIsConnecting(false);
        setError(connectResult.error || 'Failed to connect to streaming service');
        return;
      }

      setSessionId(connectResult.sessionId || null);
      
      // Start local audio recording
      const recordingResult = await window.electronAPI.startAudioRecording();
      if (recordingResult.success) {
        setIsRecordingAudio(true);
        setAudioFilePath(recordingResult.path || null);
      }

      // Setup MediaRecorder to send audio chunks
      const recorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          const buffer = await e.data.arrayBuffer();
          
          // Send to Deepgram via WebSocket
          window.electronAPI.streamSendAudio(buffer);
          
          // Also save locally
          window.electronAPI.writeAudioChunk(buffer);
        }
      };

      recorder.start(250); // Send chunks every 250ms
      mediaRecorderRef.current = recorder;

      // Reset UI state
      clearTranscript();
      clearChat();
      setElapsedSeconds(0);
      blurActiveElement();
      
      // Start elapsed timer
      elapsedTimerRef.current = setInterval(() => {
        setElapsedSeconds(prev => prev + 1);
      }, 1000);

      setIsConnecting(false);
      setSessionLaunchAllowed(true);
      setStatus('Session started - streaming audio');
      setDebugInfo('Listening... Press Shift for AI help');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to start session.';
      setError(msg);
      setStatus('Failed to start session');
      setStreamingState('disconnected');
      setIsConnecting(false);
    }
  }, [
    setStatus,
    setError,
    setStreamingState,
    setSessionId,
    setSessionLaunchAllowed,
    setIsRecordingAudio,
    setAudioFilePath,
    clearTranscript,
    clearChat,
    blurActiveElement,
  ]);

  // ── End Session ────────────────────────────────────────────────────────────
  const endSession = useCallback(async () => {
    // Stop MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    // Stop audio stream
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      setAudioStream(null);
    }

    // Stop elapsed timer
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }

    // Stop local recording
    await window.electronAPI.stopAudioRecording();
    setIsRecordingAudio(false);

    // Disconnect streaming
    const disconnectResult = await window.electronAPI.streamDisconnect();
    console.log('[Dashboard] Disconnect result:', disconnectResult);

    setStreamingState('disconnected');
    blurActiveElement();
    setStatus('Generating summary...');
    setDebugInfo('Processing session transcript...');

    try {
      // Build full transcript from lines
      const transcriptLines = liveTranscript.map(line => line.text);
      
      // End session with chunked summarization
      const result = await window.electronAPI.sessionEnd({
        transcript: transcriptLines,
        session_id: sessionId || undefined,
      });
      
      decrementSessionsAvailable();
      setStatus('Session ended');
      setDebugInfo(`Summary generated (${result.summary?.length || 0} chars)`);
      
      // Optionally show summary in chat
      if (result.summary) {
        setAssistantMessage(`**Session Summary:**\n\n${result.summary}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to end session';
      setError(msg);
      setDebugInfo(`Error ending session: ${msg}`);
    }

    clearTranscript();
    setSessionId(null);
    setAudioFilePath(null);
  }, [
    audioStream,
    sessionId,
    liveTranscript,
    setStreamingState,
    setIsRecordingAudio,
    setAudioFilePath,
    setSessionId,
    setStatus,
    setError,
    setAssistantMessage,
    clearTranscript,
    decrementSessionsAvailable,
    blurActiveElement,
  ]);

  // ── Request AI Help (Shift hotkey) ─────────────────────────────────────────
  const requestHelp = useCallback(async () => {
    if (processing) return;
    
    setProcessing(true);
    setStatus('Getting AI help...');
    
    // Get last few lines for context display
    const contextLines = liveTranscript.slice(-4);
    const contextText = contextLines.map(l => l.text).join('\n');
    
    // Show what we're sending as user message
    if (contextText.trim()) {
      addUserMessage(`[Context: Last ${contextLines.length} lines]\n${contextText}`);
    }

    try {
      const result = await window.electronAPI.sessionHelp({
        sessionId: sessionId || undefined,
        contextLines: 4,
      });

      if (result.success && result.answer) {
        setAssistantMessage(result.answer);
        setStatus('Streaming - listening...');
        setDebugInfo('AI help displayed. Continue speaking.');
      } else {
        setStatus(result.reason || 'No help available');
        setDebugInfo(result.reason || 'AI could not generate help');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to get help';
      setError(msg);
      setDebugInfo(`Error: ${msg}`);
    } finally {
      setProcessing(false);
    }
  }, [
    processing,
    sessionId,
    liveTranscript,
    addUserMessage,
    setAssistantMessage,
    setStatus,
    setError,
  ]);

  // ── Shift Hotkey Handler ───────────────────────────────────────────────────
  const handleHelpHotkey = useCallback(
    (e: KeyboardEvent) => {
      const isShiftKey = e.code === 'ShiftLeft' || e.code === 'ShiftRight';
      if (!isShiftKey || !sessionActive) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (e.repeat || processing) {
        return;
      }

      if (helpHotkeyDebounceRef.current) return;
      helpHotkeyDebounceRef.current = true;
      setTimeout(() => {
        helpHotkeyDebounceRef.current = false;
      }, 500);

      blurActiveElement();
      requestHelp();
    },
    [sessionActive, processing, requestHelp, blurActiveElement]
  );

  const preventHelpHotkeyKeyup = useCallback(
    (e: KeyboardEvent) => {
      const isShiftKey = e.code === 'ShiftLeft' || e.code === 'ShiftRight';
      if (!isShiftKey || !sessionActive) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    [sessionActive]
  );

  // ── Attach/detach shift hotkey listener ────────────────────────────────────
  useEffect(() => {
    window.addEventListener('keydown', handleHelpHotkey, true);
    window.addEventListener('keyup', preventHelpHotkeyKeyup, true);
    return () => {
      window.removeEventListener('keydown', handleHelpHotkey, true);
      window.removeEventListener('keyup', preventHelpHotkeyKeyup, true);
    };
  }, [handleHelpHotkey, preventHelpHotkeyKeyup]);

  // ── Format elapsed time ────────────────────────────────────────────────────
  const formatElapsed = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

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
          
          {/* Session timer (when active) */}
          {sessionActive && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--accent)',
              }}
            >
              {formatElapsed(elapsedSeconds)}
            </div>
          )}
        </div>

        <SessionCounter />

        {!sessionActive && hasSessionsAvailable && (
          <button
            type="button"
            onClick={startSession}
            onMouseUp={(e) => e.currentTarget.blur()}
            disabled={isConnecting}
            style={{
              alignSelf: 'flex-start',
              padding: '7px 12px',
              borderRadius: 'var(--radius-md)',
              background: isConnecting ? 'var(--bg-tertiary)' : 'var(--accent)',
              border: 'none',
              color: isConnecting ? 'var(--text-muted)' : '#0d1210',
              fontFamily: 'var(--font-ui)',
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              cursor: isConnecting ? 'wait' : 'pointer',
            }}
          >
            {isConnecting ? 'Connecting...' : 'Start Session'}
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

      {/* Live transcript panel */}
      {sessionActive && (
        <div
          style={{
            margin: '8px 14px 0',
            padding: '10px 12px',
            border: '1px solid var(--bg-border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-secondary)',
            maxHeight: '120px',
            overflowY: 'auto',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '6px',
            }}
          >
            <span
              style={{
                fontSize: '9px',
                fontWeight: 600,
                letterSpacing: '0.1em',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
              }}
            >
              LIVE TRANSCRIPT
            </span>
            <span
              style={{
                fontSize: '8px',
                color: streamingState === 'connected' ? 'var(--status-success)' : 'var(--text-muted)',
              }}
            >
              {streamingState === 'connected' ? '● STREAMING' : streamingState.toUpperCase()}
            </span>
          </div>
          
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              lineHeight: 1.6,
              color: 'var(--text-primary)',
            }}
          >
            {liveTranscript.length === 0 && !interimText && (
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Waiting for speech...
              </span>
            )}
            {liveTranscript.slice(-5).map((line) => (
              <div key={line.id} style={{ marginBottom: '2px' }}>
                <span style={{ color: 'var(--accent)', marginRight: '4px' }}>
                  [{line.speaker}]
                </span>
                {line.text}
              </div>
            ))}
            {interimText && (
              <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {interimText}...
              </div>
            )}
          </div>
          
          <AudioLevelMeter stream={audioStream} isRecording={streamingState === 'connected'} />
        </div>
      )}

      {/* Shift hotkey hint */}
      {sessionActive && (
        <div
          style={{
            margin: '6px 14px 0',
            padding: '8px 12px',
            border: processing ? '1px solid var(--accent)' : '1px solid var(--bg-border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: processing ? 'var(--accent)' : 'var(--text-muted)',
            textAlign: 'center',
            fontWeight: processing ? 700 : 400,
            background: processing ? 'rgba(0,255,136,0.08)' : 'transparent',
            flexShrink: 0,
          }}
        >
          {processing
            ? 'Getting AI help...'
            : 'Press SHIFT to get AI help with last 3-4 lines'}
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
          AI ASSISTANCE
        </span>
        <div style={{ flex: 1, height: '1px', background: 'var(--bg-border)' }} />
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: '8px',
            opacity: 0.6,
          }}
        >
          Context → Right | AI → Left
        </span>
      </div>

      <ChatPanel />
    </div>
  );
}
