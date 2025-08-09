import { env } from "../env.js";
import { openai } from "./openai.js";
import { generateGroqChatResponse } from "./groq.js";
import { ragService } from "./ragService.js";

export interface AssistantOptions {
  useRAG?: boolean;
  productName?: string;
  model?: string; // override LLM model when not using RAG
  temperature?: number;
}

export interface AssistantSuggestion {
  suggestion: string;
  sources?: Array<{
    documentId: number;
    filename: string;
    content: string;
    score: number;
    metadata?: any;
    sourceUrl?: string;
    uploadType?: string;
  }>;
}

const DEFAULT_SYSTEM_PROMPT =
  "You generate concise, actionable replies based on the user's last utterance. Keep responses under 80 words. If the question is ambiguous, ask exactly one clarifying question first. Avoid hallucinations.";

function detectProductIntent(utterance: string): boolean {
  const text = utterance.toLowerCase();
  const keywords = [
    "price", "pricing", "cost", "quote", "plan", "package", "tier", "upgrade",
    "feature", "features", "spec", "specification", "capability", "limits",
    "compare", "comparison", " vs ", "versus", "alternative",
    "buy", "purchase", "order", "license", "licence", "subscription", "trial", "demo",
    "enterprise", "pro", "premium", "basic",
    "integration", "compatible", "support", "sla", "uptime",
    "billing", "invoice", "refund"
  ];
  return keywords.some(k => text.includes(k));
}

export async function generateAssistantSuggestion(
  userUtterance: string,
  options: AssistantOptions = {}
): Promise<AssistantSuggestion> {
  const { useRAG, productName = "", model, temperature = 0.2 } = options;
  const effectiveUseRAG = typeof useRAG === 'boolean' ? useRAG : detectProductIntent(userUtterance);
  console.log("🚀 ~ generateAssistantSuggestion ~ useRAG(effective):", effectiveUseRAG);

  // 1) If RAG requested, use existing pipeline
  if (effectiveUseRAG) {
    const rag = await ragService.queryDocuments(userUtterance, { productName, retrievalCount: 5, similarityThreshold: 0.70, intent: "sales" });
    return { suggestion: rag.response, sources: rag.sources };
  }

  // 2) Otherwise, generate a concise suggestion via LLM
  try {
    if (env.GROQ_API_KEY) {
      const reply = await generateGroqChatResponse(
        DEFAULT_SYSTEM_PROMPT,
        userUtterance,
        {
          model: model || "llama-3.3-70b-versatile",
          temperature,
          maxTokens: 220,
        }
      );
      return { suggestion: reply.trim() };
    }

    const response = await openai.chat.completions.create({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: userUtterance },
      ],
      temperature,
      max_tokens: 220,
    });
    const suggestion = response.choices[0]?.message?.content?.trim() || "";
    console.log("🚀 ~ generateAssistantSuggestion ~ suggestion:", suggestion);
    return { suggestion };
  } catch (error) {
    console.error("Assistant suggestion generation failed:", error);
    return { suggestion: "" };
  }
}

