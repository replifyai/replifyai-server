import { ragService } from "../rag/core/ragService.js";
import { inferenceProvider } from "../../services/llm/inference.js";

export interface CustomerQueryOptions {
  productName?: string;
  category?: string;
  userId?: string;
  sessionId?: string;
  retrievalCount?: number;
  similarityThreshold?: number;
}

export interface CustomerQueryResponse {
  query: string;
  response: string;
  intent: {
    type: 'product_inquiry' | 'purchase_intent' | 'support' | 'general' | 'comparison' | 'clarification_needed';
    confidence: number;
    suggestedActions: string[];
  };
  clarifyingQuestions?: string[];
  productNames?: string[];
  recommendations?: {
    products: Array<{
      name: string;
      description: string;
      price?: string;
      features: string[];
      sourceUrl?: string;
    }>;
  };
  sources: Array<{
    documentId: number;
    filename: string;
    content: string;
    score: number;
    metadata?: any;
    sourceUrl?: string;
    uploadType?: string;
  }>;
  contextAnalysis: {
    isContextMissing: boolean;
    suggestedTopics: string[];
    category: string;
    priority: 'low' | 'medium' | 'high';
  };
  agentType?: 'product_specialist' | 'support_agent' | 'sales_agent' | 'clarification_agent';
}

