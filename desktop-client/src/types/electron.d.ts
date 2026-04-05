/**
 * src/types/electron.d.ts
 * =======================
 * Ambient type declaration for the contextBridge surface exposed by preload.ts.
 * This gives the renderer process full TypeScript type-safety over every
 * IPC call without importing from the Electron namespace (which is
 * unavailable in the renderer's sandboxed context).
 */

export {};

declare global {
  interface Window {
    electronAPI: {
      // ── Auth ─────────────────────────────────────────────────────────
      login:  (token: string, userId: number, backendUrl?: string) => Promise<{ success: boolean }>;
      logout: () => Promise<{ success: boolean }>;

      // ── Window controls ───────────────────────────────────────────────
      minimiseWindow:       () => Promise<{ success: boolean }>;
      toggleMaximiseWindow: () => Promise<{ success: boolean; isMaximized: boolean }>;
      closeWindow:          () => Promise<{ success: boolean }>;
      dragWindowBy:         (dx: number, dy: number) => Promise<void>;
      setAlwaysOnTop:       (value: boolean) => void;
      setContentProtection: (value: boolean) => void;

      // ── Utilities ─────────────────────────────────────────────────────
      getAppVersion:  () => Promise<string>;
      getSystemInfo:  () => Promise<Record<string, string>>;
      showError:      (title: string, message: string) => Promise<void>;

      // ── User session pipeline ────────────────────────────────────────
      sessionStart: () => Promise<{ allowed: boolean; active_slot?: number | null; reason?: string }>;
      sessionRespond: (payload: { utterance: string; history: string[] }) => Promise<{ should_respond: boolean; answer?: string; reason?: string }>;
      sessionTranscribe: (payload: { audio_base64: string; audio_mime_type?: string }) => Promise<{ transcript: string[] }>;
      sessionEnd: (payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string }) => Promise<{ summary: string }>;

      // ── User profile sync ───────────────────────────────────────────
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
    };
  }
}
