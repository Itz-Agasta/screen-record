/**
 * electron/main.ts
 * ================
 * Electron main process — the privileged Node.js entry point.
 *
 * Responsibilities:
 *   • Create and manage the BrowserWindow (renderer)
 *   • Register IPC handlers (auth, window controls, diagnostics)
 *
 * Security model:
 *   • contextIsolation: true  — renderer cannot access Node APIs directly
 *   • nodeIntegration: false  — belt-and-suspenders against XSS → RCE
 *   • sandbox: false          — needed so preload.ts can use Node's `path`
 *   • All Node/OS calls go through IPC handlers here; the renderer
 *     only sees the surface exposed in preload.ts via contextBridge.
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  screen,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import WebSocket from "ws";
import { IpcChannels }      from "./ipc-handlers";

// ─── Dev vs production path resolution ───────────────────────────────────────
const isDev  = !app.isPackaged;
const ROOT   = app.getAppPath();

// In production the Vite renderer is built into dist/renderer/.
// In dev Vite serves it on localhost:5173.
const RENDERER_URL  = "http://localhost:5173";
const RENDERER_FILE = path.join(ROOT, "dist", "renderer", "index.html");
const DEFAULT_BACKEND_URL = process.env.NEONEXUS_BACKEND_URL || process.env.VITE_BACKEND_URL || "http://localhost:8000";
const BACKEND_FETCH_TIMEOUT_MS = 15000;
const STREAM_CONNECT_TIMEOUT_MS = 15000;

function buildBackendCandidates(baseUrl: string): string[] {
  const normalized = normalizeBackendUrl(baseUrl);
  const out = new Set<string>([normalized]);

  try {
    const u = new URL(normalized);
    if (u.hostname === "localhost") {
      u.hostname = "127.0.0.1";
      out.add(u.toString().replace(/\/+$/, ""));
    } else if (u.hostname === "127.0.0.1") {
      u.hostname = "localhost";
      out.add(u.toString().replace(/\/+$/, ""));
    } else if (u.hostname === "0.0.0.0") {
      u.hostname = "127.0.0.1";
      out.add(u.toString().replace(/\/+$/, ""));
    }
  } catch {
    // Keep original URL only.
  }

  return Array.from(out);
}

function toWebSocketBaseUrl(httpBaseUrl: string): string {
  const normalized = normalizeBackendUrl(httpBaseUrl);
  try {
    const url = new URL(normalized);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized.replace(/^http/i, "ws");
  }
}

// ─── Global state ─────────────────────────────────────────────────────────────
let mainWindow:         BrowserWindow | null = null;

// JWT stored in main-process memory only — never written to disk or
// accessible from the renderer directly (renderer calls IPC to act on it).
let authToken: string | null = null;
let _currentUserId: number | null = null;
let backendUrl: string = DEFAULT_BACKEND_URL;

// WebSocket connection to backend Deepgram proxy.
let deepgramWs: WebSocket | null = null;
let currentSessionId: string | null = null;
let lastStreamSessionId: string | null = null;

// Settings stored in user data directory
interface AppSettings {
  audioStoragePath: string;
  defaultContextLines: number;
}

const DEFAULT_AUDIO_PATH = path.join(os.homedir(), "NeoNexus", "recordings");
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
      return { ...getDefaultSettings(), ...JSON.parse(data) };
    }
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
  return getDefaultSettings();
}

function getDefaultSettings(): AppSettings {
  return {
    audioStoragePath: DEFAULT_AUDIO_PATH,
    defaultContextLines: 4,
  };
}

function saveSettings(settings: Partial<AppSettings>): void {
  const current = loadSettings();
  const merged = { ...current, ...settings };
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}

// Ensure audio storage directory exists
function ensureAudioDirectory(): string {
  const settings = loadSettings();
  const dir = settings.audioStoragePath;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function normalizeBackendUrl(value: string | undefined | null): string {
  const raw = (value || "").trim();
  if (!raw) return DEFAULT_BACKEND_URL;
  return raw.replace(/\/+$/, "");
}

// Avoid duplicate app instances/windows in development.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// ─── Window factory ───────────────────────────────────────────────────────────

function createWindow(): void {
  const { width: screenWidth, height: screenHeight } =
    screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    // ── Dimensions — small overlay-style window, draggable ──────────────
    width:  420,
    height: 680,
    minWidth:  360,
    minHeight: 500,

    // ── Position — bottom-right corner, out of the way during interview ─
    x: screenWidth  - 440,
    y: screenHeight - 700,

    // ── Stealth / overlay properties ────────────────────────────────────
    frame:           false,   // custom titlebar in renderer
    transparent:     false,
    alwaysOnTop:     !isDev,  // keep normal desktop behavior in development
    skipTaskbar:     false,   // keep recoverable from taskbar in all modes
    resizable:       true,
    movable:         true,

    // ── Security ────────────────────────────────────────────────────────
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,   // preload needs Node path/fs
      webSecurity:      true,
      devTools:         isDev,
    },

    // ── Appearance ───────────────────────────────────────────────────────
    backgroundColor: "#0f1117",
    icon: path.join(ROOT, "resources", "icon.ico"),
    title: "NeoNexus Copilot",
  });

  // ── Stealth hardening (must be called after BrowserWindow construction) ─
  //
  // setContentProtection(true)
  //   Windows: sets WDA_EXCLUDEFROMCAPTURE via DwmSetWindowAttribute.
  //   This causes the window to appear as a black rectangle (or be fully
  //   invisible) in screen-capture tools — OBS, Teams screen share, Zoom,
  //   Windows Game Bar, BitBlt-based screenshot APIs.
  //   Prevents third-party screen capture tools from capturing this window.
  //   NOTE: Disabled in dev so we can screenshot the UI while building.
  if (!isDev) {
    mainWindow.setContentProtection(true);
  }

  // setVisibleOnAllWorkspaces(true)
  //   Keeps the overlay visible when the user switches virtual desktops
  //   (Windows 10/11 Task View).  Without this the window disappears when
  //   the interviewer's video call is on a different workspace.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // ── Load the renderer ──────────────────────────────────────────────────
  if (isDev) {
    mainWindow.loadURL(RENDERER_URL);
  } else {
    mainWindow.loadFile(RENDERER_FILE);
  }

  // ── Window event wiring ───────────────────────────────────────────────
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Intercept navigation attempts — open external links in the OS browser,
  // never in Electron (prevents renderer from loading arbitrary URLs).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const isLocal =
      url.startsWith("file://") ||
      (isDev && url.startsWith(RENDERER_URL));
    if (!isLocal) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  createWindow();
  registerIpcHandlers();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // On macOS it is conventional to keep the app alive until Cmd+Q.
  if (process.platform !== "darwin") {
    cleanupAndQuit();
  }
});

function cleanupAndQuit(): void {
  app.quit();
}

// ─── IPC handler registration ─────────────────────────────────────────────────

function registerIpcHandlers(): void {

  const backendFetch = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!authToken) {
      throw new Error("Not authenticated");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
      ...((init.headers as Record<string, string>) || undefined),
    };

    let response: Response | null = null;
    let lastError: unknown = null;
    const candidates = buildBackendCandidates(backendUrl);

    for (const candidate of candidates) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BACKEND_FETCH_TIMEOUT_MS);
      try {
        response = await fetch(`${candidate}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
        if (candidate !== backendUrl) {
          backendUrl = candidate;
        }
        break;
      } catch (err: any) {
        lastError = err;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!response) {
      const reason = (lastError as any)?.name === "AbortError"
        ? "request timed out"
        : ((lastError as any)?.message || "network failure");
      throw new Error(`Backend request failed (${reason}). URL: ${backendUrl}`);
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json() as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        // no-op
      }
      throw new Error(detail);
    }

    return response.json() as Promise<T>;
  };

  // ────────────────────────────────────────────────────────────────────────
  // AUTH
  // ────────────────────────────────────────────────────────────────────────

  /**
   * IpcChannels.LOGIN
   * Payload:  { token: string; userId: number }
   * Response: { success: true }
   *
   * The renderer sends the JWT it received from the backend REST login.
   * We store it in main-process memory — it never touches disk or the
   * renderer's JS heap again.
   */
  ipcMain.handle(IpcChannels.LOGIN, async (_event, payload: {
    token: string;
    userId: number;
    backendUrl?: string;
  }) => {
    authToken     = payload.token;
    _currentUserId = payload.userId;
    backendUrl = normalizeBackendUrl(payload.backendUrl);
    return { success: true };
  });

  /**
   * IpcChannels.LOGOUT
   * Clears the in-memory token.
   */
  ipcMain.handle(IpcChannels.LOGOUT, async () => {
    if (deepgramWs) {
      try {
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(JSON.stringify({ type: "close" }));
        }
        deepgramWs.close();
      } catch {
        // no-op
      }
      deepgramWs = null;
    }
    currentSessionId = null;
    lastStreamSessionId = null;

    authToken     = null;
    _currentUserId = null;
    return { success: true };
  });

  // ────────────────────────────────────────────────────────────────────────
  // WINDOW CONTROLS  (custom frameless titlebar)
  // ────────────────────────────────────────────────────────────────────────

  ipcMain.handle(IpcChannels.WINDOW_MINIMISE, async () => {
    mainWindow?.minimize();
    return { success: true };
  });

  ipcMain.handle(IpcChannels.WINDOW_TOGGLE_MAXIMISE, async () => {
    if (!mainWindow) return { success: false, isMaximized: false };
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { success: true, isMaximized: mainWindow.isMaximized() };
  });

  ipcMain.handle(IpcChannels.WINDOW_CLOSE, async () => {
    mainWindow?.close();
    return { success: true };
  });

  ipcMain.handle(IpcChannels.WINDOW_DRAG_BY, async (_event, payload: {
    dx: number;
    dy: number;
  }) => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(Math.round(x + payload.dx), Math.round(y + payload.dy));
  });

  ipcMain.on(IpcChannels.WINDOW_TOGGLE_ALWAYS_ON_TOP, (_event, value: boolean) => {
    mainWindow?.setAlwaysOnTop(value);
  });

  // Toggle screen-capture exclusion at runtime.
  // The renderer's settings panel exposes this as "Stealth Mode" — on by
  // default in production, toggleable so the user can screenshot their own
  // AI answers if needed.
  ipcMain.on(IpcChannels.WINDOW_TOGGLE_CONTENT_PROTECTION, (_event, value: boolean) => {
    mainWindow?.setContentProtection(value);
  });

  // ────────────────────────────────────────────────────────────────────────
  // MISC UTILITIES
  // ────────────────────────────────────────────────────────────────────────

  /**
   * IpcChannels.GET_APP_VERSION
   * Returns the version from package.json.
   */
  ipcMain.handle(IpcChannels.GET_APP_VERSION, () => app.getVersion());

  /**
   * IpcChannels.SHOW_ERROR_DIALOG
   * Shows a native OS error dialog. Used for critical errors the renderer
   * cannot handle gracefully.
   */
  ipcMain.handle(IpcChannels.SHOW_ERROR_DIALOG, async (_event, payload: {
    title: string;
    message: string;
  }) => {
    await dialog.showMessageBox({
      type:    "error",
      title:   payload.title,
      message: payload.message,
      buttons: ["OK"],
    });
  });

  /**
   * IpcChannels.GET_SYSTEM_INFO
   * Returns basic system info for diagnostics (shown in settings panel).
   */
  ipcMain.handle(IpcChannels.GET_SYSTEM_INFO, () => ({
    platform:     process.platform,
    arch:         process.arch,
    nodeVersion:  process.version,
    electronVersion: process.versions.electron,
    chromeVersion:   process.versions.chrome,
  }));

  // ────────────────────────────────────────────────────────────────────────
  // USER SESSION PIPELINE
  // ────────────────────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.SESSION_START, async () => {
    console.log("[IPC] SESSION_START called");
    const result = await backendFetch<{ allowed: boolean; active_slot?: number | null; reason?: string }>(
      "/users/me/session/start",
      { method: "POST", body: JSON.stringify({}) },
    );
    console.log("[IPC] SESSION_START result:", JSON.stringify(result));
    return result;
  });

  ipcMain.handle(IpcChannels.SESSION_RESPOND, async (_event, payload: { utterance: string; history: string[] }) => {
    console.log("[IPC] SESSION_RESPOND called with utterance:", payload.utterance.slice(0, 100));
    const result = await backendFetch<{ should_respond: boolean; answer?: string; reason?: string }>(
      "/users/me/session/respond",
      { method: "POST", body: JSON.stringify(payload) },
    );
    console.log("[IPC] SESSION_RESPOND result:", JSON.stringify(result).slice(0, 300));
    return result;
  });

  ipcMain.handle(IpcChannels.SESSION_TRANSCRIBE, async (_event, payload: { audio_base64: string; audio_mime_type?: string }) => {
    console.log("[IPC] SESSION_TRANSCRIBE called, audio size:", payload.audio_base64.length, "chars");
    const result = await backendFetch<{ transcript: string[] }>(
      "/users/me/session/transcribe",
      { method: "POST", body: JSON.stringify(payload) },
    );
    console.log("[IPC] SESSION_TRANSCRIBE result:", JSON.stringify(result));
    return result;
  });

  ipcMain.handle(IpcChannels.SESSION_END, async (_event, payload: { 
    transcript: string[]; 
    audio_base64?: string; 
    audio_mime_type?: string;
    session_id?: string;
  }) => {
    console.log("[IPC] SESSION_END called");
    // Include session_id for chunked summarization if available
    const sessionId = payload.session_id || currentSessionId || lastStreamSessionId;
    const body = { ...payload };
    if (sessionId) {
      body.session_id = sessionId;
    }
    const result = await backendFetch<{ summary: string }>(
      "/users/me/session/end",
      { method: "POST", body: JSON.stringify(body) },
    );

    if (sessionId && sessionId === lastStreamSessionId) {
      lastStreamSessionId = null;
    }

    console.log("[IPC] SESSION_END result:", JSON.stringify(result));
    return result;
  });

  ipcMain.handle(IpcChannels.USER_GET_PROFILE, async () => {
    return backendFetch<{
      id: number;
      username: string;
      email: string;
      permitted_sessions: number;
      used_sessions: number;
      sessions_remaining: number;
      custom_prompt: string | null;
      is_active: boolean;
    }>("/users/me", { method: "GET" });
  });

  // ────────────────────────────────────────────────────────────────────────
  // STREAMING TRANSCRIPTION (Backend Deepgram Proxy)
  // ────────────────────────────────────────────────────────────────────────

  ipcMain.handle(IpcChannels.STREAM_CONNECT, async () => {
    if (!authToken) {
      return { success: false, error: "Not authenticated" };
    }

    // Close existing stream connection if any.
    if (deepgramWs) {
      try {
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(JSON.stringify({ type: "close" }));
        }
        deepgramWs.close();
      } catch {
        // no-op
      }
      deepgramWs = null;
    }

    currentSessionId = null;
    const wsBase = toWebSocketBaseUrl(backendUrl);
    const wsUrl = `${wsBase}/ws/deepgram/stream?token=${encodeURIComponent(authToken)}`;

    console.log("[IPC] STREAM_CONNECT connecting to backend stream:", wsUrl);

    try {
      const ws = new WebSocket(wsUrl);
      deepgramWs = ws;

      const connectResult = await new Promise<{ success: boolean; sessionId?: string; error?: string }>((resolveConnect) => {
        let settled = false;
        const settle = (result: { success: boolean; sessionId?: string; error?: string }) => {
          if (settled) return;
          settled = true;
          resolveConnect(result);
        };

        const timer = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            try {
              ws.terminate();
            } catch {
              // no-op
            }
            settle({ success: false, error: "Stream connection timed out." });
            return;
          }

          if (!currentSessionId) {
            try {
              ws.close();
            } catch {
              // no-op
            }
            settle({ success: false, error: "Connected but did not receive session id from backend." });
          }
        }, STREAM_CONNECT_TIMEOUT_MS);

        ws.on("open", () => {
          console.log("[IPC] STREAM_CONNECT websocket opened");
        });

        ws.on("message", (rawData) => {
          const text = Buffer.isBuffer(rawData) ? rawData.toString("utf-8") : String(rawData);

          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            return;
          }

          if (data?.type === "connected") {
            const backendSessionId = typeof data.session_id === "string" ? data.session_id : null;
            if (backendSessionId) {
              currentSessionId = backendSessionId;
              lastStreamSessionId = backendSessionId;
            }

            mainWindow?.webContents.send(IpcChannels.STREAM_STATUS, {
              status: "connected",
              message: "Connected to Deepgram",
            });

            clearTimeout(timer);
            settle({
              success: true,
              sessionId: currentSessionId || undefined,
            });
            return;
          }

          if (data?.type === "transcript") {
            const transcriptText = typeof data.text === "string" ? data.text.trim() : "";
            if (!transcriptText) return;

            const rawTimestamp = data.timestamp;
            const timestamp = typeof rawTimestamp === "number"
              ? (rawTimestamp > 1_000_000_000_000 ? rawTimestamp : Math.round(rawTimestamp * 1000))
              : Date.now();

            mainWindow?.webContents.send(IpcChannels.STREAM_TRANSCRIPT, {
              type: "transcript",
              speaker: typeof data.speaker === "string" ? data.speaker : "speaker-0",
              text: transcriptText,
              is_final: Boolean(data.is_final),
              confidence: typeof data.confidence === "number" ? data.confidence : 1,
              timestamp,
            });
            return;
          }

          if (data?.type === "error") {
            const message = typeof data.message === "string" ? data.message : "Streaming error";
            console.error("[IPC] STREAM websocket error message:", message);
            mainWindow?.webContents.send(IpcChannels.STREAM_STATUS, {
              status: "error",
              message,
            });

            if (!settled) {
              clearTimeout(timer);
              settle({ success: false, error: message });
            }
          }
        });

        ws.on("error", (err) => {
          const message = err instanceof Error ? err.message : "WebSocket error";
          console.error("[IPC] STREAM_CONNECT websocket error:", message);

          if (!settled) {
            clearTimeout(timer);
            settle({ success: false, error: message });
          }

          mainWindow?.webContents.send(IpcChannels.STREAM_STATUS, {
            status: "error",
            message,
          });
        });

        ws.on("close", (code, reasonBuffer) => {
          const reasonText = reasonBuffer ? reasonBuffer.toString("utf-8") : "";
          console.log("[IPC] STREAM websocket closed:", code, reasonText || "(no reason)");

          if (deepgramWs === ws) {
            deepgramWs = null;
          }
          currentSessionId = null;

          if (!settled) {
            clearTimeout(timer);
            settle({
              success: false,
              error: reasonText || `Stream closed before readiness (code ${code})`,
            });
            return;
          }

          mainWindow?.webContents.send(IpcChannels.STREAM_STATUS, {
            status: "disconnected",
            message: reasonText || "Stream closed",
            code,
            reason: reasonText || undefined,
          });
        });
      });

      if (!connectResult.success) {
        if (deepgramWs === ws) {
          deepgramWs = null;
        }
        currentSessionId = null;
      }

      return connectResult;
    } catch (err: any) {
      const message = err?.message || "Failed to connect to streaming backend";
      console.error("[IPC] STREAM_CONNECT exception:", message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(IpcChannels.STREAM_DISCONNECT, async () => {
    console.log("[IPC] STREAM_DISCONNECT called");
    const sessionId = currentSessionId || lastStreamSessionId;

    if (deepgramWs) {
      try {
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(JSON.stringify({ type: "close" }));
        }
        deepgramWs.close();
      } catch {
        // no-op
      }
      deepgramWs = null;
    }

    currentSessionId = null;
    return { success: true, sessionId };
  });

  ipcMain.handle(IpcChannels.STREAM_SEND_AUDIO, async (_event, audioChunk: ArrayBuffer) => {
    if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
      return { success: false, error: "Stream not connected" };
    }

    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      deepgramWs?.send(Buffer.from(audioChunk), (err) => {
        if (err) {
          const message = err instanceof Error ? err.message : "Failed to send audio chunk";
          console.error("[IPC] STREAM_SEND_AUDIO error:", message);
          resolve({ success: false, error: message });
          return;
        }
        resolve({ success: true });
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // HOTKEY HELP
  // ────────────────────────────────────────────────────────────────────────

  ipcMain.handle(IpcChannels.SESSION_HELP, async (_event, payload: {
    sessionId?: string;
    contextLines?: number;
  }) => {
    console.log("[IPC] SESSION_HELP called");
    
    const sessionId = payload.sessionId || currentSessionId || lastStreamSessionId;
    if (!sessionId) {
      return { success: false, reason: "No active streaming session" };
    }

    const contextLines = payload.contextLines || loadSettings().defaultContextLines;

    const result = await backendFetch<{
      success: boolean;
      context?: string;
      answer?: string;
      reason?: string;
    }>("/users/me/session/help", {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        context_lines: contextLines,
      }),
    });

    console.log("[IPC] SESSION_HELP result:", JSON.stringify(result).slice(0, 300));
    return result;
  });

  // ────────────────────────────────────────────────────────────────────────
  // SETTINGS PERSISTENCE
  // ────────────────────────────────────────────────────────────────────────

  ipcMain.handle(IpcChannels.SETTINGS_GET, async () => {
    return loadSettings();
  });

  ipcMain.handle(IpcChannels.SETTINGS_SET, async (_event, settings: Partial<AppSettings>) => {
    saveSettings(settings);
    return { success: true, settings: loadSettings() };
  });

  ipcMain.handle(IpcChannels.SETTINGS_GET_AUDIO_PATH, async () => {
    return loadSettings().audioStoragePath;
  });

  ipcMain.handle(IpcChannels.SETTINGS_SET_AUDIO_PATH, async (_event, audioPath: string) => {
    saveSettings({ audioStoragePath: audioPath });
    // Ensure directory exists
    if (!fs.existsSync(audioPath)) {
      fs.mkdirSync(audioPath, { recursive: true });
    }
    return { success: true, path: audioPath };
  });

  ipcMain.handle(IpcChannels.SETTINGS_BROWSE_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select Audio Storage Folder",
      defaultPath: loadSettings().audioStoragePath,
    });

    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }

    const selectedPath = result.filePaths[0];
    saveSettings({ audioStoragePath: selectedPath });
    return { success: true, path: selectedPath };
  });

  // ────────────────────────────────────────────────────────────────────────
  // LOCAL AUDIO RECORDING
  // ────────────────────────────────────────────────────────────────────────

  let currentRecordingStream: fs.WriteStream | null = null;
  let currentRecordingPath: string | null = null;

  ipcMain.handle(IpcChannels.AUDIO_START_RECORDING, async () => {
    const audioDir = ensureAudioDirectory();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `interview_${timestamp}.webm`;
    const filePath = path.join(audioDir, filename);

    console.log("[IPC] AUDIO_START_RECORDING:", filePath);

    try {
      currentRecordingStream = fs.createWriteStream(filePath);
      currentRecordingPath = filePath;
      return { success: true, path: filePath };
    } catch (err: any) {
      console.error("[IPC] AUDIO_START_RECORDING error:", err);
      return { success: false, error: err.message };
    }
  });

  // Use ipcMain.on for streaming audio data (not invoke, which waits for response)
  ipcMain.on("audio:write-chunk", (_event, chunk: ArrayBuffer) => {
    if (currentRecordingStream && !currentRecordingStream.destroyed) {
      currentRecordingStream.write(Buffer.from(chunk));
    }
  });

  ipcMain.handle(IpcChannels.AUDIO_STOP_RECORDING, async () => {
    console.log("[IPC] AUDIO_STOP_RECORDING");
    const filePath = currentRecordingPath;

    return new Promise((resolve) => {
      if (currentRecordingStream) {
        currentRecordingStream.end(() => {
          currentRecordingStream = null;
          currentRecordingPath = null;
          resolve({ success: true, path: filePath });
        });
      } else {
        resolve({ success: false, error: "No active recording" });
      }
    });
  });

  ipcMain.handle(IpcChannels.AUDIO_GET_RECORDING_PATH, async () => {
    return { path: currentRecordingPath, isRecording: !!currentRecordingStream };
  });
}
