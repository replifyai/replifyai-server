import Groq from "groq-sdk";
import { env } from "../../env.js";

// Initialize Groq client
const groq = new Groq({
  apiKey: env.GROQ_API_KEY,
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

/**
 * Generate chat response using Groq's LLM models
 */
export async function generateGroqChatResponse(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const {
    model = env.GROQ_MODEL, // Use a fast, production-ready model
    temperature = 0.1,
    maxTokens = 1000,
  } = options;

  try {
    const response = await groq.chat.completions.create({
      model,
      service_tier:"auto",
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature,
      max_tokens: maxTokens,
    });

    return response.choices[0]?.message?.content || "I couldn't generate a response.";
  } catch (error) {
    console.error("Groq chat completion failed:", error);
    throw new Error(`Failed to generate chat response with Groq: ${(error as Error).message}`);
  }
}

export { groq }; 