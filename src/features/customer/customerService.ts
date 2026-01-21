import { ragService } from "../rag/core/ragService.js";
import { qdrantService, SearchResult } from "../rag/providers/qdrantHybrid.js";
import { inferenceProvider } from "../../services/llm/inference.js";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Conversation message for maintaining context
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  productsMentioned?: string[];
}

/**
 * Product with actionable information for WhatsApp
 */
export interface ProductRecommendation {
  name: string;
  description: string;
  price?: string;
  imageUrl?: string;
  productUrl?: string;
  ctaText?: string;
  relevanceReason?: string;
  features?: string[];
}

/**
 * Options for processing customer queries
 */
export interface CustomerQueryOptions {
  productName?: string;
  category?: string;
  userId?: string;
  sessionId?: string;
  retrievalCount?: number;
  similarityThreshold?: number;
  conversationHistory?: ConversationMessage[];
  maxHistoryMessages?: number;
}

/**
 * Enhanced response for WhatsApp chatbot
 */
export interface CustomerQueryResponse {
  query: string;
  response: string;
  intent: {
    type: 'product_inquiry' | 'purchase_intent' | 'support' | 'general' | 'comparison' | 'clarification_needed';
    confidence: number;
    suggestedActions: string[];
  };
  suggestedFollowups: string[];
  productNames?: string[];
  recommendations?: {
    products: ProductRecommendation[];
  };
  contextAnalysis: {
    isContextMissing: boolean;
    suggestedTopics: string[];
    category: string;
    priority: 'low' | 'medium' | 'high';
  };
  agentType?: 'sales_expert';
  metadata?: {
    responseTimeMs: number;
    contextChunksUsed: number;
  };
}

// ============================================================================
// INTELLIGENT SALES AGENT SERVICE
// ============================================================================

export class CustomerService {

