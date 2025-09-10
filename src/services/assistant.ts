import { ragService, RAGStreamEvent } from "./ragService.js";
import { inferenceProvider } from "./inference.js";
import { decisionTreeService, DecisionStep } from "./decisionTree.js";
import { smartDisplayService, DisplayFormat } from "./smartDisplay.js";
import { modelRouterService } from "./modelRouter.js";
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
  displayFormat?: DisplayFormat;
  decisionPath?: DecisionStep[];
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
  // if (nonProductPhrases.some(p => text === p || text.includes(p))) {
  //   return false;
  // }

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
    const response = await inferenceProvider.chatCompletion(
      system,
      user,
      { temperature: 0.1, maxTokens: 1000 }
    )
    const parsed = safeParseUseRAG(response);
    if (typeof parsed === 'boolean') return parsed;
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

/**
 * Stream assistant suggestion with real-time generation
 * Integrates decision tree routing and smart display formatting
 */
export async function streamAssistantSuggestion(
  userUtterance: string,
  options: AssistantOptions = {},
  callbacks: {
    onDelta: (delta: string) => void,
    onCompleted: (suggestion: Omit<AssistantSuggestion, 'suggestion'>) => void,
    onError: (error: Error) => void,
  }
): Promise<void> {
  const { productName = "" } = options;
  
  try {
    // Step 1: Use decision tree to determine routing
    const decisionResult = await decisionTreeService.execute('main', {
      query: userUtterance,
      productName,
      previousDecisions: [],
      metadata: {}
    });

    const decision = decisionResult.result;
    console.log("Decision tree result:", decisionTreeService.visualizePath(decisionResult));

    // Step 2: Route to appropriate model based on decision
    const modelDecision = await modelRouterService.routeTask({
      taskType: decision.useRAG ? 'complex_analysis' : 'simple_qa',
      complexity: decision.useRAG ? 7 : 3,
      contextSize: decision.useRAG ? 2000 : 500,
      latencySensitive: true,
      qualityRequired: decision.confidence > 0.8 ? 8 : 6
    });

    console.log(`Model routing: ${modelDecision.provider}/${modelDecision.model} - ${modelDecision.reasoning}`);

    // Step 3: Handle based on decision
    if (decisionResult.impossibleFlag) {
      // Impossible flag set - return helpful message
      callbacks.onDelta(decision.suggestion || "I don't have information about that in the available documents.");
      callbacks.onCompleted({
        sources: [],
        displayFormat: { type: 'text', data: null },
        decisionPath: decisionResult.decisions
      });
      return;
    }

    if (decision.useRAG) {
      // Use RAG with streaming - use "query" intent to match the regular API call
      const stream = ragService.streamQueryDocuments(userUtterance, { 
        productName, 
        intent: options?.intent || "query" 
      });
      
      let finalSources: AssistantSuggestion['sources'] = [];
      let contextAnalysis: any = null;

      for await (const event of stream) {
        if (event.type === 'delta') {
          callbacks.onDelta(event.payload);
        } else if (event.type === 'sources') {
          finalSources = event.payload;
        } else if (event.type === 'analysis') {
          contextAnalysis = event.payload;
        } else if (event.type === 'error') {
          throw new Error(event.payload);
        }
      }

      // Analyze display format
      const displayFormat = smartDisplayService.analyze(finalSources || [], userUtterance);

      callbacks.onCompleted({ 
        sources: finalSources, 
        displayFormat,
        decisionPath: decisionResult.decisions
      });

    } else {
      // Non-RAG streaming with selected model
      // For now, use the default provider instead of model routing
      // TODO: Implement proper provider switching in inference service
      const stream = inferenceProvider.chatCompletionStream(
        DEFAULT_SYSTEM_PROMPT,
        userUtterance,
        { 
          temperature: 0.1, 
          maxTokens: 1000
          // Temporarily disabled model routing due to provider mismatch
          // model: modelDecision.model
        }
      );

      for await (const chunk of stream) {
        callbacks.onDelta(chunk);
      }

      callbacks.onCompleted({ 
        sources: [], 
        displayFormat: { type: 'text', data: null },
        decisionPath: decisionResult.decisions
      });
    }
  } catch (error) {
    console.error("Assistant suggestion stream failed:", error);
    callbacks.onError(error as Error);
  }
}

export async function generateAssistantSuggestion(
  userUtterance: string,
  options: AssistantOptions = {}
): Promise<AssistantSuggestion> {
  const { useRAG, productName = "", model, temperature = 0.2 } = options;
  const effectiveUseRAG = await detectProductIntent(userUtterance, productName);
  console.log("🚀 ~ generateAssistantSuggestion ~ useRAG(effective):", effectiveUseRAG);

  // 1) If RAG requested, use existing pipeline - use "query" intent to match the regular API call
  if (effectiveUseRAG) {
    const rag = await ragService.queryDocuments(userUtterance, { productName, retrievalCount: 5, similarityThreshold: 0.70, intent: "query" });
    return { suggestion: rag.response, sources: rag.sources };
  }

  // 2) Otherwise, generate a concise suggestion via LLM
  try {
    const response = await inferenceProvider.chatCompletion(
      DEFAULT_SYSTEM_PROMPT,
      userUtterance,
      { temperature: 0.1, maxTokens: 1000 }
    )
    return { suggestion: response.trim() };
  } catch (error) {
    console.error("Assistant suggestion generation failed:", error);
    return { suggestion: "" };
  }
}

