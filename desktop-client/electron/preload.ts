/**
 * electron/preload.ts
 * ====================
 * Runs in an isolated context between main and renderer.
 * Exposes a minimal, typed API surface via contextBridge.
 *
 * RULE: Nothing in here should contain business logic.
 *       It is a pure thin-wire translation layer:
 *           renderer calls window.electronAPI.foo(args)
 *           → preload calls ipcRenderer.invoke("channel", args)
 *           → main process handles it and returns a result.
 *
 * The renderer never sees ipcRenderer directly (contextIsolation: true).
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import { IpcChannels } from "./ipc-handlers";

// ── Type definitions for the exposed API ─────────────────────────────────────
// Keep these in sync with the renderer-side type declaration in
// src/types/electron.d.ts so TypeScript is happy on both sides.

export interface TranscriptUpdate {
  type: "transcript";
  speaker: string;
  text: string;
  is_final: boolean;
  confidence: number;
  timestamp: number;
}

export interface StreamStatus {
  status: "connected" | "disconnected" | "error";
  message?: string;
  code?: number;
  reason?: string;
}

export interface AppSettings {
  audioStoragePath: string;
  defaultContextLines: number;
}

export interface ElectronAPI {
  // Auth
  login:  (token: string, userId: number, backendUrl?: string) => Promise<{ success: boolean }>;
  logout: () => Promise<{ success: boolean }>;

  // Window controls
  minimiseWindow:          () => Promise<{ success: boolean }>;
  toggleMaximiseWindow:    () => Promise<{ success: boolean; isMaximized: boolean }>;
  closeWindow:             () => Promise<{ success: boolean }>;
  dragWindowBy:            (dx: number, dy: number) => Promise<void>;
  setAlwaysOnTop:          (value: boolean) => void;
  setContentProtection:    (value: boolean) => void;

  // Utilities
  getAppVersion:  () => Promise<string>;
  getSystemInfo:  () => Promise<Record<string, string>>;
  showError:      (title: string, message: string) => Promise<void>;

  // User session pipeline (legacy)
  sessionStart: () => Promise<{ allowed: boolean; active_slot?: number | null; reason?: string }>;
  sessionRespond: (payload: { utterance: string; history: string[] }) => Promise<{ should_respond: boolean; answer?: string; reason?: string }>;
  sessionTranscribe: (payload: { audio_base64: string; audio_mime_type?: string }) => Promise<{ transcript: string[] }>;
  sessionEnd: (payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string; session_id?: string }) => Promise<{ summary: string }>;

  // Streaming transcription
  streamConnect: () => Promise<{ success: boolean; sessionId?: string; error?: string }>;
  streamDisconnect: () => Promise<{ success: boolean; sessionId?: string }>;
  streamSendAudio: (audioChunk: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  onStreamTranscript: (callback: (data: TranscriptUpdate) => void) => () => void;
  onStreamStatus: (callback: (data: StreamStatus) => void) => () => void;

  // Hotkey help
  sessionHelp: (payload?: { sessionId?: string; contextLines?: number }) => Promise<{
    success: boolean;
    context?: string;
    answer?: string;
    reason?: string;
  }>;

  // Settings
  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: Partial<AppSettings>) => Promise<{ success: boolean; settings: AppSettings }>;
  getAudioStoragePath: () => Promise<string>;
  setAudioStoragePath: (path: string) => Promise<{ success: boolean; path: string }>;
  browseFolder: () => Promise<{ success: boolean; canceled?: boolean; path?: string }>;

  // Local audio recording
  startAudioRecording: () => Promise<{ success: boolean; path?: string; error?: string }>;
  stopAudioRecording: () => Promise<{ success: boolean; path?: string; error?: string }>;
  writeAudioChunk: (chunk: ArrayBuffer) => void;
  getRecordingPath: () => Promise<{ path: string | null; isRecording: boolean }>;

  // User profile sync
  getUserProfile: () => Promise<{
    id: number;
    username: string;
    email: string;
    permitted_sessions: number;
    used_sessions: number;
    sessions_remaining: number;
    custom_prompt: string | null;
    is_active: boolean;
  }>;
}

// ── Expose API ────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld("electronAPI", {
  // ── Auth ──────────────────────────────────────────────────────────────
  login: (token: string, userId: number, backendUrl?: string) =>
    ipcRenderer.invoke(IpcChannels.LOGIN, { token, userId, backendUrl }),

  logout: () =>
    ipcRenderer.invoke(IpcChannels.LOGOUT),

  // ── Window controls ───────────────────────────────────────────────────
  minimiseWindow: () =>
    ipcRenderer.invoke(IpcChannels.WINDOW_MINIMISE),

  toggleMaximiseWindow: () =>
    ipcRenderer.invoke(IpcChannels.WINDOW_TOGGLE_MAXIMISE),

  closeWindow: () =>
    ipcRenderer.invoke(IpcChannels.WINDOW_CLOSE),

  dragWindowBy: (dx: number, dy: number) =>
    ipcRenderer.invoke(IpcChannels.WINDOW_DRAG_BY, { dx, dy }),

  setAlwaysOnTop: (value: boolean) =>
    ipcRenderer.send(IpcChannels.WINDOW_TOGGLE_ALWAYS_ON_TOP, value),

  setContentProtection: (value: boolean) =>
    ipcRenderer.send(IpcChannels.WINDOW_TOGGLE_CONTENT_PROTECTION, value),

  // ── Utilities ─────────────────────────────────────────────────────────
  getAppVersion: () =>
    ipcRenderer.invoke(IpcChannels.GET_APP_VERSION),

  getSystemInfo: () =>
    ipcRenderer.invoke(IpcChannels.GET_SYSTEM_INFO),

  showError: (title: string, message: string) =>
    ipcRenderer.invoke(IpcChannels.SHOW_ERROR_DIALOG, { title, message }),

  // ── User session pipeline (legacy) ────────────────────────────────────
  sessionStart: () =>
    ipcRenderer.invoke(IpcChannels.SESSION_START),

  sessionRespond: (payload: { utterance: string; history: string[] }) =>
    ipcRenderer.invoke(IpcChannels.SESSION_RESPOND, payload),

  sessionTranscribe: (payload: { audio_base64: string; audio_mime_type?: string }) =>
    ipcRenderer.invoke(IpcChannels.SESSION_TRANSCRIBE, payload),

  sessionEnd: (payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string; session_id?: string }) =>
    ipcRenderer.invoke(IpcChannels.SESSION_END, payload),

  // ── Streaming transcription ───────────────────────────────────────────
  streamConnect: () =>
    ipcRenderer.invoke(IpcChannels.STREAM_CONNECT),

  streamDisconnect: () =>
    ipcRenderer.invoke(IpcChannels.STREAM_DISCONNECT),

  streamSendAudio: (audioChunk: ArrayBuffer) =>
    ipcRenderer.invoke(IpcChannels.STREAM_SEND_AUDIO, audioChunk),

  onStreamTranscript: (callback: (data: TranscriptUpdate) => void) => {
    const handler = (_event: IpcRendererEvent, data: TranscriptUpdate) => callback(data);
    ipcRenderer.on(IpcChannels.STREAM_TRANSCRIPT, handler);
    // Return unsubscribe function
    return () => ipcRenderer.removeListener(IpcChannels.STREAM_TRANSCRIPT, handler);
  },

  onStreamStatus: (callback: (data: StreamStatus) => void) => {
    const handler = (_event: IpcRendererEvent, data: StreamStatus) => callback(data);
    ipcRenderer.on(IpcChannels.STREAM_STATUS, handler);
    return () => ipcRenderer.removeListener(IpcChannels.STREAM_STATUS, handler);
  },

  // ── Hotkey help ──────────────────────────────────────────────────────
  sessionHelp: (payload?: { sessionId?: string; contextLines?: number }) =>
    ipcRenderer.invoke(IpcChannels.SESSION_HELP, payload || {}),

  // ── Settings ──────────────────────────────────────────────────────────
  getSettings: () =>
    ipcRenderer.invoke(IpcChannels.SETTINGS_GET),

  setSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke(IpcChannels.SETTINGS_SET, settings),

  getAudioStoragePath: () =>
    ipcRenderer.invoke(IpcChannels.SETTINGS_GET_AUDIO_PATH),

  setAudioStoragePath: (path: string) =>
    ipcRenderer.invoke(IpcChannels.SETTINGS_SET_AUDIO_PATH, path),

  browseFolder: () =>
    ipcRenderer.invoke(IpcChannels.SETTINGS_BROWSE_FOLDER),

  // ── Local audio recording ─────────────────────────────────────────────
  startAudioRecording: () =>
    ipcRenderer.invoke(IpcChannels.AUDIO_START_RECORDING),

  stopAudioRecording: () =>
    ipcRenderer.invoke(IpcChannels.AUDIO_STOP_RECORDING),

  writeAudioChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send("audio:write-chunk", chunk),

  getRecordingPath: () =>
    ipcRenderer.invoke(IpcChannels.AUDIO_GET_RECORDING_PATH),

  // ── User profile sync ─────────────────────────────────────────────────
  getUserProfile: () =>
    ipcRenderer.invoke(IpcChannels.USER_GET_PROFILE),
} satisfies ElectronAPI);
