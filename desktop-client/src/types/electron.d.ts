/**
 * src/types/electron.d.ts
 * =======================
 * Ambient type declaration for the contextBridge surface exposed by preload.ts.
 * This gives the renderer process full TypeScript type-safety over every
 * IPC call without importing from the Electron namespace (which is
 * unavailable in the renderer's sandboxed context).
 */

export {};

// Type definitions for streaming
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

      // ── User session pipeline (legacy) ────────────────────────────────
      sessionStart: () => Promise<{ allowed: boolean; active_slot?: number | null; reason?: string }>;
      sessionRespond: (payload: { utterance: string; history: string[] }) => Promise<{ should_respond: boolean; answer?: string; reason?: string }>;
      sessionTranscribe: (payload: { audio_base64: string; audio_mime_type?: string }) => Promise<{ transcript: string[] }>;
      sessionEnd: (payload: { transcript: string[]; audio_base64?: string; audio_mime_type?: string; session_id?: string }) => Promise<{ summary: string }>;

      // ── Streaming transcription ───────────────────────────────────────
      streamConnect: () => Promise<{ success: boolean; sessionId?: string; error?: string }>;
      streamDisconnect: () => Promise<{ success: boolean; sessionId?: string }>;
      streamSendAudio: (audioChunk: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
      onStreamTranscript: (callback: (data: TranscriptUpdate) => void) => () => void;
      onStreamStatus: (callback: (data: StreamStatus) => void) => () => void;

      // ── Hotkey help ──────────────────────────────────────────────────
      sessionHelp: (payload?: { sessionId?: string; contextLines?: number }) => Promise<{
        success: boolean;
        context?: string;
        answer?: string;
        reason?: string;
      }>;

      // ── Settings ──────────────────────────────────────────────────────
      getSettings: () => Promise<AppSettings>;
      setSettings: (settings: Partial<AppSettings>) => Promise<{ success: boolean; settings: AppSettings }>;
      getAudioStoragePath: () => Promise<string>;
      setAudioStoragePath: (path: string) => Promise<{ success: boolean; path: string }>;
      browseFolder: () => Promise<{ success: boolean; canceled?: boolean; path?: string }>;

      // ── Local audio recording ─────────────────────────────────────────
      startAudioRecording: () => Promise<{ success: boolean; path?: string; error?: string }>;
      stopAudioRecording: () => Promise<{ success: boolean; path?: string; error?: string }>;
      writeAudioChunk: (chunk: ArrayBuffer) => void;
      getRecordingPath: () => Promise<{ path: string | null; isRecording: boolean }>;

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
