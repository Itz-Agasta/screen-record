type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export interface LiveSessionEvents {
  onUtterance: (text: string) => void;
  onAudioChunk?: (chunk: Blob) => void;
  onError?: (message: string) => void;
}

export class LiveSessionEngine {
  private recognition: SpeechRecognitionLike | null = null;
  private speechRecognitionEnabled = false;
  private micStreams: MediaStream[] = [];
  private speakerStream: MediaStream | null = null;
  private mixedDestination: MediaStreamAudioDestinationNode | null = null;
  private audioContext: AudioContext | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private transcript: string[] = [];
  private active = false;
  private stopping = false;

  constructor(private readonly events: LiveSessionEvents) {}

  async start(): Promise<void> {
    if (this.active) return;

    await this.setupAudioCapture();
    this.setupSpeechRecognition();
    if (this.recognition) {
      try {
        this.recognition.start();
        this.speechRecognitionEnabled = true;
      } catch {
        this.speechRecognitionEnabled = false;
        this.events.onError?.('Speech recognition could not start; continuing with server audio transcription.');
      }
    } else {
      this.speechRecognitionEnabled = false;
      this.events.onError?.('Speech recognition is unavailable; using server audio transcription for live answers.');
    }
    this.active = true;
    this.stopping = false;
  }

  async stop(): Promise<{ transcript: string[]; audioBlob: Blob | null }> {
    if (!this.active) {
      return { transcript: this.transcript.slice(), audioBlob: null };
    }

    this.stopping = true;
    this.active = false;

    if (this.recognition && this.speechRecognitionEnabled) {
      try {
        this.recognition.stop();
      } catch {
        // no-op
      }
    }

    const audioBlob = await this.stopRecorder();

    for (const stream of this.micStreams) {
      for (const track of stream.getTracks()) track.stop();
    }
    this.micStreams = [];

    if (this.speakerStream) {
      for (const track of this.speakerStream.getTracks()) track.stop();
      this.speakerStream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.mixedDestination = null;

    return {
      transcript: this.transcript.slice(),
      audioBlob,
    };
  }

  private async setupAudioCapture(): Promise<void> {
    this.audioContext = new AudioContext();
    this.mixedDestination = this.audioContext.createMediaStreamDestination();

    const devices = await navigator.mediaDevices.enumerateDevices();
    const micDevices = devices.filter((d) => d.kind === 'audioinput');

    for (const device of micDevices) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: device.deviceId ? { exact: device.deviceId } : undefined },
          video: false,
        });
        this.micStreams.push(stream);
      } catch {
        // Permission denied for one device should not block the session.
      }
    }

    if (this.micStreams.length === 0) {
      try {
        const fallbackMic = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        this.micStreams.push(fallbackMic);
      } catch {
        throw new Error('Microphone access is required to start a session.');
      }
    }

    try {
      this.speakerStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      // Video track is not needed; we only capture audio loopback.
      this.speakerStream.getVideoTracks().forEach((t) => t.stop());
    } catch {
      this.speakerStream = null;
    }

    if (!this.mixedDestination || !this.audioContext) return;

    const allStreams = [
      ...this.micStreams,
      ...(this.speakerStream ? [this.speakerStream] : []),
    ];

    for (const stream of allStreams) {
      if (!stream.getAudioTracks().length) continue;
      const src = this.audioContext.createMediaStreamSource(stream);
      src.connect(this.mixedDestination);
    }

    if (this.mixedDestination.stream.getAudioTracks().length > 0) {
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      this.mediaRecorder = new MediaRecorder(this.mixedDestination.stream, (preferredMime ? { mimeType: preferredMime } : {}));
      this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          this.chunks.push(event.data);
          this.events.onAudioChunk?.(event.data);
        }
      };
      // Emit smaller chunks for lower end-to-end transcription latency.
      this.mediaRecorder.start(700);
    }
  }

  private setupSpeechRecognition(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.events.onError?.('Speech recognition is not supported in this runtime.');
      return;
    }

    this.recognition = new Ctor();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const text = (result[0]?.transcript || '').trim();
        if (!text) continue;
        this.transcript.push(text);
        this.events.onUtterance(text);
      }
    };

    this.recognition.onerror = (event: any) => {
      this.events.onError?.(`Speech recognition error: ${event.error || 'unknown'}`);
    };

    this.recognition.onend = () => {
      if (this.active && !this.stopping) {
        try {
          this.recognition?.start();
        } catch {
          // no-op
        }
      }
    };
  }

  private async stopRecorder(): Promise<Blob | null> {
    if (!this.mediaRecorder) return null;

    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;

    if (recorder.state === 'inactive') {
      return this.chunks.length ? new Blob(this.chunks, { type: 'audio/webm' }) : null;
    }

    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: 'audio/webm' }) : null;
        resolve(blob);
      };
      recorder.stop();
    });
  }
}