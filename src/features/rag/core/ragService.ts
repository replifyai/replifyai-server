import { createEmbedding } from "../providers/embeddingService.js";
import { vectorStore } from "../providers/index.js";
import { storage } from "../../../storage.js";
import { inferenceProvider } from "../../../services/llm/inference.js";
import { openai } from "../../../services/llm/openai.js";
import { env } from "../../../env.js";
import { enhancedRAGService, EnhancedRAGOptions } from "./enhancedRAG.js";
import { VectorStoreProvider } from "../providers/types.js";

export interface ContextMissingAnalysis {
  isContextMissing: boolean;
  suggestedTopics: string[];
  category: string;
  priority: 'low' | 'medium' | 'high';
}

export interface RAGResponse {
  query: string;
  response: string;
  sources: Array<{
    documentId: number;
    filename: string;
    content: string;
    score: number;
    metadata?: any;
    sourceUrl?: string;
    uploadType?: string;
  }>;
  contextAnalysis: ContextMissingAnalysis;
}

export class RAGService {
  
  getProvider(): VectorStoreProvider {
    return vectorStore;
  }

  /**
   * 🚀 NEW: Enhanced RAG query with production-grade features
   * - Fuzzy product name matching
   * - Multi-query retrieval
   * - Reranking
   * - Contextual compression
   * - Dynamic chunk selection
   */
  async queryDocumentsEnhanced(query: string, options: EnhancedRAGOptions = {}): Promise<RAGResponse> {
    try {
      // Use the enhanced RAG service
      const enhancedResponse = await enhancedRAGService.query(query, options);

      // Convert to RAGResponse format for backward compatibility
      return {
        query: enhancedResponse.query,
        response: enhancedResponse.response,
        sources: enhancedResponse.sources,
        contextAnalysis: enhancedResponse.contextAnalysis,
      };
    } catch (error: any) {
      console.error("Enhanced RAG query failed:", error);
      throw new Error(`Failed to process enhanced query: ${error.message}`);
    }
  }

