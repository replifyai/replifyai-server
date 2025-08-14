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

const DEFAULT_SYSTEM_PROMPT = `
You are a friendly, consultative sales agent.
Style: natural, human, second-person, and approachable; mirror the user's wording; avoid jargon.
Goal: understand the need, highlight 2–3 benefits (not just features), and propose a clear next step.
Constraints: ≤80 words; single short paragraph; no bullets, no numbered lists, no headings, no bold; factual only—do not invent details. If ambiguous, ask exactly one clarifying question.
Output: 1–3 short sentences and a simple CTA (e.g., offer a demo/trial, pricing info, or ask for use case, team size, or timeline).
Do not mention being an AI.
`;

// Heuristic + LLM hybrid intent detection to decide if we should use RAG
// Returns true when the user likely asks about product features, pricing, plans, limits,
// integrations, comparisons, troubleshooting, or other documentation-backed topics.
async function detectProductIntent(
  utterance: string,
  productName?: string
): Promise<boolean> {
  const text = utterance.toLowerCase().trim();

  // 1) Fast exits for obviously non-product queries (avoid LLM calls)
  const nonProductPhrases = [
    "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
    "how are you", "what's up", "thank you", "thanks", "cool", "nice",
    "tell me a joke", "joke", "weather", "time", "date", "who are you",
    "what is your name", "repeat that", "can you repeat", "ok", "okay",
  ];
  if (nonProductPhrases.some(p => text === p || text.includes(p))) {
    return false;
  }

  // 2) Strong positive heuristics (no LLM needed for obvious product intent)
  const positiveKeywords = [
    // Sales/pricing/plans
    "price", "pricing", "cost", "quote", "plan", "plans", "package", "packages", "tier", "tiers", "upgrade", "rate",
    // Features/specs/limits
    "feature", "features", "spec", "specification", "capability", "capabilities", "limit", "limits", "quota", "quotas",
    // Comparison/evaluation
    "compare", "comparison", " vs ", "versus", "alternative", "alternatives", "benchmark",
    // Purchase/trial/demo
    "buy", "purchase", "order", "license", "licence", "subscription", "trial", "demo",
    // Enterprise/support/sla
    "enterprise", "pro", "premium", "basic", "support", "sla", "uptime", "downtime",
    // Integrations/compatibility
    "integration", "integrate", "integrations", "compatible", "compatibility", "sdk", "api",
    // Billing/refunds
    "billing", "invoice", "refund", "refunds",
    // Troubleshooting/how-to for product
    "error", "failed", "failing", "not working", "issue", "bug", "fix", "configure", "configuration",
  ];

  const positivePatterns: RegExp[] = [
    /(how much|what('s| is) the price|cost)\b/,
    /(does it|do you) (support|integrate|work with)\b/,
    /(is it )?(compatible|supported) with\b/,
    /(how do i|how to) (set up|configure|use|install)\b/,
    /(what('?s| is) included|what do i get|what features)\b/,
    /(compare|difference between).+ (and|vs\.)/,
  ];

  if (
    positiveKeywords.some(k => text.includes(k)) ||
    positivePatterns.some(r => r.test(text)) ||
    (productName && text.includes(productName.toLowerCase()))
  ) {
    return true;
  }

  // 3) Ambiguous → ask an LLM classifier
  try {
    const system = "Classify if the user's message requires product/documentation knowledge retrieval (RAG). " +
      "Return ONLY compact JSON: {\"useRAG\": boolean, \"category\": string, \"confidence\": number}. " +
      "Examples that require RAG: pricing, plans, features, specs, limits, comparisons, integrations, compatibility, API/SDK usage, troubleshooting, support, billing, refunds, SLA, uptime. " +
      "Small talk or generic chit-chat does NOT require RAG.";

    const user = [
      productName ? `Product: ${productName}` : undefined,
      `Message: ${utterance}`,
    ].filter(Boolean).join("\n");

    if (env.GROQ_API_KEY) {
      const raw = await generateGroqChatResponse(system, user, {
        model: "llama-3.3-70b-versatile",
        temperature: 0.0,
        maxTokens: 120,
      });
      const parsed = safeParseUseRAG(raw);
      if (typeof parsed === 'boolean') return parsed;
    } else {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.0,
        max_tokens: 120,
      });
      const content = response.choices[0]?.message?.content ?? "";
      const parsed = safeParseUseRAG(content);
      if (typeof parsed === 'boolean') return parsed;
    }
  } catch (e) {
    console.error("LLM intent classification failed:", e);
  }

  // 4) Fallback: conservative default is false (no RAG)
  return false;
}

function safeParseUseRAG(text: string): boolean | null {
  try {
    const trimmed = text.trim();
    // Try JSON first
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      const json = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
      if (typeof json.useRAG === 'boolean') return json.useRAG;
    }
    // Fallback: regex on YES/NO style answers
    const yes = /(rag\s*:\s*)?(yes|true)\b/i.test(trimmed);
    const no = /(rag\s*:\s*)?(no|false)\b/i.test(trimmed);
    if (yes && !no) return true;
    if (no && !yes) return false;
    return null;
  } catch {
    return null;
  }
}

export async function generateAssistantSuggestion(
  userUtterance: string,
  options: AssistantOptions = {}
): Promise<AssistantSuggestion> {
  const { useRAG, productName = "", model, temperature = 0.2 } = options;
  const effectiveUseRAG = typeof useRAG === 'boolean'
    ? useRAG
    : await detectProductIntent(userUtterance, productName);
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
          model: model || "llama-3.1-8b-instant",
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