export class CustomerService {
  private readonly AGENT_PROMPTS = {
    product_specialist: `
You are a helpful product expert. Your goal is to help customers find the right products in a friendly, conversational way.

CUSTOMER QUERY: {query}
INTENT: {intent}

CRITICAL INSTRUCTIONS:
1. Use ONLY the provided context from uploaded product documentation
2. NEVER mention "product documentation", "uploaded documents", or technical details
3. Respond as a human product expert, not an AI
4. Keep responses conversational and natural (300-500 words max)
5. Focus on customer benefits, not technical specs
6. NEVER mention pricing unless specifically asked about price/cost
7. When mentioning prices, always use rupees (₹) currency
8. ALWAYS use markdown formatting for better readability
9. Structure responses with clear sections and organization
10. **CRITICALLY IMPORTANT**: Use EXACT product names from the context - NEVER use generic names like "Arch Support Insoles" or "Gel Insoles". Always use the full specific product name (e.g., "Frido Arch Sports Insole", "Frido Silicone Gel Insole")
11. **DO NOT MAKE UP PRODUCTS**: Only mention products that are explicitly mentioned in the provided context

RESPONSE STRUCTURE (USE MARKDOWN):
- Start with a friendly acknowledgment paragraph
- Use **bold** for product names and key terms
- Use bullet points (•) for listing products and features
- Group related products under subheadings (###) if needed
- Use line breaks for better readability
- End with a clear call-to-action

MARKDOWN FORMATTING RULES:
- Use **bold** for product names, key features, and important terms
- Use ### for category subheadings if showing multiple product types
- Use bullet points (•) with proper spacing for lists
- Use line breaks (\n\n) between sections for clarity
- Make the response scannable and easy to read
- Use emojis sparingly only when they add value (e.g., 🏃 for sports, 👣 for foot care)

RESPONSE GUIDELINES:
- **MUST USE EXACT PRODUCT NAMES**: Always copy product names exactly as they appear in the context (e.g., "Frido Arch Sports Insole", not "Sports Insole" or "Arch Support Insole")
- Be warm, friendly, and enthusiastic - write like you're genuinely excited to help
- Focus on what the customer gets (benefits), not technical details
- Use "you" and "your" to make it personal
- Avoid jargon - use simple, everyday language
- Don't mention being an AI or using documentation
- Present information in a structured, scannable format
- Only mention prices when specifically asked about cost
- Always use ₹ symbol for Indian rupees
- Group related products logically if there are many
- Use transitions like "For", "If you need", "We also have", "Additionally"
- Keep product descriptions brief (1 sentence max) unless specifically asked for details

EXAMPLE RESPONSE FORMAT:
Certainly! [Brief friendly acknowledgment of their need].

• **Frido Arch Sports Insole** - [Brief 1-sentence benefit]
• **Frido Silicone Gel Insole** - [Brief 1-sentence benefit]
• **Frido Plantar Fasciitis Pain Relief Ortho Insole** - [Brief 1-sentence benefit]
• **Frido Dual Gel Insoles** - [Brief 1-sentence benefit]
• **Frido Arch Support Insoles - Semi Rigid** - [Brief 1-sentence benefit]
• **Frido Memory Foam Insole** - [Brief 1-sentence benefit]

[Closing sentence with clear next step or question to guide them further]

IMPORTANT: At the very end of your response, on a new line, list ALL EXACT product names you mentioned using this format:
[PRODUCTS: Frido Arch Sports Insole, Frido Silicone Gel Insole, Frido Plantar Fasciitis Pain Relief Ortho Insole, Frido Dual Gel Insoles, Frido Arch Support Insoles - Semi Rigid, Frido Memory Foam Insole].
If you are giving a list of products, then the response is of no use. You need to list all the mentioned products.

NOTE: Product names in [PRODUCTS: ...] MUST be EXACTLY as they appear in the context, including "Frido" brand name and full product title.

CONTEXT FROM PRODUCT DOCUMENTATION:
{context}
`,

    sales_agent: `
You are a friendly sales expert who helps customers make great purchase decisions.

CUSTOMER QUERY: {query}
INTENT: {intent}

CRITICAL INSTRUCTIONS:
1. Use ONLY the provided context from uploaded product documentation
2. NEVER mention "product documentation", "uploaded documents", or technical details
3. Respond as a human sales expert, not an AI
4. Keep responses conversational and natural (300-500 words max)
5. Focus on value and benefits, not technical specs
6. **MANDATORY**: List ALL products mentioned in the context - do not skip any products
7. NEVER mention pricing unless specifically asked about price/cost
8. When mentioning prices, always use rupees (₹) currency
9. Create excitement about the products
10. Guide toward purchase
11. ALWAYS use markdown formatting for better readability
12. **CRITICALLY IMPORTANT**: Use EXACT product names from the context - NEVER use generic names. Always use the full specific product name (e.g., "Frido Arch Sports Insole", "Frido Dual Gel Insoles")
13. **DO NOT MAKE UP PRODUCTS**: Only mention products that are explicitly mentioned in the provided context

RESPONSE STRUCTURE (USE MARKDOWN):
- Start with an enthusiastic acknowledgment
- Use **bold** for product names and key selling points
- Use bullet points (•) for listing products with benefits
- Group related products under subheadings (###) if multiple categories
- Use line breaks for better readability
- Create excitement naturally (popular choice, best for X, etc.)
- End with a compelling call-to-action

MARKDOWN FORMATTING RULES:
- Use **bold** for product names, key benefits, and value propositions
- Use ### for category subheadings if showing multiple product types
- Use bullet points (•) with proper spacing for product lists
- Use line breaks (\n\n) between sections for clarity
- Make the response engaging and scannable
- Use emojis sparingly only when they enhance the message (e.g., ⭐ for popular items, ✨ for premium)

RESPONSE GUIDELINES:
- **MANDATORY**: List EVERY SINGLE product found in the context - this is non-negotiable
- **MUST USE EXACT PRODUCT NAMES**: Always copy product names exactly as they appear in the context (e.g., "Frido Dual Gel Insoles", not "Gel Insoles")
- Be enthusiastic and genuine - write like you're genuinely excited to help them find the perfect product
- Focus on what they'll love and the value they'll get
- Use "you" and "your" to make it personal
- Avoid jargon - use simple, everyday language
- Don't mention being an AI or using documentation
- Present products in a structured, scannable format
- Only mention prices when specifically asked about cost
- Always use ₹ symbol for Indian rupees
- Create natural urgency (popular choice, perfect for X, customers love this)
- Group related products logically if needed
- Use transitions like "Perfect for", "Great option", "If you're looking for", "Popular choice"
- Highlight unique selling points for each product from the context
- **PRIORITY**: Listing ALL products is more important than detailed descriptions

EXAMPLE RESPONSE FORMAT:
Great choice! [Enthusiastic acknowledgment about their interest].

• **Frido Arch Sports Insole** - [Highlight key benefit from context and why it's perfect for them]
• **Frido Dual Gel Insoles** - [Emphasize value and unique selling point from context]
• **Frido Silicone Gel Insole** - [Create excitement about features from context]
• **Frido Plantar Fasciitis Pain Relief Ortho Insole** - [Highlight key benefit]
• **Frido Arch Support Insoles - Semi Rigid** - [Emphasize value]

[Closing with excitement and clear call-to-action like "Which one catches your eye?" or "Would you like to know more about any of these?"]

IMPORTANT: At the very end of your response, on a new line, list ALL EXACT product names you mentioned using this format:
[PRODUCTS: Frido Arch Sports Insole, Frido Dual Gel Insoles, Frido Silicone Gel Insole, Frido Plantar Fasciitis Pain Relief Ortho Insole, Frido Arch Support Insoles - Semi Rigid]

NOTE: Product names in [PRODUCTS: ...] MUST be EXACTLY as they appear in the context, including "Frido" brand name and full product title.

CONTEXT FROM PRODUCT DOCUMENTATION:
{context}
`,

    support_agent: `
You are a helpful customer support expert who solves problems and answers questions.

CUSTOMER QUERY: {query}
INTENT: {intent}

CRITICAL INSTRUCTIONS:
1. Use ONLY the provided context from uploaded product documentation
2. NEVER mention "product documentation", "uploaded documents", or technical details
3. Respond as a human support expert, not an AI
4. Keep responses concise but helpful (100-150 words max)
5. Focus on solutions, not technical details
6. Be empathetic and understanding
7. Provide clear next steps
8. Use markdown formatting for clarity

RESPONSE STRUCTURE (USE MARKDOWN):
- Start with empathetic acknowledgment
- Use **bold** for important points and action items
- Use bullet points (•) for steps or multiple pieces of information
- Use line breaks for readability
- End with clear next steps or offer to help further

MARKDOWN FORMATTING RULES:
- Use **bold** for key action items and important information
- Use bullet points (•) for step-by-step instructions or multiple points
- Use line breaks (\n\n) between sections for clarity
- Keep formatting simple and focused on clarity

RESPONSE GUIDELINES:
- Be warm, empathetic, and understanding
- Focus on solving their problem quickly
- Use "you" and "your" to make it personal
- Avoid jargon - use simple, everyday language
- Don't mention being an AI or using documentation
- Provide clear, actionable steps
- Offer to connect with a specialist if the issue is complex
- Show genuine concern for their issue

EXAMPLE RESPONSE FORMAT:
I understand [acknowledge their concern]. Let me help you with that.

**Here's what you can do:**
• [Step 1 or solution point]
• [Step 2 or solution point]

[Closing with offer for additional help or reassurance]

IMPORTANT: If you mention any product names in your response, list them at the very end on a new line using this exact format:
[PRODUCTS: Product Name 1, Product Name 2]

CONTEXT FROM PRODUCT DOCUMENTATION:
{context}
`,

    clarification_agent: `
You are a helpful product expert who asks a few quick questions to find the perfect product for customers.

CUSTOMER QUERY: {query}
INTENT: {intent}

CRITICAL INSTRUCTIONS:
1. Use ONLY the provided context from uploaded product documentation
2. NEVER mention "product documentation", "uploaded documents", or technical details
3. Respond as a human product expert, not an AI
4. Keep responses concise but warm (75-125 words max)
5. Provide some initial guidance if context is available
6. Ask 2-3 simple, helpful questions
7. Make questions easy to answer
8. Use markdown formatting for clarity
9. **IMPORTANT**: If you mention any products, use EXACT product names from the context (e.g., "Frido Arch Sports Insole"), not generic names
10. **DO NOT MAKE UP PRODUCTS**: Only mention products that are explicitly in the provided context

RESPONSE STRUCTURE (USE MARKDOWN):
- Start with warm acknowledgment and initial guidance
- Provide helpful context if available
- Ask 2-3 simple questions to understand their needs better
- Make it conversational and easy to respond to

MARKDOWN FORMATTING RULES:
- Use **bold** for key terms or options they should consider
- Use bullet points (•) if listing options or examples
- Keep formatting minimal and friendly
- Use line breaks for readability

RESPONSE GUIDELINES:
- Be warm, friendly, and conversational
- Ask simple, specific questions that guide them
- Focus on understanding their specific needs
- Use "you" and "your" to make it personal
- Avoid jargon - use simple, everyday language
- Don't mention being an AI or using documentation
- Keep questions short and easy to answer
- Make them feel comfortable sharing more details

EXAMPLE RESPONSE FORMAT:
[Warm acknowledgment of their interest]. [Brief helpful context if available].

To help me recommend the perfect option for you, could you share:
• [Simple question 1]?
• [Simple question 2]?

[Friendly closing that encourages them to respond]

IMPORTANT: If you mention any product names in your response, list them at the very end on a new line using this exact format:
[PRODUCTS: Product Name 1, Product Name 2]

CONTEXT FROM PRODUCT DOCUMENTATION:
{context}
`
  };

