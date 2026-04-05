/**
 * src/lib/store.ts
 * ================
 * Zustand global store — single source of truth for the renderer process.
 *
 * Slices:
 *   auth        — JWT presence, user identity, session counts
 *   recording   — FSM: idle → recording → stopping → uploading → idle
 *   aiAnswer    — streaming token buffer + display state
 *   ui          — transient UI state (errors, upload progress)
 *
 * The JWT is NOT stored here — it lives in main-process memory.
 * The renderer only knows the token exists (isAuthenticated flag).
 * All authenticated calls go through IPC, never directly from renderer.
 */

import { create } from 'zustand';

// ── Recording state machine ───────────────────────────────────────────────────
export type RecordingState =
  | 'idle'       // no session active
  | 'starting'   // reserved state for future live features
  | 'recording'  // reserved state for future live features
  | 'stopping'   // reserved state for future live features
  | 'uploading'  // reserved state for future live features
  | 'error';     // something went wrong

// ── Answer display state ──────────────────────────────────────────────────────
export interface AnswerBlock {
  id:        string;
  text:      string;
  streaming: boolean;   // true = cursor visible, false = complete
  timestamp: Date;
}

// ── Chat message type (user utterance or AI response) ─────────────────────────
export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id:        string;
  role:      MessageRole;
  text:      string;
  streaming: boolean;   // true = still receiving tokens (for assistant)
  timestamp: Date;
}

// ── Store shape ───────────────────────────────────────────────────────────────
interface AppState {
  // ── Auth ──────────────────────────────────────────────────────────────
  isAuthenticated:    boolean;
  userId:             number | null;
  username:           string;
  permittedSessions:  number;
  usedSessions:       number;
  sessionLaunchAllowed: boolean;

  // ── Recording ─────────────────────────────────────────────────────────
  recordingState:     RecordingState;
  videoPath:          string | null;
  sessionStart:       number | null;   // Date.now() at start
  elapsedSeconds:     number;          // ticked by a setInterval in Dashboard

  // ── AI answers ────────────────────────────────────────────────────────
  answers:            AnswerBlock[];
  currentAnswerId:    string | null;   // ID of the block being streamed into

  // ── Chat messages (user + AI in conversation view) ─────────────────────
  chatMessages:       ChatMessage[];
  currentChatMsgId:   string | null;   // ID of message being streamed

  // ── UI ────────────────────────────────────────────────────────────────
  errorMessage:       string | null;
  uploadProgress:     number;          // 0–100
  statusMessage:      string;          // shown in status bar

  // ── Actions ───────────────────────────────────────────────────────────
  login:  (payload: {
    userId:            number;
    username:          string;
    permittedSessions: number;
    usedSessions:      number;
    sessionLaunchAllowed: boolean;
  }) => void;
  logout: () => void;
  setSessionLaunchAllowed: (value: boolean) => void;
  syncProfile: (payload: {
    username: string;
    permittedSessions: number;
    usedSessions: number;
  }) => void;

  setRecordingState: (state: RecordingState) => void;
  setVideoPath:      (path: string | null)   => void;
  setSessionStart:   (ts: number | null)     => void;
  tickElapsed:       ()                      => void;
  resetElapsed:      ()                      => void;

  // Called when WS sends __ANSWER_START__
  beginAnswer: () => void;
  // Called for each token chunk
  appendToken: (token: string) => void;
  // Called when WS sends __ANSWER_END__
  finaliseAnswer: () => void;
  // Clear all answers (on new recording start)
  clearAnswers: () => void;

  // ── Chat message actions ───────────────────────────────────────────────
  addUserMessage: (text: string) => void;
  beginAssistantMessage: () => void;
  appendAssistantToken: (token: string) => void;
  finaliseAssistantMessage: () => void;
  clearChat: () => void;

  setError:          (msg: string | null)  => void;
  setUploadProgress: (pct: number)         => void;
  setStatus:         (msg: string)         => void;

  // Sync session counts after a recording stops
  decrementSessionsAvailable: () => void;
}

