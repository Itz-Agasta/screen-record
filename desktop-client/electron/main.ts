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

// ─── Global state ─────────────────────────────────────────────────────────────
let mainWindow:         BrowserWindow | null = null;

// JWT stored in main-process memory only — never written to disk or
// accessible from the renderer directly (renderer calls IPC to act on it).
let authToken: string | null = null;
let currentUserId: number | null = null;
let backendUrl: string = DEFAULT_BACKEND_URL;

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
      ...(init.headers as Record<string, string> ?? {}),
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
    currentUserId = payload.userId;
    backendUrl = normalizeBackendUrl(payload.backendUrl);
    return { success: true };
  });

  /**
   * IpcChannels.LOGOUT
   * Clears the in-memory token.
   */
  ipcMain.handle(IpcChannels.LOGOUT, async () => {
    authToken     = null;
    currentUserId = null;
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
    return backendFetch<{ allowed: boolean; active_slot?: number | null; reason?: string }>(
      "/users/me/session/start",
      { method: "POST", body: JSON.stringify({}) },
    );
  });

  ipcMain.handle(IpcChannels.SESSION_RESPOND, async (_event, payload: { utterance: string; history: string[] }) => {
    return backendFetch<{ should_respond: boolean; answer?: string; reason?: string }>(
      "/users/me/session/respond",
      { method: "POST", body: JSON.stringify(payload) },
    );
  });

  ipcMain.handle(IpcChannels.SESSION_TRANSCRIBE, async (_event, payload: { audio_base64: string; audio_mime_type?: string }) => {
    return backendFetch<{ transcript: string[] }>(
      "/users/me/session/transcribe",
      { method: "POST", body: JSON.stringify(payload) },
    );
  });

  ipcMain.handle(IpcChannels.SESSION_END, async (_event, payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string }) => {
    return backendFetch<{ summary: string }>(
      "/users/me/session/end",
      { method: "POST", body: JSON.stringify(payload) },
    );
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
}