  // Patterns that indicate missing context
  private readonly MISSING_CONTEXT_PATTERNS = [
    /don't have enough information/i,
    /not provided in.*context/i,
    /information.*not available/i,
    /cannot find.*in.*documents/i,
    /no relevant information/i,
    /context doesn't contain/i,
    /uploaded documents.*don't contain/i,
    /not present.*provided context/i,
    /insufficient information/i,
    /need more details/i,
    /cannot answer.*based on.*context/i,
    /documents.*don't include/i,
    /cannot answer.*question/i,
    /therefore.*cannot answer/i,
    /unable to answer.*question/i,
    /context.*does not include/i,
    /provided context.*does not/i,
  ];
  /**
   * Classify and expand query - determines if RAG is needed
   */
  async expandQuery(query: string, companyContext?: {
    companyName?: string;
    companyDescription?: string;
    productCategories?: string;
  }, productName?: string): Promise<{
    expandedQuery: string;
    needsRAG: boolean;
    queryType: 'greeting' | 'casual' | 'informational' | 'unknown';
    directResponse?: string;
  }> {
    // Use provided context or fallback to environment variables
    const contextInfo = {
      companyName: companyContext?.companyName || env.COMPANY_NAME,
      companyDescription: companyContext?.companyDescription || env.COMPANY_DESCRIPTION,
      productCategories: companyContext?.productCategories || env.PRODUCT_CATEGORIES
    };

    // Build product-specific context
    const productContext = productName 
      ? `\n- Specific Product: ${productName}\n- Focus: All query expansions should be specific to "${productName}" and its features, specifications, and use cases.`
      : '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: "system", content: `You are a query analyzer and expander for ${contextInfo.companyName}.

Company Context:
- Company: ${contextInfo.companyName}
- About: ${contextInfo.companyDescription}
- Product asked in query: ${productContext}

Analyze the user query and determine:
1. Query type: greeting, casual, or informational
2. Whether RAG (document retrieval) is needed
3. If no RAG needed, provide a direct friendly and contextual response that mentions the company/product naturally
4. If RAG needed, expand the query with domain-specific terminology based on company context${productName ? ` and specifically for "${productName}"` : ''}

Return a JSON object:
{
  "queryType": "greeting|casual|informational",
  "needsRAG": true|false,
  "directResponse": "optional friendly response if no RAG needed",
  "expandedQuery": "expanded query for RAG search (only if needsRAG is true)"
}

Guidelines for direct responses (greetings/casual):
- For greetings: Be warm, mention the company name naturally, and offer help with products/services${productName ? ` (especially "${productName}")` : ''}
- For casual chat: Be friendly and contextual, subtly reference what you can help with
- Keep responses concise (1-2 sentences max)
- Always end with an invitation to ask about products/services

Guidelines for query expansion (informational queries):
- Include synonyms and related concepts from the original query
- Add domain-specific terms relevant to ${contextInfo.productCategories}${productName ? ` and specifically for "${productName}"` : ''}
- Include variations that match the company's product/service offerings
- Keep expansion focused and relevant (avoid generic terms)
- Make it semantically rich for better vector search retrieval
${productName ? `- IMPORTANT: Always include "${productName}" and its variations in the expanded query to ensure product-specific results` : ''}

Examples:
- "hi" → {"queryType": "greeting", "needsRAG": false, "directResponse": "Hello! Welcome to ${contextInfo.companyName}. I'm here to help you with any questions about our ${contextInfo.productCategories.split(',')[0]}${productName ? `, especially ${productName}` : ''}. What would you like to know?"}
- "hello" → {"queryType": "greeting", "needsRAG": false, "directResponse": "Hi there! I'm your ${contextInfo.companyName} assistant. Feel free to ask me anything about our products and services!"}
- "how are you" → {"queryType": "casual", "needsRAG": false, "directResponse": "I'm doing great, thanks for asking! Ready to help you explore our solutions. What brings you here today?"}
- "thank you" → {"queryType": "casual", "needsRAG": false, "directResponse": "You're very welcome! Let me know if you need anything else about our products or services."}
- "what are the product features?" → {"queryType": "informational", "needsRAG": true, "expandedQuery": "product features specifications capabilities functionalities benefits key attributes ${contextInfo.productCategories} product details${productName ? ` ${productName} features ${productName} specifications ${productName} capabilities` : ''}"}
- If company sells "orthopedic insoles" and query is "best for running"${productName ? ` for product "${productName}"` : ''} → {"queryType": "informational", "needsRAG": true, "expandedQuery": "running insoles athletic orthopedic support sports insoles arch support for runners plantar support performance footwear active lifestyle${productName ? ` ${productName} running ${productName} athletic ${productName} sports` : ''}"}` },
        { role: "user", content: query },
      ],
      max_completion_tokens: 500,
      response_format: { type: "json_object" }
    });
    
    const content = response.choices[0]?.message?.content || "{}";
    const analysis = JSON.parse(content);
    
    return {
      expandedQuery: analysis.expandedQuery || query,
      needsRAG: analysis.needsRAG !== false,
      queryType: analysis.queryType || 'unknown',
      directResponse: analysis.directResponse
    };
  }

  async queryDocuments(query: string, options: {
    retrievalCount?: number;
    similarityThreshold?: number;
    productName?: string;
    intent?: string;
    skipGeneration?: boolean;
    companyContext?: {
      companyName?: string;
      companyDescription?: string;
      productCategories?: string;
    };
  } = {}): Promise<RAGResponse> {
    const { retrievalCount = 10, similarityThreshold = 0.5, productName = "", intent = "query", skipGeneration = false, companyContext } = options;
    try {
      // Analyze and expand the query with company context
      const queryAnalysis = await this.expandQuery(query, companyContext, productName);
      
      // If RAG is not needed (greeting/casual), return direct response
      if (!queryAnalysis.needsRAG && queryAnalysis.directResponse) {
        return {
          query,
          response: queryAnalysis.directResponse,
          sources: [],
          contextAnalysis: {
            isContextMissing: false,
            suggestedTopics: [],
            category: queryAnalysis.queryType,
            priority: 'low'
          },
        };
      }
      
      // Search for similar chunks
      // For Google RAG, expandedQuery might be less useful than raw query + context, but let's try expanded first or just query.
      // vectorStore.searchSimilar usually expects a string query (handled internally by Google or via embedding by QdrantService wrapper)
      const searchResults = await vectorStore.searchSimilar(
        queryAnalysis.expandedQuery || query,
        retrievalCount,
        similarityThreshold,
        productName
      );

      if (searchResults.length === 0) {
        const noResultsResponse = "I don't have enough information in the uploaded documents to answer this question. Please try uploading relevant documents first.";

        // Analyze this response for context missing
        const contextAnalysis = this.analyzeForMissingContext(query, noResultsResponse);

        return {
          query,
          response: noResultsResponse,
          sources: [],
          contextAnalysis: {
            ...contextAnalysis,
            isContextMissing: true,
          },
        };
      }

      // Since we already have product-specific chunks from Qdrant/Google, just sort by similarity score
      const sortedChunks = searchResults
        .sort((a, b) => b.score - a.score);

      // Prepare context from search results with chunk IDs
      const contextChunks = sortedChunks.map((result, index) => {
        let contextContent = `[CHUNK_ID: chunk_${index}] [From: ${result.filename}]\n${result.content}`;

        // Add complete metadata if available
        if (result.metadata) {
          contextContent += `\n\nMetadata:\n${JSON.stringify(result.metadata, null, 2)}`;
        }

        return {
          id: `chunk_${index}`,
          content: contextContent,
          originalData: result
        };
      });

      // Skip LLM generation if requested (for customer service)
      if (skipGeneration) {
        // Prepare sources information from all chunks, ensuring unique sourceUrls
        const uniqueSourceUrls = new Set<string>();
        const sources = contextChunks
          .map(chunk => ({
            documentId: chunk.originalData.documentId,
            filename: chunk.originalData.filename,
            content: chunk.originalData.content,
            score: chunk.originalData.score,
            metadata: chunk.originalData.metadata || [],
            sourceUrl: chunk.originalData.metadata?.sourceUrl,
            uploadType: chunk.originalData.metadata?.uploadType,
          }));

        return {
          query,
          response: "", // Empty response since customer service will generate its own
          sources,
          contextAnalysis: {
            isContextMissing: false,
            suggestedTopics: [],
            category: 'answered',
            priority: 'low'
          },
        };
      }

      // Generate response using OpenAI
      let responseData;
      if (intent === "query") {
        responseData = await this.generateResponse(query, contextChunks);
      } else {
        responseData = await this.generateSalesAgentResponse(query, contextChunks);
      }

      // Analyze response for missing context
      const contextAnalysis = this.analyzeForMissingContext(query, responseData.response);
      
      // If no chunks were explicitly cited, include all retrieved chunks as sources
      // This ensures we always have sources even if the LLM doesn't follow citation format
      const chunksToInclude = responseData.usedChunkIds.length > 0 
        ? contextChunks.filter(chunk => responseData.usedChunkIds.includes(chunk.id))
        : contextChunks;

      // Prepare sources information, ensuring unique sourceUrls
      const uniqueSourceUrls = new Set<string>();
      const sources = chunksToInclude
        .filter(chunk => {
          const sourceUrl = chunk.originalData.metadata?.sourceUrl;
          // If no sourceUrl, include the chunk (it might be from file upload)
          if (!sourceUrl) {
            return true;
          }
          // If sourceUrl exists, check for uniqueness
          if (uniqueSourceUrls.has(sourceUrl)) {
            return false;
          }
          uniqueSourceUrls.add(sourceUrl);
          return true;
        })
        .map(chunk => ({
          documentId: chunk.originalData.documentId,
          filename: chunk.originalData.filename,
          content: '',
          score: chunk.originalData.score,
          metadata: [],
          sourceUrl: chunk.originalData.metadata?.sourceUrl,
          uploadType: chunk.originalData.metadata?.uploadType,
        }));


      return {
        query,
        response: responseData.response,
        sources,
        contextAnalysis,
      };

    } catch (error: any) {
      console.error("RAG query failed:", error);
      throw new Error(`Failed to process query: ${error.message}`);
    }
  }

  /**
   * Generate response with sophisticated context handling
   */
  private async generateResponse(query: string, contextChunks: Array<{
    id: string;
    content: string;
    originalData: any;
  }>): Promise<{
    response: string;
    usedChunkIds: string[];
  }> {
    const systemPrompt = `
    You are an AI assistant for the whole company, which help in giving informative answers to the user queries.
    
    QUERY: ${query}
    
    CRITICAL INSTRUCTIONS:
    1. Use only the provided context for answers — never use external knowledge.  
    2. If context has both relevant and conflicting details, provide only the relevant ones and clarify conflicts.  
    3. If the exact answer is missing from the context, reply: "I don't have enough information to answer this question."
    4. Do not use the word "chunk","document","source","context" in your response.
    5. You are a helpful assistant, helping the user to get the information they are looking for.
    6. Answer the question with confidence and make sure you are giving the answer in a way that is easy to understand.
    
    ANSWERING RULES:

    Chunk Citation (Mandatory): Every statement in your answer must include its supporting source in this format:
    [USED_CHUNK: chunk_id]

    IMPORTANT: You MUST cite at least one chunk for your answer. If you use information from multiple chunks, cite each one.

    Comprehensive Answering: Cover all aspects mentioned in the context related to the query (materials, features, design, comfort, performance, etc.).

    Structured Response: Present answers in multiple sentences or bullet points, not a single line, so the response is detailed yet clear.

    Separation of Sources: If multiple chunks or documents provide overlapping or differing details, present them clearly under separate points, explicitly identifying their sources.

    Conciseness with Depth: Be concise but ensure the response captures every relevant property mentioned in the context.
    
    Context from uploaded documents:  
    ${contextChunks.map(chunk => chunk.content).join('\n\n---\n\n')}
    `;


    // Use provider-agnostic inference for generating the response
    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.1, maxTokens: 1000 }
    );

    // Extract used chunk IDs from the response
    const usedChunkIds: string[] = [];
    // More flexible pattern to catch variations in citation format, including comma-separated lists
    const chunkIdPatterns = [
      /\[USED_CHUNK:\s*([^\]]+)\]/gi,
      /\[CHUNK_ID:\s*([^\]]+)\]/gi,
      /\[(?:USED_CHUNK|CHUNK_ID):\s*([^\]]+)\]/gi
    ];
    
    chunkIdPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const chunkIdString = match[1];
        const individualIds = chunkIdString.split(',').map(id => id.trim());
        individualIds.forEach(id => {
          if (id && !usedChunkIds.includes(id)) {
            usedChunkIds.push(id);
          }
        });
      }
    });

    // Clean up the response by removing the chunk ID markers
    // More comprehensive regex to catch all variations, including comma-separated lists
    const cleanResponse = responseText
      .replace(/\[(?:USED_CHUNK|CHUNK_ID):\s*[^\]]+\]/gi, '')
      .replace(/\[USED_CHUNK:\s*[^\]]+\]/gi, '')
      .replace(/\[CHUNK_ID:\s*[^\]]+\]/gi, '')
      .replace(/\s+/g, ' ') // Clean up extra whitespace
      .trim();

    return {
      response: cleanResponse,
      usedChunkIds,
    };
  }


  /**
   * Analyze if a response indicates missing context
   */
  private analyzeForMissingContext(query: string, response: string): ContextMissingAnalysis {
    const detectedPatterns = this.getDetectedPatterns(response);
    const isContextMissing = detectedPatterns.length > 0;

    if (!isContextMissing) {
      return {
        isContextMissing: false,
        suggestedTopics: [],
        category: 'answered',
        priority: 'low'
      };
    }

    // Simple analysis based on query keywords
    const analysis = this.analyzeQuery(query);

    return {
      isContextMissing: true,
      suggestedTopics: analysis.suggestedTopics,
      category: analysis.category,
      priority: analysis.priority
    };
  }

  /**
   * Get detected patterns from response
   */
  private getDetectedPatterns(response: string): string[] {
    const detectedPatterns: string[] = [];

    for (const pattern of this.MISSING_CONTEXT_PATTERNS) {
      if (pattern.test(response)) {
        detectedPatterns.push(pattern.source);
      }
    }

    return detectedPatterns;
  }

  /**
   * Simple analysis of query to determine category and priority
   */
  private analyzeQuery(query: string): {
    suggestedTopics: string[];
    category: string;
    priority: 'low' | 'medium' | 'high';
  } {
    const suggestedTopics: string[] = [];
    let category = 'other';
    let priority: 'low' | 'medium' | 'high' = 'medium';

    // Simple keyword extraction
    const words = query.toLowerCase().split(/\s+/);
    const technicalTerms = ['api', 'sdk', 'code', 'function', 'method', 'endpoint', 'authentication', 'integration'];
    const businessTerms = ['price', 'cost', 'plan', 'billing', 'account', 'subscription', 'payment'];
    const processTerms = ['how to', 'steps', 'process', 'workflow', 'procedure'];

    if (words.some(word => technicalTerms.includes(word))) {
      category = 'technical';
      suggestedTopics.push('technical documentation', 'API reference', 'integration guides');
    } else if (words.some(word => businessTerms.includes(word))) {
      category = 'business';
      suggestedTopics.push('pricing information', 'billing documentation', 'account management');
    } else if (words.some(word => processTerms.includes(word))) {
      category = 'process';
      suggestedTopics.push('user guides', 'tutorials', 'step-by-step instructions');
    }

    // Determine priority based on urgency indicators
    const urgentTerms = ['urgent', 'asap', 'immediately', 'critical', 'emergency', 'error', 'broken', 'not working'];
    if (words.some(word => urgentTerms.includes(word))) {
      priority = 'high';
    }

    return { suggestedTopics, category, priority };
  }


  async getSystemStats(): Promise<{
    documentCount: number;
    chunkCount: number;
    indexedDocuments: number;
  }> {
    const documents = await storage.getAllDocuments();
    const indexedDocuments = documents.filter(doc => doc.status === "indexed");
    const totalChunks = indexedDocuments.reduce((sum, doc) => sum + (doc.chunkCount || 0), 0);

    return {
      documentCount: documents.length,
      chunkCount: totalChunks,
      indexedDocuments: indexedDocuments.length,
    };
  }

  async getQdrantStatus(): Promise<any> {
    try {
      return await vectorStore.getCollectionInfo();
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }

  /**
   * SALES AGENT MODE: Retrieve docs and generate a persuasive, consultative sales response
   * without altering existing methods. Uses the same retrieval flow but a different prompt.
   */
  async queryDocumentsSalesAgent(query: string, options: {
    retrievalCount?: number;
    similarityThreshold?: number;
    productName?: string;
  } = {}): Promise<RAGResponse> {
    const { retrievalCount = 20, similarityThreshold = 0.75, productName = "" } = options;
    try {
      const searchResults = await vectorStore.searchSimilar(
        query,
        retrievalCount,
        similarityThreshold,
        productName
      );

      if (searchResults.length === 0) {
        const noResultsResponse = "I don't have enough information in the uploaded documents to tailor a recommendation. Could you share a bit more about your needs or upload relevant materials?";
        const contextAnalysis = this.analyzeForMissingContext(query, noResultsResponse);
        return {
          query,
          response: noResultsResponse,
          sources: [],
          contextAnalysis: { ...contextAnalysis, isContextMissing: true },
        };
      }

      const sortedChunks = searchResults.sort((a, b) => b.score - a.score);

      const contextChunks = sortedChunks.map((result, index) => {
        let content = `[CHUNK_ID: chunk_${index}] [From: ${result.filename}]\n${result.content}`;
        if (result.metadata) {
          content += `\n\nMetadata:\n${JSON.stringify(result.metadata, null, 2)}`;
        }
        return { id: `chunk_${index}`, content, originalData: result };
      });

      const responseData = await this.generateSalesAgentResponse(query, contextChunks);

      const contextAnalysis = this.analyzeForMissingContext(query, responseData.response);

      const usedChunks = contextChunks.filter((c) => responseData.usedChunkIds.includes(c.id));
      const uniqueSourceUrls = new Set<string>();
      const sources = usedChunks
        .filter((chunk) => {
          const sourceUrl = chunk.originalData.metadata?.sourceUrl;
          if (!sourceUrl || uniqueSourceUrls.has(sourceUrl)) return false;
          uniqueSourceUrls.add(sourceUrl);
          return true;
        })
        .map((chunk) => ({
          documentId: chunk.originalData.documentId,
          filename: chunk.originalData.filename,
          content: '',
          score: chunk.originalData.score,
          metadata: [],
          sourceUrl: chunk.originalData.metadata?.sourceUrl,
          uploadType: chunk.originalData.metadata?.uploadType,
        }));

      return {
        query,
        response: responseData.response,
        sources,
        contextAnalysis,
      };
    } catch (error: any) {
      console.error("RAG sales agent query failed:", error);
      throw new Error(`Failed to process sales agent query: ${error.message}`);
    }
  }

  /**
   * Generate a persuasive, helpful sales-focused response
   */
  private async generateSalesAgentResponse(query: string, contextChunks: Array<{
    id: string;
    content: string;
    originalData: any;
  }>): Promise<{ response: string; usedChunkIds: string[] }> {
    const systemPrompt = `You are a friendly, consultative sales agent.
Style: natural, human, second-person, and approachable; mirror the user's wording; avoid jargon.
Goal: understand the need, recommend from ONLY the provided context, highlight 2–3 benefits, and propose a clear CTA.
Constraints: ≤80 words; single short paragraph; no bullets, no numbered lists, no headings, no bold; factual only do not invent features or pricing.


Context:
${contextChunks.map(c => c.content).join('\n\n---\n\n')}

IMPORTANT: When you use information from a chunk, include the chunk ID in your response like this: [USED_CHUNK: chunk_id]`;

    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.4, maxTokens: 240 }
    );

    // Extract used chunk IDs
    const usedChunkIds = this.extractChunkIds(responseText);
    
    // Clean up the response
    const cleanResponse = this.cleanChunkMarkers(responseText);
    return { response: cleanResponse, usedChunkIds };
  }

  /**
   * Helper: Extract chunk IDs from response text
   */
  private extractChunkIds(responseText: string): string[] {
    const usedChunkIds: string[] = [];
    const chunkIdPatterns = [
      /\[USED_CHUNK:\s*([^\]]+)\]/gi,
      /\[CHUNK_ID:\s*([^\]]+)\]/gi,
    ];
    
    chunkIdPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const chunkIdString = match[1];
        const individualIds = chunkIdString.split(',').map(id => id.trim());
        individualIds.forEach(id => {
          if (id && !usedChunkIds.includes(id)) {
            usedChunkIds.push(id);
          }
        });
      }
    });
    
    return usedChunkIds;
  }

  /**
   * Helper: Clean chunk markers from response text
   */
  private cleanChunkMarkers(responseText: string): string {
    return responseText
      .replace(/\[(?:USED_CHUNK|CHUNK_ID):\s*[^\]]+\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

export const ragService = new RAGService();