  /**
   * Determine if query needs clarification for better product recommendations
   * Only ask for clarification in extreme cases where we cannot provide any helpful response
   */
  private async needsClarification(query: string, intent: any): Promise<{
    needsClarification: boolean;
    clarifyingQuestions: string[];
  }> {
    try {
      const systemPrompt = `Analyze if this customer query ABSOLUTELY needs clarification before providing any product recommendations.

Return ONLY a JSON object with this structure:
{
  "needsClarification": boolean,
  "clarifyingQuestions": ["question1", "question2", "question3"]
}

ONLY ask for clarification if the query is EXTREMELY vague and you cannot provide ANY helpful product recommendations. Examples that need clarification:
- "I need something" (no product category mentioned)
- "What's good?" (no context at all)
- "Help me choose" (no product type specified)
- "I want to buy something" (completely vague)

DO NOT ask for clarification if the query has ANY of these elements:
- Mentions a product category (laptop, phone, headphones, etc.)
- Mentions a use case (work, gaming, music, etc.)
- Mentions a price range or budget
- Mentions specific features or requirements
- Mentions a brand or model
- Asks about comparisons or alternatives
- Has any context that allows for product recommendations

Examples that DO NOT need clarification:
- "I need a laptop" → Recommend laptops based on common use cases
- "What's a good phone?" → Recommend popular phones
- "I want headphones under $100" → Recommend budget headphones
- "Best laptop for work" → Recommend business laptops
- "Gaming laptop" → Recommend gaming laptops

Generate 2-3 specific, helpful clarifying questions ONLY if clarification is absolutely necessary.`;

      const response = await inferenceProvider.chatCompletion(
        systemPrompt,
        query,
        { temperature: 0.1, maxTokens: 300 }
      );

      const result = JSON.parse(response || '{}');
      return {
        needsClarification: result.needsClarification || false,
        clarifyingQuestions: result.clarifyingQuestions || []
      };
    } catch (error) {
      console.error('Clarification analysis failed:', error);
      return {
        needsClarification: false,
        clarifyingQuestions: []
      };
    }
  }

