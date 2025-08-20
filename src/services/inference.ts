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
};

