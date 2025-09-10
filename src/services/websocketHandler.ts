import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { createTranscriptionService } from "./transcription.js";
import { generateAssistantSuggestion, streamAssistantSuggestion } from "./assistant.js";

interface ClientSession {
  id: string;
  client: WebSocket;
  upstream?: ReturnType<typeof createTranscriptionService>;
  active: boolean;
}

export class WebSocketHandler {
  private wss: WebSocketServer;
  private sessions = new Map<string, ClientSession>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/ws/realtime-transcription" });
    this.attach();
  }

  private attach(): void {
    this.wss.on("connection", (ws) => this.handleConnection(ws));
  }

  private handleConnection(client: WebSocket): void {
    const id = this.generateId();
    const session: ClientSession = { id, client, active: false };
    this.sessions.set(id, session);

    this.safeSend(client, { type: "connection.established", sessionId: id });

    client.on("message", (raw: Buffer) => this.handleMessage(session, raw));
    client.on("close", () => this.cleanup(id));
    client.on("error", () => this.cleanup(id));
  }

  private async handleMessage(session: ClientSession, raw: Buffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // If not JSON, try handling as binary chunk for Deepgram (opus/webm)
      if (session.active && session.upstream && Buffer.isBuffer(raw)) {
        try {
          // @ts-ignore: Deepgram impl supports appendBinary
          if (typeof (session.upstream as any).appendBinary === 'function') {
            (session.upstream as any).appendBinary(raw);
            return;
          }
        } catch {}
      }
      return this.safeSend(session.client, { type: "error", message: "invalid_json" });
    }

    switch (msg.type) {
      case "start_transcription":
        console.log("🚀 ~ WebSocketHandler ~ handleMessage ~ msg.options:", msg.options);
        if (session.active) return;
        await this.startUpstream(session, msg.options);
        break;
      case "audio_data":
        if (!session.active || !session.upstream) return;
        try {
          session.upstream.appendAudio(msg.audio);
        } catch (e) {
          this.safeSend(session.client, { type: "error", message: "audio_forward_failed" });
        }
        break;
      case "audio_binary":
        if (!session.active || !session.upstream) return;
        try {
          const chunk: Buffer = Buffer.from(msg.data, msg.encoding === 'base64' ? 'base64' : undefined);
          // @ts-ignore
          if (typeof (session.upstream as any).appendBinary === 'function') {
            // @ts-ignore
            (session.upstream as any).appendBinary(chunk);
          }
        } catch (e) {
          this.safeSend(session.client, { type: "error", message: "audio_forward_failed" });
        }
        break;
      case "stop_transcription":
        this.stopUpstream(session);
        break;
      case "user.message":
        // Handle direct text messages (not audio transcription)
        await this.handleTextMessage(session, msg);
        break;
      default:
        this.safeSend(session.client, { type: "error", message: "unknown_message_type" });
    }
  }

  private async startUpstream(session: ClientSession, options: any): Promise<void> {
    // Store productName in session if provided
    if (options?.productName) {
      (session as any).productName = options.productName;
    }
    
    const upstream = createTranscriptionService({
      provider: options?.provider,
      model: options?.model ?? "whisper-1",
      language: options?.language,
      turnDetection: options?.turnDetection,
      sampleRate: options?.sampleRate ?? 16000,
    });

    upstream.on("transcription.delta", (e: any) => {
      this.safeSend(session.client, { type: "transcription.delta", delta: e.delta });
    });
    upstream.on("transcription.completed", (e: any) => {
      const transcript: string = e.transcript || "";
      this.safeSend(session.client, { type: "transcription.completed", transcript });

      // Fire-and-forget: generate assistant suggestion with streaming
      (async () => {
        try {
          // Check if client wants streaming (can be configured via options)
          const enableStreaming = true; // TODO: make this configurable
          
          if (enableStreaming) {
            await streamAssistantSuggestion(
              transcript, 
              {
                // Pass productName from session if available
                productName: (session as any).productName || ""
              },
              {
                onDelta: (delta) => {
                  this.safeSend(session.client, {
                    type: "assistant.suggestion.delta",
                    delta,
                  });
                },
                onCompleted: (suggestion) => {
                  this.safeSend(session.client, {
                    type: "assistant.suggestion.completed",
                    ...suggestion,
                  });
                },
                onError: (error) => {
                  this.safeSend(session.client, {
                    type: "assistant.suggestion.error",
                    message: error.message,
                  });
                }
              }
            );
          } else {
            // Fallback to non-streaming
            const suggestion = await generateAssistantSuggestion(transcript, {
              // Pass productName from session if available
              productName: (session as any).productName || ""
            });
            if (suggestion.suggestion) {
              this.safeSend(session.client, {
                type: "assistant.suggestion",
                text: suggestion.suggestion,
                sources: suggestion.sources ?? [],
              });
            }
          }
        } catch (err) {
          console.error("assistant suggestion failed", err);
          this.safeSend(session.client, {
            type: "assistant.suggestion.error",
            message: "Failed to generate suggestion",
          });
        }
      })();
    });
    upstream.on("speech.started", () => {
      this.safeSend(session.client, { type: "speech.started" });
    });
    upstream.on("speech.stopped", () => {
      this.safeSend(session.client, { type: "speech.stopped" });
    });
    upstream.on("error", (e: any) => {
      this.safeSend(session.client, { type: "error", message: e.error?.message ?? "upstream_error" });
    });
    upstream.on("connection.closed", () => {
      this.safeSend(session.client, { type: "stt.disconnected" });
    });

    try {
      await upstream.connect();
      session.upstream = upstream as any;
      session.active = true;
      this.safeSend(session.client, { type: "transcription.started" });
    } catch (e: any) {
      this.safeSend(session.client, { type: "error", message: e?.message ?? "connect_failed" });
    }
  }

  private stopUpstream(session: ClientSession): void {
    if (!session.active || !session.upstream) return;
    try {
      session.upstream.endAudio();
    } catch {
      // ignore
    }
    session.upstream.disconnect();
    session.active = false;
    this.safeSend(session.client, { type: "transcription.stopped" });
  }

  private async handleTextMessage(session: ClientSession, msg: any): Promise<void> {
    const { message, productName, streaming = true, includeMetadata = false } = msg;
    
    if (!message) {
      return this.safeSend(session.client, { type: "error", message: "Message text is required" });
    }

    // Send acknowledgment
    this.safeSend(session.client, { type: "message.received", message });

    try {
      if (streaming) {
        // Use streaming response
        await streamAssistantSuggestion(
          message, 
          { productName },
          {
            onDelta: (delta) => {
              this.safeSend(session.client, {
                type: "assistant.suggestion.delta",
                delta,
              });
            },
            onCompleted: (suggestion) => {
              const response: any = {
                type: "assistant.suggestion.completed",
                ...suggestion,
              };
              
              // Include metadata if requested
              if (!includeMetadata) {
                delete response.decisionPath;
                delete response.displayFormat;
              }
              
              this.safeSend(session.client, response);
            },
            onError: (error) => {
              this.safeSend(session.client, {
                type: "assistant.suggestion.error",
                message: error.message,
              });
            }
          }
        );
      } else {
        // Use non-streaming response
        const suggestion = await generateAssistantSuggestion(message, { productName });
        
        const response: any = {
          type: "assistant.suggestion",
          text: suggestion.suggestion,
          sources: suggestion.sources ?? [],
        };
        
        if (includeMetadata) {
          response.displayFormat = suggestion.displayFormat;
          response.decisionPath = suggestion.decisionPath;
        }
        
        this.safeSend(session.client, response);
      }
    } catch (error) {
      console.error("Error handling text message:", error);
      this.safeSend(session.client, {
        type: "assistant.suggestion.error",
        message: "Failed to generate response",
      });
    }
  }

  private cleanup(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.active && s.upstream) {
      try {
        s.upstream.disconnect();
      } catch {
        // ignore
      }
    }
    this.sessions.delete(id);
  }

  private safeSend(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private generateId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  getActiveSessions(): number {
    let count = 0;
    this.sessions.forEach((s) => { if (s.active) count += 1; });
    return count;
  }

  getTotalSessions(): number {
    return this.sessions.size;
  }
}

