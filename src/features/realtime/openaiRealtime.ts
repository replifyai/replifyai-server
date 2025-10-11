import WebSocket from "ws";
import { env } from "../../env.js";

export interface RealtimeTranscriptionOptions {
  model?: "whisper-1" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe";
  turnDetection?: {
    type: "server_vad";
    threshold?: number;
    prefixPaddingMs?: number;
    silenceDurationMs?: number;
  };
  inputAudioFormat?: "pcm16" | "g711_ulaw" | "g711_alaw";
  language?: string;
  sampleRate?: number;
}

export interface RealtimeEvent {
  type: string;
  [key: string]: any;
}

/**
 * Thin wrapper around OpenAI Realtime WebSocket for transcription-only sessions.
 * Handles connection, session configuration, streaming audio and event dispatch.
 */
export class OpenAIRealtimeService {
  private websocket: WebSocket | null = null;
  private isConnected = false;
  private readonly url = "wss://api.openai.com/v1/realtime?intent=transcription";
  private eventListeners: Map<string, Array<(event: RealtimeEvent) => void>> = new Map();

  constructor(private readonly options: RealtimeTranscriptionOptions = {}) {}

  async connect(): Promise<void> {
    if (this.isConnected) return;
    if (!env.OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY env var");
    }

    this.websocket = new WebSocket(this.url, {
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.websocket) return reject(new Error("WebSocket not created"));

      this.websocket.once("open", () => {
        this.isConnected = true;
        this.configureSession();
        resolve();
      });

      this.websocket.on("message", (data: WebSocket.RawData) => {
        try {
          const event: RealtimeEvent = JSON.parse(data.toString());
          this.emit(event.type, event);
          // Emit unified events for consumers
          if (event.type === "conversation.item.input_audio_transcription.delta" && (event as any).delta) {
            this.emit("transcription.delta", { type: "transcription.delta", delta: (event as any).delta });
          } else if (event.type === "conversation.item.input_audio_transcription.completed") {
            this.emit("transcription.completed", { type: "transcription.completed", transcript: (event as any).transcript || "" });
          } else if (event.type === "input_audio_buffer.speech_started") {
            this.emit("speech.started", { type: "speech.started" });
          } else if (event.type === "input_audio_buffer.speech_stopped") {
            this.emit("speech.stopped", { type: "speech.stopped" });
          }
        } catch (err) {
          this.emit("error", { type: "error", error: err });
        }
      });

      this.websocket.on("close", (code, reason) => {
        this.isConnected = false;
        this.emit("connection.closed", { type: "connection.closed", code, reason: reason.toString() });
      });

      this.websocket.on("error", (err) => {
        this.isConnected = false;
        reject(err);
      });
    });
  }

  private configureSession(): void {
    const payload = {
      type: "transcription_session.update",
      session: {
        input_audio_format: this.options.inputAudioFormat ?? "pcm16",
        input_audio_transcription: {
          model: this.options.model ?? "whisper-1",
          language: this.options.language || "en",
          // ...(this.options.language ? { language: this.options.language } : {}), // add default language en-US
          // ...(this.options.model === "whisper-1" ? { language: "en-US" } : {}), // add default language en-US
        },
        turn_detection: {
          type: "server_vad" as const,
          threshold: this.options.turnDetection?.threshold ?? 0.5,
          prefix_padding_ms: this.options.turnDetection?.prefixPaddingMs ?? 300,
          silence_duration_ms: this.options.turnDetection?.silenceDurationMs ?? 500,
        },
      },
    };
    this.send(payload);
  }

  appendAudio(base64Pcm16: string): void {
    this.send({ type: "input_audio_buffer.append", audio: base64Pcm16 });
  }

  endAudio(): void {
    this.send({ type: "input_audio_buffer.end" });
  }

  send(event: unknown): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error("Upstream WebSocket not open");
    }
    this.websocket.send(JSON.stringify(event));
  }

  on(eventType: string, handler: (event: RealtimeEvent) => void): void {
    const list = this.eventListeners.get(eventType) ?? [];
    list.push(handler);
    this.eventListeners.set(eventType, list);
  }

  off(eventType: string, handler: (event: RealtimeEvent) => void): void {
    const list = this.eventListeners.get(eventType);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  private emit(eventType: string, event: RealtimeEvent): void {
    const list = this.eventListeners.get(eventType);
    if (list) list.forEach((fn) => fn(event));
  }

  disconnect(): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.close();
    }
    this.websocket = null;
    this.isConnected = false;
  }
}

