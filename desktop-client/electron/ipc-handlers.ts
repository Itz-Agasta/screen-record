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

  // ── User session AI pipeline (legacy press-to-record) ───────────────────
  SESSION_START:      "session:start",
  SESSION_RESPOND:    "session:respond",
  SESSION_TRANSCRIBE: "session:transcribe",
  SESSION_END:        "session:end",

  // ── Streaming transcription ─────────────────────────────────────────────
  STREAM_CONNECT:     "stream:connect",     // Connect to Deepgram WS proxy
  STREAM_DISCONNECT:  "stream:disconnect",  // Disconnect streaming
  STREAM_SEND_AUDIO:  "stream:send-audio",  // Send audio chunk to stream
  STREAM_TRANSCRIPT:  "stream:transcript",  // Event: transcript update from stream
  STREAM_STATUS:      "stream:status",      // Event: connection status change

  // ── Hotkey help ────────────────────────────────────────────────────────
  SESSION_HELP:       "session:help",       // Get AI help with recent context

  // ── Settings persistence ────────────────────────────────────────────────
  SETTINGS_GET:       "settings:get",       // Get all settings
  SETTINGS_SET:       "settings:set",       // Set a setting
  SETTINGS_GET_AUDIO_PATH: "settings:get-audio-path",  // Get audio storage path
  SETTINGS_SET_AUDIO_PATH: "settings:set-audio-path",  // Set audio storage path
  SETTINGS_BROWSE_FOLDER:  "settings:browse-folder",   // Open folder picker dialog

  // ── Local audio recording ───────────────────────────────────────────────
  AUDIO_START_RECORDING:   "audio:start-recording",   // Start recording to local file
  AUDIO_STOP_RECORDING:    "audio:stop-recording",    // Stop recording and get file path
  AUDIO_GET_RECORDING_PATH: "audio:get-recording-path", // Get current recording path

  // ── User profile sync ──────────────────────────────────────────────────
  USER_GET_PROFILE:   "user:get-profile",
} as const;

export type IpcChannel = typeof IpcChannels[keyof typeof IpcChannels];
