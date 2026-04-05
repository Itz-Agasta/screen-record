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

import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels } from "./ipc-handlers";

// ── Type definitions for the exposed API ─────────────────────────────────────
// Keep these in sync with the renderer-side type declaration in
// src/types/electron.d.ts so TypeScript is happy on both sides.

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

  // User session pipeline
  sessionStart: () => Promise<{ allowed: boolean; active_slot?: number | null; reason?: string }>;
  sessionRespond: (payload: { utterance: string; history: string[] }) => Promise<{ should_respond: boolean; answer?: string; reason?: string }>;
  sessionTranscribe: (payload: { audio_base64: string; audio_mime_type?: string }) => Promise<{ transcript: string[] }>;
  sessionEnd: (payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string }) => Promise<{ summary: string }>;

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

  // ── User session pipeline ─────────────────────────────────────────
  sessionStart: () =>
    ipcRenderer.invoke(IpcChannels.SESSION_START),

  sessionRespond: (payload: { utterance: string; history: string[] }) =>
    ipcRenderer.invoke(IpcChannels.SESSION_RESPOND, payload),

  sessionTranscribe: (payload: { audio_base64: string; audio_mime_type?: string }) =>
    ipcRenderer.invoke(IpcChannels.SESSION_TRANSCRIBE, payload),

  sessionEnd: (payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string }) =>
    ipcRenderer.invoke(IpcChannels.SESSION_END, payload),

  // ── User profile sync ─────────────────────────────────────────────
  getUserProfile: () =>
    ipcRenderer.invoke(IpcChannels.USER_GET_PROFILE),
} satisfies ElectronAPI);