  /**
   * The unified intelligent sales prompt that combines intent analysis,
   * response generation, follow-up questions, and recommendations
   */
  private readonly INTELLIGENT_SALES_PROMPT = `
You are an ELITE AI Sales Expert and Personal Shopping Assistant. You are NOT a generic chatbot - you are a sophisticated, charming, and incredibly knowledgeable sales professional who genuinely cares about finding the perfect product for each customer.

═══════════════════════════════════════════════════════════════════════════════
🎯 YOUR MISSION
═══════════════════════════════════════════════════════════════════════════════
Turn every interaction into a delightful shopping experience. You are the customer's trusted advisor, product expert, and personal assistant rolled into one. Your goal is to:
1. Understand their needs deeply (even when they're vague)
2. Recommend the PERFECT products with genuine enthusiasm  
3. Create urgency and excitement naturally (never pushy)
4. Guide them toward purchase with helpful suggestions
5. Keep them engaged with smart follow-up questions

═══════════════════════════════════════════════════════════════════════════════
📋 CUSTOMER QUERY
═══════════════════════════════════════════════════════════════════════════════
{query}

═══════════════════════════════════════════════════════════════════════════════
💬 CONVERSATION HISTORY (for context)
═══════════════════════════════════════════════════════════════════════════════
{conversationHistory}

═══════════════════════════════════════════════════════════════════════════════
📚 PRODUCT KNOWLEDGE BASE
═══════════════════════════════════════════════════════════════════════════════
{context}

═══════════════════════════════════════════════════════════════════════════════
🧠 RESPONSE REQUIREMENTS - RETURN VALID JSON ONLY
═══════════════════════════════════════════════════════════════════════════════

You MUST respond with a valid JSON object in EXACTLY this format (no markdown, no code blocks):

{
  "intent": {
    "type": "product_inquiry|purchase_intent|support|general|comparison",
    "confidence": 0.0-1.0,
    "suggestedActions": ["action1", "action2"]
  },
  "response": "Your friendly, expert response here...",
  "productNames": ["Exact Product Name 1", "Exact Product Name 2"],
  "suggestedFollowups": [
    "Question to keep them engaged 1?",
    "Question to guide toward purchase 2?",
    "Cross-sell/upsell question 3?"
  ],
  "recommendations": [
    {
      "name": "Exact Product Name",
      "description": "Brief compelling description",
      "price": "₹XXX (if available in context)",
      "relevanceReason": "Why this is perfect for them"
    }
  ]
}

═══════════════════════════════════════════════════════════════════════════════
✨ SALES EXCELLENCE GUIDELINES
═══════════════════════════════════════════════════════════════════════════════

🎨 PERSONALITY & TONE:
• Be warm, enthusiastic, and genuinely helpful - like a friend who happens to be an expert
• Use "you" and "your" to make it personal
• Show excitement about great products: "This is perfect for you!" "Customers love this!"
• Be conversational - write like you're chatting on WhatsApp, not writing an essay
• Use emojis sparingly but effectively (1-2 per response max) 🎯 ✨

📝 RESPONSE STRUCTURE:
• Keep responses concise (150-250 words max) - perfect for mobile reading
• Use bullet points (•) for product features or options
• Bold **key benefits** and **product names** using markdown
• Start with acknowledgment of their need, then dive into recommendations
• End with a clear direction (not just "let me know")

🛒 SALES INTELLIGENCE:
• ALWAYS suggest 2-3 products when relevant (give options!)
• Highlight the BEST VALUE option naturally
• Mention "popular choice" or "customer favorite" when applicable
• Create gentle urgency: "This has been flying off the shelves"
• Cross-sell: "This pairs perfectly with..." / "Many customers also get..."
• Upsell subtly: "For even better results, the Pro version..."

⚠️ CRITICAL - MULTI-PRODUCT QUERIES:
• The context is organized by product with headers like "=== PRODUCT: Product Name ==="
• When the user asks about multiple products, provide information for EACH product
• Example: If user asks "what colors?" and 2 products are in context, list colors for BOTH products
• Format multi-product answers clearly: "**Product A** comes in X, Y, Z. **Product B** comes in A, B, C."

❓ FOLLOW-UP QUESTIONS (CRITICAL - Always provide 3):
• Question 1: Clarifying question about their specific needs
• Question 2: Question that leads toward purchase decision
• Question 3: Cross-sell or upsell suggestion as a question

Examples:
- "Would you like me to check the current availability for you?"
- "Should I compare a few options based on your budget?"
- "Would you also need [complementary product] to go with this?"
- "Have you considered the premium version with [extra benefit]?"

🚫 NEVER DO:
• Never say "I don't have information" - find related helpful info instead
• Never mention "documentation" or "uploaded files" or being an AI
• Never give long walls of text - keep it scannable
• Never end without a clear next step or question
• Never ignore the conversation history if provided

💡 SPECIAL SCENARIOS:
• GREETING: Be warm, ask what they're looking for today
• VAGUE QUERY: Give your best recommendation AND ask a clarifying question
• COMPARISON: Create a quick side-by-side with clear winner recommendation
• PRICE QUERY: Share price AND highlight value/benefits
• SUPPORT ISSUE: Be empathetic, solve quickly, then suggest relevant products

═══════════════════════════════════════════════════════════════════════════════
⚠️ CRITICAL REMINDERS
═══════════════════════════════════════════════════════════════════════════════
1. Use EXACT product names from the context - never make up generic names
2. Only mention products that exist in the provided context
3. Prices in ₹ (Indian Rupees) only
4. ALWAYS provide exactly 3 suggestedFollowups
5. Response must be valid JSON - no markdown code blocks around it
`;

