import Groq from "groq-sdk";
import { env } from "../../env.js";

// Initialize Groq client
const groq = new Groq({
  apiKey: env.GROQ_API_KEY,
  timeout: env.API_TIMEOUT,
});

/**
 * Generate chat response using Groq's LLM models
 */
export async function generateGroqChatResponse(
  systemPrompt: string,
  userPrompt: string,
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  } = {}
): Promise<string> {
  const {
    model = env.GROQ_MODEL, // Use a fast, production-ready model
    temperature = 0.1,
    maxTokens = 1000,
  } = options;

  try {
    const response = await groq.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
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