// ── Store implementation ──────────────────────────────────────────────────────
export const useStore = create<AppState>((set, get) => ({
  // ── Auth defaults ─────────────────────────────────────────────────────
  isAuthenticated:   false,
  userId:            null,
  username:          '',
  permittedSessions: 0,
  usedSessions:      0,
  sessionLaunchAllowed: false,

  // ── Recording defaults ────────────────────────────────────────────────
  recordingState:    'idle',
  videoPath:         null,
  sessionStart:      null,
  elapsedSeconds:    0,

  // ── Answer defaults ───────────────────────────────────────────────────
  answers:           [],
  currentAnswerId:   null,

  // ── Chat defaults ─────────────────────────────────────────────────────
  chatMessages:      [],
  currentChatMsgId:  null,

  // ── UI defaults ───────────────────────────────────────────────────────
  errorMessage:      null,
  uploadProgress:    0,
  statusMessage:     'Ready',

  // ── Auth actions ──────────────────────────────────────────────────────
  login: (payload) => set({
    isAuthenticated:   true,
    userId:            payload.userId,
    username:          payload.username,
    permittedSessions: payload.permittedSessions,
    usedSessions:      payload.usedSessions,
    sessionLaunchAllowed: payload.sessionLaunchAllowed,
    statusMessage:     'Ready',
    errorMessage:      null,
  }),

  logout: () => set({
    isAuthenticated:   false,
    userId:            null,
    username:          '',
    permittedSessions: 0,
    usedSessions:      0,
    sessionLaunchAllowed: false,
    recordingState:    'idle',
    videoPath:         null,
    sessionStart:      null,
    elapsedSeconds:    0,
    answers:           [],
    currentAnswerId:   null,
    chatMessages:      [],
    currentChatMsgId:  null,
    errorMessage:      null,
    uploadProgress:    0,
    statusMessage:     'Signed out',
  }),

  setSessionLaunchAllowed: (value) => set({ sessionLaunchAllowed: value }),

  syncProfile: (payload) => set({
    username: payload.username,
    permittedSessions: payload.permittedSessions,
    usedSessions: payload.usedSessions,
  }),

  // ── Recording actions ─────────────────────────────────────────────────
  setRecordingState: (state) => set({ recordingState: state }),
  setVideoPath:      (path)  => set({ videoPath: path }),
  setSessionStart:   (ts)    => set({ sessionStart: ts }),
  tickElapsed:       ()      => set((s) => ({ elapsedSeconds: s.elapsedSeconds + 1 })),
  resetElapsed:      ()      => set({ elapsedSeconds: 0 }),

  // ── Answer stream actions ─────────────────────────────────────────────
  beginAnswer: () => {
    const id = `ans_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      currentAnswerId: id,
      answers: [
        { id, text: '', streaming: true, timestamp: new Date() },
        ...s.answers,           // prepend so newest is at top
      ].slice(0, 20),           // cap history at 20 answers
    }));
  },

  appendToken: (token) => {
    const { currentAnswerId } = get();
    if (!currentAnswerId) return;
    set((s) => ({
      answers: s.answers.map((a) =>
        a.id === currentAnswerId ? { ...a, text: a.text + token } : a
      ),
    }));
  },

  finaliseAnswer: () => {
    const { currentAnswerId } = get();
    if (!currentAnswerId) return;
    set((s) => ({
      currentAnswerId: null,
      answers: s.answers.map((a) =>
        a.id === currentAnswerId ? { ...a, streaming: false } : a
      ),
    }));
  },

  clearAnswers: () => set({ answers: [], currentAnswerId: null }),

  // ── Chat message actions ──────────────────────────────────────────────
  addUserMessage: (text: string) => {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      chatMessages: [
        ...s.chatMessages,
        { id, role: 'user' as const, text, streaming: false, timestamp: new Date() },
      ].slice(-40),  // keep last 40 messages
    }));
  },

  beginAssistantMessage: () => {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      currentChatMsgId: id,
      chatMessages: [
        ...s.chatMessages,
        { id, role: 'assistant' as const, text: '', streaming: true, timestamp: new Date() },
      ].slice(-40),
    }));
  },

  appendAssistantToken: (token: string) => {
    const { currentChatMsgId } = get();
    if (!currentChatMsgId) return;
    set((s) => ({
      chatMessages: s.chatMessages.map((m) =>
        m.id === currentChatMsgId ? { ...m, text: m.text + token } : m
      ),
    }));
  },

  finaliseAssistantMessage: () => {
    const { currentChatMsgId } = get();
    if (!currentChatMsgId) return;
    set((s) => ({
      currentChatMsgId: null,
      chatMessages: s.chatMessages.map((m) =>
        m.id === currentChatMsgId ? { ...m, streaming: false } : m
      ),
    }));
  },

  clearChat: () => set({ chatMessages: [], currentChatMsgId: null }),

  // ── UI actions ────────────────────────────────────────────────────────
  setError:          (msg) => set({ errorMessage: msg }),
  setUploadProgress: (pct) => set({ uploadProgress: pct }),
  setStatus:         (msg) => set({ statusMessage: msg }),

  decrementSessionsAvailable: () =>
    set((s) => ({ usedSessions: Math.min(s.usedSessions + 1, s.permittedSessions) })),
}));

// ── Derived selectors (memoised outside store to avoid re-renders) ────────────
export const selectSessionsRemaining = (s: AppState) =>
  Math.max(0, s.permittedSessions - s.usedSessions);

export const selectCanRecord = (s: AppState) =>
  s.isAuthenticated &&
  s.recordingState === 'idle' &&
  s.usedSessions < s.permittedSessions;

export const selectCanStartSession = (s: AppState) =>
  s.isAuthenticated && s.sessionLaunchAllowed;

export const selectIsActive = (s: AppState) =>
  s.recordingState === 'recording' || s.recordingState === 'starting';