  /**
   * Process customer query with intelligent sales agent approach
   * Single unified LLM call for maximum performance
   */
  async processCustomerQuery(
    query: string,
    options: CustomerQueryOptions = {}
  ): Promise<CustomerQueryResponse> {
    const startTime = Date.now();

    const {
      category = "",
      userId,
      sessionId,
      retrievalCount = 15,
      similarityThreshold = 0.45,
      conversationHistory = [],
      maxHistoryMessages = 5
    } = options;

    console.log(`🛍️ Customer query: "${query}" | User: ${userId || 'anonymous'}`);


    try {
      // 1. Extract relevant products using LLM - considers BOTH conversation AND current query
      const relevantProducts = await this.extractRelevantProducts(query, conversationHistory);
      console.log(`🔒 Relevant products for query: ${relevantProducts.length > 0 ? relevantProducts.join(', ') : 'none'}`);

      // 2. Get context chunks - use PRODUCT LOCKING if products found, else fall back to semantic search
      let contextChunks: Array<{ id: string; content: string; filename: string; metadata?: any }> = [];

      if (relevantProducts.length > 0) {
        // PRODUCT LOCKING: Fetch ALL chunks for the specific products IN PARALLEL
        console.log(`🎯 Using product locking for: ${relevantProducts.join(', ')}`);
        const productsToFetch = relevantProducts.slice(0, 3); // Limit to 3 products

        // Parallel fetch for all products
        const chunkResults = await Promise.all(
          productsToFetch.map(async (productName) => {
            try {
              const productChunks = await qdrantService.getChunksByProductName(productName);
              console.log(`  📦 Found ${productChunks.length} chunks for "${productName}"`);
              return { productName, chunks: productChunks };
            } catch (error) {
              console.warn(`  ⚠️ Failed to fetch chunks for "${productName}":`, error);
              return { productName, chunks: [] };
            }
          })
        );

        // Organize chunks with clear product headers so LLM knows which product each chunk belongs to
        for (const { productName, chunks } of chunkResults) {
          if (chunks.length > 0) {
            // Add a header chunk to clearly separate products
            contextChunks.push({
              id: `${productName}_header`,
              content: `\n=== PRODUCT: ${productName} ===\n`,
              filename: 'product_header',
              metadata: { productName }
            });

            chunks.forEach((chunk, index) => {
              contextChunks.push({
                id: `${productName}_chunk_${index}`,
                content: chunk.content,
                filename: chunk.filename,
                metadata: chunk.metadata
              });
            });
          }
        }
      }

      // If no chunks from product locking, fall back to semantic search
      if (contextChunks.length === 0) {
        console.log(`🔍 Falling back to semantic search for: "${query}"`);
        const ragResult = await ragService.queryDocuments(query, {
          retrievalCount,
          similarityThreshold,
          productName: "",
          intent: "sales",
          skipGeneration: true
        });

        contextChunks = ragResult.sources.map((source, index) => ({
          id: `chunk_${index}`,
          content: source.content,
          filename: source.filename,
          metadata: source.metadata
        }));
      }

      console.log(`📚 Total context chunks: ${contextChunks.length}`);


      // 3. Format conversation history (limit to last N messages)
      const recentHistory = conversationHistory.slice(-maxHistoryMessages);
      const historyText = recentHistory.length > 0
        ? recentHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
        : 'No previous conversation - this is the first message.';

      // 4. Format context
      const contextText = contextChunks.length > 0
        ? contextChunks.map(c => `[From: ${c.filename}]\n${c.content}`).join('\n\n---\n\n')
        : 'No specific product context available. Provide helpful general guidance.';

      // 5. Build the unified prompt
      const systemPrompt = this.INTELLIGENT_SALES_PROMPT
        .replace('{query}', query)
        .replace('{conversationHistory}', historyText)
        .replace('{context}', contextText);

      // 6. Single LLM call for everything (performance optimization)
      console.log('🤖 Generating intelligent response...');
      const llmResponse = await inferenceProvider.chatCompletion(
        systemPrompt,
        `Process this customer query and return the JSON response: "${query}"`,
        { temperature: 0.3, maxTokens: 1500 }
      );

      // 7. Parse LLM response
      const parsedResponse = this.parseIntelligentResponse(llmResponse, query);

      const responseTimeMs = Date.now() - startTime;
      console.log(`✅ Response generated in ${responseTimeMs}ms`);

      // 8. Build final response
      const response: CustomerQueryResponse = {
        query,
        response: parsedResponse.response,
        intent: parsedResponse.intent,
        suggestedFollowups: parsedResponse.suggestedFollowups,
        productNames: parsedResponse.productNames,
        recommendations: parsedResponse.recommendations,
        contextAnalysis: {
          isContextMissing: contextChunks.length === 0,
          suggestedTopics: [],
          category: 'answered',
          priority: 'low' as const
        },
        agentType: 'sales_expert',
        metadata: {
          responseTimeMs,
          contextChunksUsed: contextChunks.length
        }
      };

      return response;

    } catch (error: any) {
      console.error("Customer query processing failed:", error);

      const responseTimeMs = Date.now() - startTime;

      // Graceful fallback with helpful guidance
      return {
        query,
        response: "I'm having a brief moment! 😅 Let me get back to you - in the meantime, feel free to tell me more about what you're looking for, and I'll find the perfect products for you!",
        intent: {
          type: 'general',
          confidence: 0.5,
          suggestedActions: ['retry_query', 'contact_support']
        },
        suggestedFollowups: [
          "What type of product are you looking for today?",
          "Is there a specific problem you're trying to solve?",
          "Do you have a budget in mind?"
        ],
        contextAnalysis: {
          isContextMissing: true,
          suggestedTopics: [],
          category: 'error',
          priority: 'high'
        },
        agentType: 'sales_expert',
        metadata: {
          responseTimeMs,
          contextChunksUsed: 0
        }
      };
    }
  }

