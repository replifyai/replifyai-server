import { env } from "../../env.js";
import { openai } from "./openai.js";
import { generateGroqChatResponse } from "./groq.js";
import { generateNebiusChatResponse } from "./nebius.js";

export type InferenceProviderName = "openai" | "groq" | "nebius";

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Retry with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 500
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries - 1) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        console.warn(`Retry attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${delay}ms...`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError!;
}

export const inferenceProvider = {
  get active(): InferenceProviderName {
    const provider = (process.env.LLM_PROVIDER || env.LLM_PROVIDER || "openai").toLowerCase();
    if (provider === "groq" || provider === "nebius" || provider === "openai") return provider as InferenceProviderName;
    return "openai";
  },

  async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: ChatOptions = {}
  ): Promise<string> {
    const provider = this.active;
    
    switch (provider) {
      case "groq": {
        // Try Groq with exponential backoff, fallback to Nebius on failure
        try {
          const response = await retryWithBackoff(
            () => generateGroqChatResponse(systemPrompt, userPrompt, options),
            3,
            500
          );
          return response;
        } catch (error) {
          console.error("Groq inference failed, falling back to Nebius:", (error as Error).message);
          try {
            const response = await generateNebiusChatResponse(systemPrompt, userPrompt, options);
            return response;
          } catch (nebiusError) {
            console.error("Nebius fallback also failed:", (nebiusError as Error).message);
            throw new Error(`Both Groq and Nebius inference failed. Groq: ${(error as Error).message}, Nebius: ${(nebiusError as Error).message}`);
          }
        }
      }
      
      case "nebius":
        return generateNebiusChatResponse(systemPrompt, userPrompt, options);
      
      case "openai":
      default: {
        const { model = "gpt-5", maxTokens = 1000 } = options;
        const response = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_completion_tokens: maxTokens,
        });
        return response.choices[0]?.message?.content || "I couldn't generate a response.";
      }
    }
  },
};