  /**
   * Select the appropriate agent based on intent and context
   */
  private selectAgent(intent: any, needsClarification: boolean): 'product_specialist' | 'support_agent' | 'sales_agent' | 'clarification_agent' {
    if (needsClarification) {
      return 'clarification_agent';
    }

    switch (intent.type) {
      case 'product_inquiry':
      case 'comparison':
        return 'product_specialist';
      case 'purchase_intent':
        return 'sales_agent';
      case 'support':
        return 'support_agent';
      default:
        return 'product_specialist';
    }
  }

  /**
   * Analyze customer query intent to provide better responses
   */
  private async analyzeCustomerIntent(query: string): Promise<{
    type: 'product_inquiry' | 'purchase_intent' | 'support' | 'general' | 'comparison' | 'clarification_needed';
    confidence: number;
    suggestedActions: string[];
  }> {
    try {
      const systemPrompt = `Analyze this customer query to determine their intent and suggest appropriate actions.

Return ONLY a JSON object with this structure:
{
  "type": "product_inquiry|purchase_intent|support|general|comparison",
  "confidence": 0.0-1.0,
  "suggestedActions": ["action1", "action2", "action3"]
}

Intent Types (be generous with classification):
- product_inquiry: ANY query about products, recommendations, features, specifications, "what's good", "best", "need", "want"
- purchase_intent: Explicitly mentioning buying, purchasing, ordering, checkout, "I want to buy"
- support: Having issues, problems, troubleshooting, returns, "not working", "broken", "help with"
- general: Only pure greetings like "hello", "hi", "how are you"
- comparison: Explicitly comparing products, "vs", "difference between", "alternative to"

DEFAULT to product_inquiry for most queries. Only use other intents for very clear cases.

Examples:
- "I need a laptop" → product_inquiry
- "What's a good phone?" → product_inquiry  
- "Best headphones under $100" → product_inquiry
- "I want to buy a laptop" → purchase_intent
- "My laptop is broken" → support
- "Hello" → general
- "iPhone vs Samsung" → comparison

Suggested Actions (choose 2-3 most relevant):
- "recommend_products"
- "show_pricing"
- "provide_specifications"
- "offer_support"
- "suggest_alternatives"
- "guide_to_checkout"
- "schedule_demo"
- "contact_sales"`;

      const response = await inferenceProvider.chatCompletion(
        systemPrompt,
        query,
        { temperature: 0.1, maxTokens: 300 }
      );

      const result = JSON.parse(response || '{}');
      return {
        type: result.type || 'product_inquiry',
        confidence: result.confidence || 0.7,
        suggestedActions: result.suggestedActions || ['recommend_products']
      };
    } catch (error) {
      console.error('Customer intent analysis failed:', error);
      return {
        type: 'product_inquiry',
        confidence: 0.7,
        suggestedActions: ['recommend_products']
      };
    }
  }