  /**
   * Parse the intelligent LLM response with robust error handling
   */
  private parseIntelligentResponse(
    llmResponse: string,
    originalQuery: string
  ): {
    response: string;
    intent: CustomerQueryResponse['intent'];
    suggestedFollowups: string[];
    productNames?: string[];
    recommendations?: { products: ProductRecommendation[] };
  } {
    try {
      // Clean up the response - remove markdown code blocks if present
      let cleanedResponse = llmResponse
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/gi, '')
        .trim();

      // Try to parse as JSON
      const parsed = JSON.parse(cleanedResponse);

      // Validate and extract fields with defaults
      return {
        response: this.cleanResponse(parsed.response || "I'd be happy to help you find the perfect product!"),
        intent: {
          type: parsed.intent?.type || 'product_inquiry',
          confidence: parsed.intent?.confidence || 0.8,
          suggestedActions: parsed.intent?.suggestedActions || ['recommend_products']
        },
        suggestedFollowups: this.ensureFollowups(parsed.suggestedFollowups),
        productNames: Array.isArray(parsed.productNames) ? parsed.productNames : undefined,
        recommendations: parsed.recommendations?.length > 0
          ? { products: parsed.recommendations }
          : undefined
      };

    } catch (parseError) {
      console.warn('Failed to parse LLM JSON response, extracting content:', parseError);

      // Fallback: Extract what we can from the raw response
      return this.extractFromRawResponse(llmResponse, originalQuery);
    }
  }

  /**
   * Extract response data from non-JSON LLM output
   */
  private extractFromRawResponse(
    rawResponse: string,
    originalQuery: string
  ): {
    response: string;
    intent: CustomerQueryResponse['intent'];
    suggestedFollowups: string[];
    productNames?: string[];
    recommendations?: { products: ProductRecommendation[] };
  } {
    // Clean up the response
    let cleanedResponse = rawResponse
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/gi, '')
      .replace(/\[PRODUCTS?:.*?\]/gi, '')
      .replace(/\[CHUNK_ID:.*?\]/gi, '')
      .trim();

    // Try to extract product names from [PRODUCTS: ...] pattern
    const productNames: string[] = [];
    const productMatch = rawResponse.match(/\[PRODUCTS?:\s*([^\]]+)\]/i);
    if (productMatch && productMatch[1]) {
      const names = productMatch[1].split(',').map(n => n.trim()).filter(n => n.length > 0);
      productNames.push(...names);
    }

    // Generate follow-up questions based on query type
    const suggestedFollowups = this.generateDefaultFollowups(originalQuery);

    return {
      response: cleanedResponse.length > 20 ? cleanedResponse : "I'd love to help you find the perfect product! Could you tell me a bit more about what you're looking for?",
      intent: {
        type: 'product_inquiry',
        confidence: 0.7,
        suggestedActions: ['recommend_products']
      },
      suggestedFollowups,
      productNames: productNames.length > 0 ? productNames : undefined
    };
  }

  /**
   * Ensure we always have 3 follow-up questions
   */
  private ensureFollowups(followups: any): string[] {
    const defaultFollowups = [
      "Would you like me to compare a few options for you?",
      "Should I check current availability?",
      "Is there anything specific you'd like to know about these products?"
    ];

    if (!Array.isArray(followups) || followups.length === 0) {
      return defaultFollowups;
    }

    // Ensure exactly 3 follow-ups
    const validFollowups = followups
      .filter((f): f is string => typeof f === 'string' && f.length > 0)
      .slice(0, 3);

    while (validFollowups.length < 3) {
      validFollowups.push(defaultFollowups[validFollowups.length]);
    }

    return validFollowups;
  }

  /**
   * Generate default follow-ups based on query content
   */
  private generateDefaultFollowups(query: string): string[] {
    const queryLower = query.toLowerCase();

    if (queryLower.includes('price') || queryLower.includes('cost')) {
      return [
        "Would you like to see products in different price ranges?",
        "Should I find you the best value option?",
        "Are you looking for any specific features within your budget?"
      ];
    }

    if (queryLower.includes('compare') || queryLower.includes('vs') || queryLower.includes('difference')) {
      return [
        "Would you like a detailed side-by-side comparison?",
        "Which feature matters most to you?",
        "Should I recommend the best option based on your needs?"
      ];
    }

    if (queryLower.includes('best') || queryLower.includes('recommend')) {
      return [
        "What will you primarily use this for?",
        "Do you have a preferred budget range?",
        "Would you like to see our top-rated options?"
      ];
    }

    return [
      "What specific features are important to you?",
      "Would you like me to show you our most popular options?",
      "Is there anything else I can help you with today?"
    ];
  }

  /**
   * Extract RELEVANT product names based on BOTH the current query AND conversation history
   * This is smarter than just extracting all products - it determines which product(s)
   * the user is actually asking about in their current query
   */
  private async extractRelevantProducts(
    currentQuery: string,
    conversationHistory: ConversationMessage[]
  ): Promise<string[]> {
    if (conversationHistory.length === 0) {
      return [];
    }

    try {
      // Format recent conversation for LLM
      const recentHistory = conversationHistory.slice(-4);
      const historyText = recentHistory
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');

      const systemPrompt = `You are a smart product query analyzer.

CONVERSATION HISTORY:
${historyText}

CURRENT USER QUERY:
"${currentQuery}"

YOUR TASK:
Determine which specific product(s) from the conversation the user is asking about in their CURRENT query.

DECISION LOGIC:
1. If the user mentions a specific product in their current query → return ONLY that product
2. If the user asks about "both" or "all" or compares products → return all relevant products
3. If the user asks a follow-up (e.g., "what colors?", "how much?") without specifying → return the products being discussed
4. If the user asks about a new topic/product not in conversation → return NONE

KEY RULES:
- Return EXACT product names as they appear in the conversation (e.g., "Frido Cloud Comfort Arch Support Slippers")
- Return only products relevant to the CURRENT query, not all products mentioned
- If user references "the first one", "the second option", "the arch support one" → identify which specific product
- Maximum 3 products
- If can't determine, return NONE

OUTPUT FORMAT (just product names, one per line, or NONE):`;

      const response = await inferenceProvider.chatCompletion(
        systemPrompt,
        "Determine relevant products",
        { temperature: 0, maxTokens: 200 }
      );

      const result = response.trim();

      // Check if no products found
      if (result.toUpperCase() === 'NONE' || result.length < 5) {
        return [];
      }

      // Parse product names (one per line)
      const products = result
        .split('\n')
        .map(line => line.trim().replace(/^[\d\.\-\*]+\s*/, '')) // Remove numbering/bullets
        .filter(line => line.length > 5 && !line.toUpperCase().includes('NONE'))
        .slice(0, 3);

      return products;

    } catch (error) {
      console.warn('Relevant product extraction failed:', error);
      return [];
    }
  }



  /**
   * Clean up response text for WhatsApp formatting
   */
  private cleanResponse(response: string): string {

    return response
      // Remove technical markers
      .replace(/\[CHUNK_ID:.*?\]/gi, '')
      .replace(/\[PRODUCTS?:.*?\]/gi, '')
      .replace(/\[From:.*?\]/gi, '')
      .replace(/\[USED_CHUNK:.*?\]/gi, '')
      // Clean up AI-references
      .replace(/based on (our )?product documentation/gi, '')
      .replace(/according to (our )?(uploaded )?documents/gi, '')
      .replace(/as an AI/gi, '')
      .replace(/I'm an AI/gi, '')
      // Clean up whitespace
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /**
   * Get customer query analytics (for future use)
   */
  async getCustomerAnalytics(): Promise<{
    totalQueries: number;
    intentDistribution: Record<string, number>;
    topProducts: Array<{ name: string; queries: number }>;
  }> {
    return {
      totalQueries: 0,
      intentDistribution: {},
      topProducts: []
    };
  }
}

export const customerService = new CustomerService();