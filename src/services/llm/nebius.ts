import OpenAI from "openai";
import { env } from "../../env.js";

// Nebius Studio exposes an OpenAI-compatible API. We use the OpenAI SDK with a custom baseURL.
const nebius = new OpenAI({
  apiKey: env.NEBIUS_API_KEY,
  baseURL: env.NEBIUS_BASE_URL || "https://studio.nebius.com/api/openai", // allow override via env
  timeout: env.API_TIMEOUT,
});

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function generateNebiusChatResponse(
  messages: ChatMessage[],
  options: ChatOptions = {},
  llmmodel?: string
): Promise<string> {
  const {
    model = llmmodel || env.NEBIUS_MODEL || "meta-llama/Meta-Llama-3.1-8B-Instruct-fast",
    temperature = 0.1,
    maxTokens = 1000,
  } = options;


  const response = await nebius.chat.completions.create({
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    temperature,
    max_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content || "I couldn't generate a response.";
}

export { nebius };

