/**
 * electron/ipc-handlers.ts
 * =========================
 * Single source of truth for all IPC channel names.
 *
 * Both the main process (main.ts) and the renderer (via preload.ts /
 * contextBridge) import from here, eliminating string-literal typos
 * across the IPC boundary.
 *
 * Naming convention:
 *   RENDERER → MAIN  :  verb-noun   (e.g. LOGIN)
 *   MAIN → RENDERER  :  noun-event  (e.g. AI_TOKEN, UPLOAD_PROGRESS)
 */

export const IpcChannels = {
  // ── Auth ────────────────────────────────────────────────────────────────
  LOGIN:   "auth:login",
  LOGOUT:  "auth:logout",

  // ── Window controls (one-way, no response needed) ───────────────────────
  WINDOW_MINIMISE:                  "window:minimise",
  WINDOW_TOGGLE_MAXIMISE:           "window:toggle-maximise",
  WINDOW_CLOSE:                     "window:close",
  WINDOW_DRAG_BY:                   "window:drag-by",
  WINDOW_TOGGLE_ALWAYS_ON_TOP:      "window:alwaysOnTop",
  WINDOW_TOGGLE_CONTENT_PROTECTION: "window:contentProtection",

  // ── Utilities ───────────────────────────────────────────────────────────
  GET_APP_VERSION:    "util:app-version",
  GET_SYSTEM_INFO:    "util:system-info",
  SHOW_ERROR_DIALOG:  "util:error-dialog",

  // ── User session AI pipeline ───────────────────────────────────────────
  SESSION_START:      "session:start",
  SESSION_RESPOND:    "session:respond",
  SESSION_TRANSCRIBE: "session:transcribe",
  SESSION_END:        "session:end",

  // ── User profile sync ──────────────────────────────────────────────────
  USER_GET_PROFILE:   "user:get-profile",
} as const;

export type IpcChannel = typeof IpcChannels[keyof typeof IpcChannels];
