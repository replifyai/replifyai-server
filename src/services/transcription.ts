import { OpenAIRealtimeService, RealtimeTranscriptionOptions as OAOpts } from "./openaiRealtime.js";
import { DeepgramRealtimeService } from "./deepgramRealtime.js";
import { env } from "../env.js";

export interface RealtimeTranscriptionOptions extends OAOpts {
  provider?: "openai" | "deepgram";
  sampleRate?: number;
  language?: string;
  audioEncoding?: "pcm16" | "opus";
  audioContainer?: "webm" | "ogg";
  channels?: number;
}

export interface TranscriptionService {
  connect(): Promise<void>;
  appendAudio(base64Pcm16: string): void;
  endAudio(): void;
  on(eventType: string, handler: (event: { type: string; [k: string]: any }) => void): void;
  off(eventType: string, handler: (event: { type: string; [k: string]: any }) => void): void;
  disconnect(): void;
}

export function createTranscriptionService(opts: RealtimeTranscriptionOptions = {}): TranscriptionService {
  const provider = (opts.provider ?? env.SPEECH_PROVIDER ?? "openai").toLowerCase();
  console.log("🚀 ~ createTranscriptionService ~ provider:", provider);
  const normalized = normalizeLanguage(opts.language);
  if (provider === "deepgram") {
    return new DeepgramRealtimeService({
      language: mapLanguageForDeepgram(normalized),
      sampleRate: opts.sampleRate ?? 16000,
      punctuate: true,
      interimResults: true,
      vadEvents: true,
      model: "nova-2-general",
      encoding: (opts.audioEncoding === "opus") ? "opus" : "linear16",
      container: opts.audioEncoding === "opus" ? (opts.audioContainer ?? "webm") : undefined,
      channels: opts.channels ?? 1,
    });
  }
  return new OpenAIRealtimeService({ ...opts, language: mapLanguageForOpenAI(normalized) });
}

function normalizeLanguage(input?: string): string | undefined {
  if (!input) return undefined;
  const code = input.toLowerCase();
  // Basic normalization: accept "en"/"en-us", "hi"/"hi-in". Fall back to input.
  if (code === "en" || code === "en-us") return "en";
  if (code === "hi" || code === "hi-in") return "hi";
  if (/^[a-z]{2}-[A-Z]{2}$/.test(input)) return input; // already region formatted like hi-IN
  return input;
}

function mapLanguageForDeepgram(lang?: string): string | undefined {
  if (!lang) return undefined; // DG will default to en-US
  // Deepgram expects BCP-47 like en-US, hi-IN; map plain codes
  // if (lang === "en") return "en";
  // if (lang === "hi") return "hi";
  return lang;
}

function mapLanguageForOpenAI(lang?: string): string | undefined {
  if (!lang) return undefined;
  // OpenAI Whisper expects language codes like "en", "hi"
  if (lang.toLowerCase().startsWith("en")) return "en";
  if (lang.toLowerCase().startsWith("hi")) return "hi";
  // Fallback: if BCP-47 provided, return base language
  const base = lang.split("-")[0];
  return base || lang;
}

