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
      "title": "Exact Product Name",
      "description": "Brief compelling description",
      "price": {
          "amount": "₹XXX (if available in context)", in numeric format,
          "currency": "INR"
        },
      "relevanceReason": "Why this is perfect for them"
      "handle":"the-collection-snowboard-oxygen" (for now keep it this only)
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
      // 0. Expand query first to understand context (especially for short responses like "yes")
      const expandedQuery = await this.expandQueryWithContext(query, conversationHistory);
      const shouldUseExpandedQuery = expandedQuery !== query && expandedQuery.length > query.length;
      const effectiveQuery = shouldUseExpandedQuery ? expandedQuery : query;
      
      if (shouldUseExpandedQuery) {
        console.log(`💡 Query expanded: "${query}" → "${expandedQuery}"`);
      }

      // 1. Extract relevant products using LLM - considers BOTH conversation AND current query
      // Use expanded query for better product extraction
      const relevantProducts = await this.extractRelevantProducts(effectiveQuery, conversationHistory);
      console.log(`🔒 Relevant products for query: ${relevantProducts.length > 0 ? relevantProducts.join(', ') : 'none'}`);

      // 2. Get context chunks - use PRODUCT LOCKING if products found, else fall back to semantic search
      let contextChunks: Array<{ id: string; content: string; filename: string; metadata?: any }> = [];

      if (relevantProducts.length > 0) {
        // PRODUCT LOCKING: Fetch ALL chunks for the specific products IN PARALLEL
        // Check if this is a comparison query (multiple products)
        const isComparisonQuery = relevantProducts.length > 1 || effectiveQuery.toLowerCase().includes('compare');
        const maxProducts = isComparisonQuery ? 5 : 3; // Allow more products for comparison
        console.log(`🎯 Using product locking for: ${relevantProducts.join(', ')} ${isComparisonQuery ? '(comparison)' : ''}`);
        const productsToFetch = relevantProducts.slice(0, maxProducts);

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

      // If no chunks from product locking, transform query for optimal Qdrant search
      if (contextChunks.length === 0) {
        // Transform query to be search-optimized for product discovery
        const searchQuery = await this.transformQueryForSearch(effectiveQuery, conversationHistory);
        console.log(`🔍 Falling back to semantic search for: "${effectiveQuery}" → "${searchQuery}"`);
        const ragResult = await ragService.queryDocuments(searchQuery, {
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

      // 6. Build messages array with conversation history for full context awareness
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];

      // Add conversation history as messages (excluding the current query)
      if (recentHistory.length > 0) {
        recentHistory.forEach(msg => {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          });
        });
      }

      // Add the current query as the final user message
      messages.push({
        role: 'user',
        content: `Process this customer query and return the JSON response: "${query}"`
      });

      // 7. Single LLM call for everything (performance optimization)
      console.log('🤖 Generating intelligent response...');
      const llmResponse = await inferenceProvider.chatCompletion(
        systemPrompt,
        `Process this customer query and return the JSON response: "${query}"`,
        { 
          temperature: 0.3, 
          maxTokens: 1500,
          messages: messages
        }
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
   * Transform query into search-optimized format for Qdrant semantic search
   * Converts recommendation requests into product discovery queries
   * Example: "recommend outdoor shoes" → "Best outdoor slippers with comfort and support"
   */
  private async transformQueryForSearch(
    query: string,
    conversationHistory: ConversationMessage[]
  ): Promise<string> {
    // If query is already detailed and search-friendly, return as-is
    const queryWords = query.trim().split(/\s+/).length;
    if (queryWords > 6 && (query.toLowerCase().includes('best') || query.toLowerCase().includes('top') || query.toLowerCase().includes('quality'))) {
      return query;
    }

    try {
      const recentHistory = conversationHistory.slice(-4);
      
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: `You are a search query optimizer. Transform user queries into optimal product search queries for a vector database.

YOUR TASK:
Transform the user's query into a search-optimized query that will find the best matching products.

TRANSFORMATION RULES:
1. Add search-friendly terms: "best", "top", "quality", "comfortable", "durable" when appropriate
2. Convert recommendation requests into product discovery queries:
   - "recommend outdoor shoes" → "Best outdoor slippers with comfort and support"
   - "show me comfortable slippers" → "Best comfortable slippers with arch support"
   - "find outdoor options" → "Top outdoor slippers with comfort features"
3. Include key features mentioned in conversation (comfort, support, outdoor use, etc.)
4. Use product category terms: "slippers", "shoes", "insoles", etc.
5. Keep it concise (6-12 words max) but descriptive
6. Focus on product attributes that matter for search: comfort, support, durability, outdoor use, etc.

EXAMPLES:
- Input: "recommend outdoor shoes" → Output: "Best outdoor slippers with comfort and support"
- Input: "yes" (context: assistant asked about outdoor shoes) → Output: "Best outdoor slippers with comfort features"
- Input: "comfortable slippers" → Output: "Best comfortable slippers with arch support"
- Input: "show me options" → Output: "Top quality slippers with comfort and support"

OUTPUT FORMAT: Just the optimized search query, nothing else.`
        }
      ];

      // Add conversation history for context
      if (recentHistory.length > 0) {
        recentHistory.forEach(msg => {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          });
        });
      }

      // Add current query
      messages.push({
        role: 'user',
        content: `Transform this query into a search-optimized product discovery query: "${query}"`
      });

      const response = await inferenceProvider.chatCompletion(
        messages[0].content,
        messages[messages.length - 1].content,
        { 
          temperature: 0.3, 
          maxTokens: 100,
          messages: messages
        }
      );

      const transformed = response.trim();
      
      // Validate transformed query
      if (transformed.length > 10 && transformed.length < 150) {
        // Clean up any extra text that might have been added
        const cleaned = transformed
          .replace(/^(optimized query|search query|query):\s*/i, '')
          .replace(/^["']|["']$/g, '')
          .trim();
        return cleaned;
      }

      // Fallback: enhance query manually if LLM transformation fails
      return this.enhanceQueryManually(query);
    } catch (error) {
      console.warn('Query transformation failed:', error);
      return this.enhanceQueryManually(query);
    }
  }

  /**
   * Manual query enhancement as fallback
   */
  private enhanceQueryManually(query: string): string {
    const queryLower = query.toLowerCase();
    
    // Add "best" if not present and query is about recommendations
    if ((queryLower.includes('recommend') || queryLower.includes('show') || queryLower.includes('find')) && !queryLower.includes('best')) {
      return `Best ${query.replace(/^(recommend|show me|find|i want|i need)\s*/i, '').trim()}`;
    }
    
    // Add "best" for short queries
    if (query.split(/\s+/).length <= 4 && !queryLower.includes('best') && !queryLower.includes('top')) {
      return `Best ${query}`;
    }
    
    // Enhance with common product attributes if missing
    if (!queryLower.includes('comfort') && !queryLower.includes('support') && !queryLower.includes('quality')) {
      if (queryLower.includes('slipper') || queryLower.includes('shoe')) {
        return `${query} with comfort and support`;
      }
    }
    
    return query;
  }

  /**
   * Expand query with conversation context to understand short responses like "yes", "no", etc.
   * This helps the system understand what the user actually wants when they give brief responses
   */
  private async expandQueryWithContext(
    currentQuery: string,
    conversationHistory: ConversationMessage[]
  ): Promise<string> {
    // If query is already detailed (more than 3 words), return as-is
    if (currentQuery.trim().split(/\s+/).length > 3) {
      return currentQuery;
    }

    // If no conversation history, return as-is
    if (conversationHistory.length === 0) {
      return currentQuery;
    }

    // Check if query is a short response that needs expansion
    const shortResponses = ['yes', 'no', 'sure', 'okay', 'ok', 'yep', 'nope', 'yeah', 'nah', 'maybe', 'thanks', 'thank you'];
    const queryLower = currentQuery.toLowerCase().trim();
    
    if (!shortResponses.some(response => queryLower === response || queryLower.startsWith(response))) {
      return currentQuery;
    }

    try {
      // Get recent conversation (last 4 messages)
      const recentHistory = conversationHistory.slice(-4);
      
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: `You are a query expansion assistant. Your task is to understand what the user actually wants when they give a short response like "yes", "no", etc.

CRITICAL RULES:
1. Look at the LAST assistant message to understand what question the user is responding to
2. If assistant asked "Would you like me to recommend X?" and user says "yes" → expand to "recommend X" or "show me X"
3. If assistant asked "Would you like to compare the features of these options?" or "Would you like to compare X and Y?" and user says "yes" → expand to "compare features of [products mentioned in assistant's message]"
4. If assistant asked about comparing specific products (e.g., "Would you like to compare the features of Product A and Product B?") and user says "yes" → expand to "compare Product A and Product B features"
5. If assistant asked about a specific product feature and user says "yes" → expand to include that feature in the query
6. If assistant asked "Can I help you with Y?" and user says "yes" → expand to "help with Y" or "show me Y"
7. If user says "no", understand what they're rejecting and expand accordingly
8. Preserve the user's intent - if they want outdoor shoes, expand to include "outdoor" in the query
9. For comparison requests, extract product names from the assistant's message and include them in the expanded query
10. Return ONLY the expanded query, nothing else - no explanations, no additional text

OUTPUT FORMAT: Just the expanded query text, nothing else.`
        }
      ];

      // Add conversation history
      recentHistory.forEach(msg => {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        });
      });

      // Add current query
      messages.push({
        role: 'user',
        content: `USER'S CURRENT QUERY: "${currentQuery}"\n\nExpand this query based on the conversation context above. Return only the expanded query.`
      });

      const response = await inferenceProvider.chatCompletion(
        messages[0].content,
        messages[messages.length - 1].content,
        { 
          temperature: 0.2, 
          maxTokens: 100,
          messages: messages
        }
      );

      const expanded = response.trim();
      
      // Validate expanded query
      if (expanded.length > 5 && expanded.length < 200) {
        return expanded;
      }

      return currentQuery;
    } catch (error) {
      console.warn('Query expansion failed:', error);
      return currentQuery;
    }
  }

  /**
   * Extract RELEVANT product names based on BOTH the current query AND conversation history
   * This is smarter than just extracting all products - it determines which product(s)
   * the user is actually asking about in their current query, including understanding
   * context from yes/no responses and follow-up questions
   */
  private async extractRelevantProducts(
    currentQuery: string,
    conversationHistory: ConversationMessage[]
  ): Promise<string[]> {
    if (conversationHistory.length === 0) {
      return [];
    }

    try {
      // Format recent conversation for LLM (use more history for better context)
      const recentHistory = conversationHistory.slice(-6);
      
      // Build messages array with conversation history for better context understanding
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: `You are a smart product query analyzer that understands conversation context deeply.

YOUR TASK:
Determine which specific EXISTING product(s) from the conversation the user is asking about in their CURRENT query.

CRITICAL CONTEXT UNDERSTANDING:
1. If the current query is a short response like "yes", "no", "sure", "okay", "that works", etc.:
   - Look at the LAST assistant message to understand what the user is responding to
   - If assistant asked "Would you like to compare the features of these options?" or "Would you like to compare X and Y?" and user says "yes" → extract ALL product names mentioned in the assistant's message (look for product names in **bold** or mentioned explicitly)
   - If assistant asked "Would you like me to recommend X?" or "Should I recommend X?" and user says "yes" → return NONE (user wants NEW recommendations, not existing products)
   - If assistant asked "Would you like to see X?" or "Should I show you X?" and user says "yes" → return NONE (user wants to see new products)
   - If assistant asked about a SPECIFIC EXISTING PRODUCT feature (e.g., "Can you wear Frido Cloud Comfort Arch Support Slippers outdoors?") and user says "yes" → return that specific product name
   - If assistant asked a question about an existing product and user says "yes" → return that product name

2. If the user mentions a specific product name in their current query → return ONLY that product

3. If the user asks about "both" or "all" or compares products → return all relevant products from recent conversation (only actual product names)

4. If the user asks a follow-up (e.g., "what colors?", "how much?", "can I wear it outdoors?") without specifying → return the products being discussed in the conversation

5. If the user asks about a new topic/product not in conversation → return NONE

6. For comparison requests: Extract product names from the assistant's message. Look for:
   - Products mentioned in **bold** (markdown format)
   - Products listed explicitly (e.g., "Product A or Product B")
   - Products mentioned in the context of comparison

KEY RULES:
- Return ONLY EXACT product names that were mentioned in the conversation (e.g., "Frido Cloud Comfort Arch Support Slippers")
- DO NOT return descriptive phrases like "outdoor shoes", "comfortable slippers", "similar comfort features" - these are NOT product names
- DO NOT return product types or categories - only actual product names
- If assistant is asking to RECOMMEND or SHOW new products and user says "yes" → return NONE (let semantic search handle it)
- For comparison: Extract ALL products mentioned in the assistant's comparison question
- Maximum 5 products (for comparison scenarios)
- If can't determine or user wants recommendations → return NONE

OUTPUT FORMAT (just product names, one per line, or NONE):`
        }
      ];

      // Add conversation history as messages
      recentHistory.forEach(msg => {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        });
      });

      // Add the current query
      messages.push({
        role: 'user',
        content: `CURRENT USER QUERY: "${currentQuery}"\n\nDetermine relevant products based on this query and the conversation context above.`
      });

      const response = await inferenceProvider.chatCompletion(
        messages[0].content,
        messages[messages.length - 1].content,
        { 
          temperature: 0, 
          maxTokens: 200,
          messages: messages
        }
      );

      const result = response.trim();

      // Check if no products found
      if (result.toUpperCase() === 'NONE' || result.length < 5) {
        return [];
      }

      // Check if this is a comparison query
      const isComparison = currentQuery.toLowerCase().includes('compare') || 
                           conversationHistory[conversationHistory.length - 1]?.content?.toLowerCase().includes('compare') ||
                           result.toLowerCase().includes('compare');
      const maxProducts = isComparison ? 5 : 3;

      // Parse product names (one per line)
      const products = result
        .split('\n')
        .map(line => line.trim().replace(/^[\d\.\-\*]+\s*/, '')) // Remove numbering/bullets
        .filter(line => {
          const trimmed = line.trim();
          // Filter out invalid entries
          if (trimmed.length < 5) return false;
          if (trimmed.toUpperCase().includes('NONE')) return false;
          // Filter out descriptive phrases (not product names)
          // Product names typically have proper capitalization and specific structure
          // Descriptive phrases like "outdoor shoes" or "similar comfort features" should be filtered
          const lower = trimmed.toLowerCase();
          const commonDescriptivePhrases = [
            'outdoor shoes', 'outdoor', 'shoes', 'slippers', 'comfort features',
            'similar', 'features', 'comfortable', 'recommendations', 'options',
            'products', 'alternatives', 'suggestions'
          ];
          // If it's just a descriptive phrase (2-3 words, common terms), likely not a product name
          if (commonDescriptivePhrases.some(phrase => lower.includes(phrase) && trimmed.split(/\s+/).length <= 4)) {
            // But allow if it's part of a longer product name
            if (trimmed.split(/\s+/).length <= 4 && !trimmed.match(/^[A-Z]/)) {
              return false; // Likely a descriptive phrase, not a product name
            }
          }
          return true;
        })
        .slice(0, maxProducts);

      // Additional validation: Check if extracted products look like actual product names
      // Product names should have proper structure (not just generic descriptions)
      const validatedProducts = products.filter(product => {
        // Product names should be at least 10 characters and have some structure
        if (product.length < 10) return false;
        // Should not be just generic descriptions
        const genericPatterns = /^(outdoor|comfortable|similar|features|shoes|slippers|recommend|show|find)/i;
        if (genericPatterns.test(product) && product.split(/\s+/).length <= 4) {
          return false;
        }
        return true;
      });

      console.log(`🔍 Extracted products: ${products.join(', ') || 'none'} | Validated: ${validatedProducts.join(', ') || 'none'}`);
      
      return validatedProducts;

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