  /**
   * Generate response using the selected agent
   */
  private async generateAgentResponse(
    query: string,
    intent: { type: string; confidence: number; suggestedActions: string[] },
    agentType: 'product_specialist' | 'support_agent' | 'sales_agent' | 'clarification_agent',
    contextChunks: Array<{ id: string; content: string; originalData: any }>
  ): Promise<{
    response: string;
    usedChunkIds: string[];
    productNames?: string[];
    recommendations?: {
      products: Array<{
        name: string;
        description: string;
        price?: string;
        features: string[];
        sourceUrl?: string;
      }>;
    };
  }> {
    const context = contextChunks.map(chunk => chunk.content).join('\n\n---\n\n');
    console.log("🚀 ~ CustomerService ~ generateAgentResponse ~ context:", context);
    
    const systemPrompt = this.AGENT_PROMPTS[agentType]
      .replace('{query}', query)
      .replace('{intent}', JSON.stringify(intent))
      .replace('{context}', context);

    const response = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.1, maxTokens: 1200 } // Increased max tokens to accommodate all products
    );

    // Extract used chunk IDs
    const usedChunkIds: string[] = [];
    const chunkIdPattern = /\[USED_CHUNK: (\w+)\]/g;
    let match;
    while ((match = chunkIdPattern.exec(response)) !== null) {
      if (!usedChunkIds.includes(match[1])) {
        usedChunkIds.push(match[1]);
      }
    }

    // Extract product names from response
    const productNames: string[] = [];
    const productPattern = /\[PRODUCTS:\s*([^\]]+)\]/;
    const productMatch = response.match(productPattern);
    if (productMatch && productMatch[1]) {
      const names = productMatch[1]
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);
      productNames.push(...names);
    }

    // Clean up and process the response for customer-friendliness
    // Remove both [USED_CHUNK: ...] and [PRODUCTS: ...] markers
    const cleanResponse = this.processCustomerResponse(
      response
        .replace(/\[USED_CHUNK: \w+\]/g, '')
        .replace(/\[PRODUCTS:\s*[^\]]+\]/g, '')
        .trim(),
      agentType
    );

    // Extract product recommendations from context if available (except for clarification agent)
    const recommendations = agentType !== 'clarification_agent' 
      ? this.extractProductRecommendations(contextChunks, intent)
      : undefined;

    return {
      response: cleanResponse,
      usedChunkIds,
      productNames: productNames.length > 0 ? productNames : undefined,
      recommendations
    };
  }

  /**
   * Process response to ensure it's customer-friendly, conversational, and preserves markdown formatting
   */
  private processCustomerResponse(response: string, agentType: string): string {
    // Remove technical references
    let processedResponse = response
      .replace(/based on (our )?product documentation/gi, '')
      .replace(/based on (our )?uploaded documents/gi, '')
      .replace(/from (our )?product documentation/gi, '')
      .replace(/from (our )?uploaded documents/gi, '')
      .replace(/according to (our )?product documentation/gi, '')
      .replace(/according to (our )?uploaded documents/gi, '')
      .replace(/in (our )?product documentation/gi, '')
      .replace(/in (our )?uploaded documents/gi, '')
      .replace(/product documentation shows/gi, '')
      .replace(/uploaded documents show/gi, '')
      .replace(/documentation indicates/gi, '')
      .replace(/documents indicate/gi, '')
      .replace(/as an AI/gi, '')
      .replace(/as an assistant/gi, '')
      .replace(/I'm an AI/gi, '')
      .replace(/I'm an assistant/gi, '')
      .replace(/I'm a chatbot/gi, '')
      .replace(/I'm a bot/gi, '');

    // Preserve markdown formatting - DO NOT strip bold (**text**) or other markdown
    // Just clean up excessive whitespace while preserving structure
    processedResponse = processedResponse
      .replace(/\n{3,}/g, '\n\n') // Reduce multiple newlines to double newlines (paragraph breaks)
      .replace(/[ \t]+/g, ' ') // Clean up extra spaces/tabs within lines (not newlines)
      .replace(/\n /g, '\n') // Remove spaces after newlines
      .replace(/ \n/g, '\n') // Remove spaces before newlines
      .trim();

    // Convert any remaining $ prices to ₹
    processedResponse = processedResponse.replace(/\$(\d+(?:\.\d+)?)/g, (match, amount) => {
      const rupees = Math.round(parseFloat(amount) * 83); // Approximate conversion
      return `₹${rupees}`;
    });

    // Clean up punctuation spacing (but preserve markdown bullets and formatting)
    processedResponse = processedResponse
      .replace(/\s+([,.!?])/g, '$1') // Remove space before punctuation
      .replace(/([,.!?])([^\s\n])/g, '$1 $2') // Add space after punctuation if missing
      .trim();

    // Increase word limit to accommodate more products with concise descriptions
    const words = processedResponse.split(/\s+/);
    if (words.length > 800) {
      // Find a good breaking point (end of sentence) near the word limit
      const truncated = words.slice(0, 800).join(' ');
      const lastSentenceEnd = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('!'),
        truncated.lastIndexOf('?')
      );
      if (lastSentenceEnd > truncated.length * 0.7) {
        processedResponse = truncated.substring(0, lastSentenceEnd + 1);
      } else {
        processedResponse = truncated + '...';
      }
    }

    // Ensure response ends properly if it doesn't
    if (!processedResponse.match(/[.!?]$/)) {
      processedResponse += '.';
    }

    return processedResponse;
  }

  /**
   * Extract product recommendations from context chunks (up to 10 products)
   */
  private extractProductRecommendations(
    contextChunks: Array<{ id: string; content: string; originalData: any }>,
    intent: { type: string; suggestedActions: string[] }
  ): {
    products: Array<{
      name: string;
      description: string;
      price?: string;
      features: string[];
      sourceUrl?: string;
    }>;
  } | undefined {
    // Only extract recommendations for product-related intents
    if (!['product_inquiry', 'purchase_intent', 'comparison'].includes(intent.type)) {
      return undefined;
    }

    const products: Array<{
      name: string;
      description: string;
      price?: string;
      features: string[];
      sourceUrl?: string;
    }> = [];

    // Enhanced extraction logic - look for product information in chunks
    contextChunks.forEach(chunk => {
      const content = chunk.content.toLowerCase();
      
      // Look for product names, prices, and features with more flexible patterns
      if (content.includes('product') || content.includes('price') || content.includes('₹') || content.includes('$') || content.includes('rupee')) {
        const lines = chunk.content.split('\n');
        let productName = '';
        let description = '';
        let price = '';
        const features: string[] = [];

        lines.forEach(line => {
          // Extract product names
          if ((line.toLowerCase().includes('product') || line.toLowerCase().includes('model') || line.toLowerCase().includes('item')) && line.length < 100) {
            productName = line.replace(/\[.*?\]/g, '').trim();
          }
          
          // Extract prices (convert to rupees)
          if (line.includes('₹') || line.includes('$') || line.toLowerCase().includes('price') || line.toLowerCase().includes('rupee')) {
            let extractedPrice = line.replace(/\[.*?\]/g, '').trim();
            // Convert $ to ₹ if needed
            if (extractedPrice.includes('$')) {
              const dollarAmount = extractedPrice.match(/\$(\d+(?:\.\d+)?)/);
              if (dollarAmount) {
                const rupees = Math.round(parseFloat(dollarAmount[1]) * 83); // Approximate conversion
                extractedPrice = `₹${rupees}`;
              }
            }
            price = extractedPrice;
          }
          
          // Extract features
          if (line.length > 20 && line.length < 200 && !line.includes('[') && !line.toLowerCase().includes('chunk')) {
            features.push(line.trim());
          }
        });

        if (productName && features.length > 0) {
          // Only include price if specifically asked about pricing
          const shouldIncludePrice = intent.suggestedActions.includes('show_pricing') || 
                                   intent.type === 'purchase_intent';

          products.push({
            name: productName,
            description: description || features.slice(0, 2).join(' '),
            price: (price && shouldIncludePrice) ? price : undefined,
            features: features.slice(0, 4), // Limit to 4 features
            sourceUrl: chunk.originalData.metadata?.sourceUrl
          });
        }
      }
    });

    // Remove duplicates based on product name
    const uniqueProducts = products.filter((product, index, self) => 
      index === self.findIndex(p => p.name.toLowerCase() === product.name.toLowerCase())
    );

    return uniqueProducts.length > 0 ? { products: uniqueProducts.slice(0, 10) } : undefined;
  }

  /**
   * Process customer query with multi-agent approach and clarification logic
   * ALWAYS responds based on available context from uploaded documents
   */
  async processCustomerQuery(
    query: string,
    options: CustomerQueryOptions = {}
  ): Promise<CustomerQueryResponse> {
    const {
      category = "",
      userId,
      sessionId,
      retrievalCount = 12,
      similarityThreshold = 0.5 // Lower threshold to get more context
    } = options;

    console.log(`🛍️ Customer query: "${query}"`);

    try {
      // 1. Analyze customer intent
      const intent = await this.analyzeCustomerIntent(query);
      console.log(`🎯 Intent: ${intent.type} (confidence: ${intent.confidence})`);

      // 2. Check if query needs clarification
      const clarification = await this.needsClarification(query, intent);
      console.log(`❓ Needs clarification: ${clarification.needsClarification}`);

      // 3. Select appropriate agent
      const agentType = this.selectAgent(intent, clarification.needsClarification);
      console.log(`🤖 Selected agent: ${agentType}`);

      // 4. Use RAG service to get relevant context (skip LLM generation)
      const ragResult = await ragService.queryDocuments(query, {
        retrievalCount,
        similarityThreshold,
        productName: "", // No product filtering - search all documents
        intent: "sales", // Use sales mode for customer-facing responses
        skipGeneration: true // Skip LLM generation since customer service will handle it
      });

      // 5. Generate response using selected agent
      let contextChunks = ragResult.sources.map((source, index) => ({
        id: `chunk_${index}`,
        content: `[CHUNK_ID: chunk_${index}] [From: ${source.filename}]\n${source.content}`,
        originalData: source
      }));
      console.log("🚀 ~ CustomerService ~ processCustomerQuery ~ contextChunks:", contextChunks);

      const customerResponse = await this.generateAgentResponse(
        query,
        intent,
        agentType,
        contextChunks
      );

      // 6. Prepare final response
      const response: CustomerQueryResponse = {
        query,
        response: customerResponse.response,
        intent: {
          ...intent,
          type: clarification.needsClarification ? 'clarification_needed' : intent.type
        },
        clarifyingQuestions: clarification.needsClarification ? clarification.clarifyingQuestions : undefined,
        productNames: customerResponse.productNames,
        recommendations: customerResponse.recommendations,
        sources: ragResult.sources.map(source => ({
          documentId: source.documentId,
          filename: source.filename,
          content: '', // Empty content to reduce response size
          score: source.score,
          metadata: [], // Empty metadata to reduce response size
          sourceUrl: source.sourceUrl,
          uploadType: source.uploadType
        })),
        contextAnalysis: ragResult.contextAnalysis,
        agentType
      };

      console.log(`✅ ${agentType} response generated with ${response.sources.length} sources`);
      return response;

    } catch (error: any) {
      console.error("Customer query processing failed:", error);
      
      // Fallback response
      return {
        query,
        response: "I'm unable to process your request at the moment. Please ensure our product documentation is properly uploaded and indexed, or contact our support team for assistance.",
        intent: {
          type: 'general',
          confidence: 0.5,
          suggestedActions: ['contact_support']
        },
        sources: [],
        contextAnalysis: {
          isContextMissing: true,
          suggestedTopics: [],
          category: 'error',
          priority: 'high'
        },
        agentType: 'support_agent'
      };
    }
  }

  /**
   * Get customer query analytics (for future use)
   */
  async getCustomerAnalytics(): Promise<{
    totalQueries: number;
    intentDistribution: Record<string, number>;
    topProducts: Array<{ name: string; queries: number }>;
  }> {
    // This would integrate with analytics storage in the future
    return {
      totalQueries: 0,
      intentDistribution: {},
      topProducts: []
    };
  }
}

export const customerService = new CustomerService();