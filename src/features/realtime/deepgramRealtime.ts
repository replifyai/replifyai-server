import WebSocket from "ws";
import { env } from "../../env.js";

export interface DGTranscriptionOptions {
  language?: string; // e.g., "en-US" or "hi-IN"
  sampleRate?: number; // e.g., 16000 or 48000
  punctuate?: boolean;
  interimResults?: boolean;
  vadEvents?: boolean;
  model?: string; // e.g., "nova-2-general"
  encoding?: "linear16" | "opus"; // Deepgram expects 'linear16' or 'opus'
  container?: "webm" | "ogg"; // for opus streams
  channels?: number; // 1 by default
  keepalivePingMs?: number; // ping interval to keep connection alive
}

export interface RealtimeEvent {
  type: string;
  [key: string]: any;
}

export class DeepgramRealtimeService {
  private websocket: WebSocket | null = null;
  private isConnected = false;
  private eventListeners: Map<string, Array<(event: RealtimeEvent) => void>> = new Map();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: DGTranscriptionOptions = {}) {}

  async connect(): Promise<void> {
    if (this.isConnected) return;
    if (!env.DEEPGRAM_API_KEY) {
      throw new Error("Missing DEEPGRAM_API_KEY env var");
    }

    const params = new URLSearchParams({
      encoding: this.options.encoding ?? "linear16",
      sample_rate: String(this.options.sampleRate ?? 16000),
      language: this.options.language ?? "en-US",
      punctuate: String(this.options.punctuate ?? true),
      interim_results: String(this.options.interimResults ?? true),
      vad_events: String(this.options.vadEvents ?? true),
      model: this.options.model ?? "nova-2-general",
      channels: String(this.options.channels ?? 1),
    });
    if ((this.options.encoding ?? "linear16") === "opus" && this.options.container) {
      params.set("container", this.options.container);
    }
    console.log("🚀 ~ DeepgramRealtimeService ~ connect ~ params:", params);

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    this.websocket = new WebSocket(url, {
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      },
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.websocket) return reject(new Error("WebSocket not created"));

      this.websocket.once("open", () => {
        this.isConnected = true;
        // Keepalive ping to prevent idle disconnects
        const interval = this.options.keepalivePingMs ?? 10000;
        this.pingTimer = setInterval(() => {
          try {
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
              this.websocket.ping();
            }
          } catch {
            // ignore
          }
        }, interval);
        resolve();
      });

      this.websocket.on("message", (data: WebSocket.RawData) => {
        try {
          const text = data.toString();
          let msg: any;
          try {
            msg = JSON.parse(text);
          } catch {
            return; // ignore non-JSON frames
          }
          // Map Deepgram events to unified events
          if (msg.type === "Results" && msg.channel?.alternatives?.length) {
            const transcript: string = msg.channel.alternatives[0]?.transcript ?? "";
            if (!transcript) return;
            if (msg.is_final) {
              this.emit("transcription.completed", { type: "transcription.completed", transcript });
            } else {
              this.emit("transcription.delta", { type: "transcription.delta", delta: transcript });
            }
          } else if (msg.type === "UtteranceBegin") {
            this.emit("speech.started", { type: "speech.started" });
          } else if (msg.type === "UtteranceEnd") {
            this.emit("speech.stopped", { type: "speech.stopped" });
          }
        } catch (err) {
          this.emit("error", { type: "error", error: err });
        }
      });

      this.websocket.on("close", (code, reason) => {
        this.isConnected = false;
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.emit("connection.closed", { type: "connection.closed", code, reason: reason.toString() });
      });

      this.websocket.on("error", (err) => {
        this.isConnected = false;
        reject(err);
      });
    });
  }

  appendAudio(base64Pcm16: string): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error("Upstream WebSocket not open");
    }
    const buf = Buffer.from(base64Pcm16, "base64");
    this.websocket.send(buf);
  }

  appendBinary(buffer: Buffer): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error("Upstream WebSocket not open");
    }
    this.websocket.send(buffer);
  }

  endAudio(): void {
    // No explicit end signal; caller can disconnect to stop session.
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
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

