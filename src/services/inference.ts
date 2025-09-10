import { env } from "../env.js";
import { openai } from "./openai.js";
import { generateGroqChatResponse } from "./groq.js";
import { generateNebiusChatResponse } from "./nebius.js";

export type InferenceProviderName = "openai" | "groq" | "nebius";

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
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
      case "groq":
        return generateGroqChatResponse(systemPrompt, userPrompt, options);
      case "nebius":
        return generateNebiusChatResponse(systemPrompt, userPrompt, options);
      case "openai":
      default: {
        const { model = "gpt-4o-mini", temperature = 0.1, maxTokens = 1000 } = options;
        const response = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature,
          max_tokens: maxTokens,
        });
        return response.choices[0]?.message?.content || "I couldn't generate a response.";
      }
    }
  },

  async *chatCompletionStream(
    systemPrompt: string,
    userPrompt: string,
    options: ChatOptions = {}
  ): AsyncGenerator<string> {
    const provider = this.active;
    
    // For now, only OpenAI supports streaming
    // Groq and Nebius will fall back to chunked response
    if (provider === "openai") {
      const { model = "gpt-4o-mini", temperature = 0.1, maxTokens = 1000 } = options;
      const stream = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } else {
      // Fallback: Get full response and yield in chunks
      const fullResponse = await this.chatCompletion(systemPrompt, userPrompt, options);
      const words = fullResponse.split(' ');
      const chunkSize = 5; // Yield 5 words at a time
      
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(' ');
        yield chunk + (i + chunkSize < words.length ? ' ' : '');
        // Add small delay to simulate streaming
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  },
};

