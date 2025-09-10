import { createEmbedding } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";
import { inferenceProvider } from "./inference.js";
import { openai } from "./openai.js";

export interface ContextMissingAnalysis {
  isContextMissing: boolean;
  // confidence: number;
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

export interface RAGStreamEvent {
  type: 'delta' | 'sources' | 'analysis' | 'error' | 'complete';
  payload: any;
}

export class RAGService {
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

  async queryDocuments(query: string, options: {
    retrievalCount?: number;
    similarityThreshold?: number;
    productName?: string;
    intent?: string;
  } = {}): Promise<RAGResponse> {
    console.log("🚀 ~ RAGService ~ queryDocuments ~ query:", query);
    const { retrievalCount = 3, similarityThreshold = 0.75, productName = "",intent = "query" } = options;
    console.log("🚀 ~ RAGService ~ productName:", productName);
    try {
      // Create embedding for the query
      const queryEmbedding = await createEmbedding(query);

      // Search for similar chunks
      const searchResults = await qdrantService.searchSimilar(
        queryEmbedding,
        retrievalCount,
        similarityThreshold,
        productName
      );

      if (searchResults.length === 0) {
        const noResultsResponse = "I don't have enough information in the uploaded documents to answer this question. Please try uploading relevant documents first.";

        // Analyze this response for context missing
        const contextAnalysis = this.analyzeForMissingContext(query, noResultsResponse);
        console.log(`No search results for query: "${query}" - Category: ${contextAnalysis.category}`);

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

      // Since we already have product-specific chunks from Qdrant, just sort by similarity score
      const sortedChunks = searchResults
        .sort((a, b) => b.score - a.score);

      console.log(`🔍 RAG Query: "${query}"`);
      console.log(`📊 Retrieved chunks: ${searchResults.length}`);
      console.log(`📈 Top 3 chunks by Qdrant similarity score:`, sortedChunks.slice(0, 3).map(chunk => ({
        filename: chunk.filename,
        similarityScore: chunk.score?.toFixed(3),
        preview: chunk.content.substring(0, 100) + '...'
      })));

      // Prepare context from search results with chunk IDs
      const contextChunks = sortedChunks.map((result, index) => {
        console.log("🚀 ~ RAGService ~ queryDocuments ~ result:", result);
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

      // Generate response using OpenAI
      let responseData;
      if(intent === "query"){
        responseData = await this.generateResponse(query, contextChunks);
      }else{
        responseData = await this.generateSalesAgentResponse(query, contextChunks);
      }
      console.log("🚀 ~ RAGService ~ queryDocuments ~ responseData:", responseData);

      // Analyze response for missing context
      const contextAnalysis = this.analyzeForMissingContext(query, responseData.response);

      console.log("🚀 ~ RAGService ~ queryDocuments ~ responseData.usedChunkIds:", JSON.stringify(responseData?.usedChunkIds, null, 2));
      // Filter sources to only include chunks that were actually used
      const usedChunks = contextChunks.filter(chunk => 
        responseData.usedChunkIds.includes(chunk.id)
      );

      // Prepare sources information from only the used chunks, ensuring unique sourceUrls
      const uniqueSourceUrls = new Set<string>();
      const sources = usedChunks
        .filter(chunk => {
          const sourceUrl = chunk.originalData.metadata?.sourceUrl;
          if (!sourceUrl || uniqueSourceUrls.has(sourceUrl)) {
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

      // If context is missing, store the analysis for analytics
      if (contextAnalysis.isContextMissing) {
        console.log(`Context missing detected for query: "${query}" - Category: ${contextAnalysis.category}`);
      }

      console.log(`📚 Used ${usedChunks.length} out of ${sortedChunks.length} chunks for response`);

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
   * Generate response with sophisticated context handling and query intent analysis
   */
  private async generateResponse(query: string, contextChunks: Array<{
    id: string;
    content: string;
    originalData: any;
  }>): Promise<{
    response: string;
    usedChunkIds: string[];
  }> {
    
    // Get query analysis for enhanced prompting
    // const queryAnalysis = await this.analyzeQueryIntent(query);

    const systemPrompt = `
    You are an AI assistant that must answer questions **only** using the provided context from uploaded documents.
    
    QUERY: ${query}
    
    CRITICAL INSTRUCTIONS:
    1. Use only the provided context for answers — never use external knowledge.  
    2. If context has both relevant and conflicting details, provide only the relevant ones and clarify conflicts.  
    3. If the exact answer is missing from the context, reply: "I don't have enough information in the uploaded documents."  
    
    ANSWERING RULES:
    - Always cite source chunks like this: [USED_CHUNK: chunk_id] this is very important if you can't cite the chunks then the answer is of no value  
    - Be concise, accurate, and thorough.  
    - Do not assume, invent, or infer beyond the text.  
    - If multiple documents provide different info, clearly separate them.  
    
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
    const chunkIdPattern = /\[USED_CHUNK: (\w+)\]/g;
    let match;
    while ((match = chunkIdPattern.exec(responseText)) !== null) {
      if (!usedChunkIds.includes(match[1])) {
        usedChunkIds.push(match[1]);
      }
    }

    // Clean up the response by removing the chunk ID markers
    const cleanResponse = responseText.replace(/\[USED_CHUNK: \w+\]/g, '').trim();

    return {
      response: cleanResponse,
      usedChunkIds,
    };
  }

  /**
   * Analyze query intent to provide better context-aware responses
   */
  private async analyzeQueryIntent(query: string): Promise<{
    primaryIntent: string;
    specificTerms: string[];
    contextRequirements: string[];
    conflictingTerms: string[];
    entityType: string;
    attributeType: string;
  }> {
    try {
      const responseText = await inferenceProvider.chatCompletion(
        `You are an expert query analyzer. Analyze the user's query to understand their specific intent and context requirements.

Your task is to identify:
1. What the user is primarily looking for (primary intent)
2. Specific terms that must be present in relevant content
3. Context requirements that content must satisfy
4. Terms that would indicate conflicting or irrelevant content
5. The type of entity they're asking about (product, package, service, etc.)
6. The type of attribute they want (dimensions, weight, specifications, etc.)

Return a JSON object with this structure:
{
  "primaryIntent": "Brief description of what user wants",
  "specificTerms": ["term1", "term2"],
  "contextRequirements": ["requirement1", "requirement2"],
  "conflictingTerms": ["conflicting1", "conflicting2"],
  "entityType": "product|package|service|document|general",
  "attributeType": "dimensions|weight|specifications|price|features|general"
}

Examples:
- "What are the product dimensions?" → entity: "product", attribute: "dimensions", conflicting: ["packaging", "box", "container"]
- "What is the packaging weight?" → entity: "package", attribute: "weight", conflicting: ["product", "item", "device"]
- "How much does shipping cost?" → entity: "service", attribute: "price", conflicting: ["product", "item"]`,
        query,
        { temperature: 0.1, maxTokens: 500 }
      );

      const result = JSON.parse(responseText || '{}');
      return {
        primaryIntent: result.primaryIntent || 'General information',
        specificTerms: result.specificTerms || [],
        contextRequirements: result.contextRequirements || [],
        conflictingTerms: result.conflictingTerms || [],
        entityType: result.entityType || 'general',
        attributeType: result.attributeType || 'general'
      };
    } catch (error) {
      console.error('Query intent analysis failed:', error);
      // Fallback to basic analysis
      return {
        primaryIntent: 'General information',
        specificTerms: [],
        contextRequirements: [],
        conflictingTerms: [],
        entityType: 'general',
        attributeType: 'general'
      };
    }
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

  /**
   * Calculate confidence score based on detected patterns
   */
  // private calculateConfidence(patterns: string[]): number {
  //   if (patterns.length === 0) return 0;
  //   if (patterns.length >= 3) return 0.95;
  //   if (patterns.length === 2) return 0.85;
  //   return 0.75;
  // }

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
      return await qdrantService.getCollectionInfo();
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
      const queryEmbedding = await createEmbedding(query);

      const searchResults = await qdrantService.searchSimilar(
        queryEmbedding,
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
   * SALES AGENT: Generate a persuasive, helpful response grounded ONLY in provided context.
   * Returns response plus the chunk ids it referenced (same mechanism as the standard generator).
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

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      temperature: 0.4,
      max_tokens: 240,
    });

    const responseText = response.choices[0]?.message?.content || "";

    const usedChunkIds: string[] = [];
    const chunkIdPattern = /\[USED_CHUNK: (\w+)\]/g;
    let match;
    while ((match = chunkIdPattern.exec(responseText)) !== null) {
      if (!usedChunkIds.includes(match[1])) usedChunkIds.push(match[1]);
    }

    const cleanResponse = responseText.replace(/\[USED_CHUNK: \w+\]/g, '').trim();
    return { response: cleanResponse, usedChunkIds };
  }

  /**
   * Stream query documents with real-time response generation
   */
  async *streamQueryDocuments(query: string, options: {
    retrievalCount?: number;
    similarityThreshold?: number;
    productName?: string;
    intent?: string;
  } = {}): AsyncGenerator<RAGStreamEvent> {
    const { retrievalCount = 5, similarityThreshold = 0.75, productName = "", intent = "query" } = options;
    
    try {
      // Step 1: Create embedding and search
      const queryEmbedding = await createEmbedding(query);
      const searchResults = await qdrantService.searchSimilar(
        queryEmbedding,
        retrievalCount,
        similarityThreshold,
        productName
      );

      if (searchResults.length === 0) {
        const noResultsMessage = "I don't have enough information in the uploaded documents to answer this question.";
        yield { type: 'delta', payload: noResultsMessage };
        yield { type: 'sources', payload: [] };
        yield { 
          type: 'analysis', 
          payload: {
            isContextMissing: true,
            suggestedTopics: ['Upload relevant documents'],
            category: 'no_context',
            priority: 'high'
          }
        };
        yield { type: 'complete', payload: null };
        return;
      }

      // Step 2: Sort and prepare chunks
      const sortedChunks = searchResults.sort((a, b) => b.score - a.score);
      const contextChunks = sortedChunks.map((result, index) => ({
        id: `chunk_${index}`,
        content: `[CHUNK_ID: chunk_${index}] [From: ${result.filename}]\n${result.content}`,
        originalData: result
      }));

      // Step 3: Stream response generation
      const systemPrompt = this.buildStreamingPrompt(query, contextChunks, intent);
      const stream = await inferenceProvider.chatCompletionStream(
        systemPrompt,
        query,
        { temperature: 0.1, maxTokens: 1000 }
      );

      let fullResponse = '';
      const usedChunkIds: string[] = [];

      // Stream the response chunks
      for await (const chunk of stream) {
        fullResponse += chunk;
        yield { type: 'delta', payload: chunk };
        
        // Check for chunk references in the accumulated response
        const chunkIdPattern = /\[USED_CHUNK: (\w+)\]/g;
        let match;
        while ((match = chunkIdPattern.exec(fullResponse)) !== null) {
          if (!usedChunkIds.includes(match[1])) {
            usedChunkIds.push(match[1]);
          }
        }
      }

      // Step 4: Process and send sources
      const usedChunks = contextChunks.filter(chunk => usedChunkIds.includes(chunk.id));
      console.log("🚀 ~ RAGService ~ streamQueryDocuments ~ usedChunks:", usedChunks);
      const uniqueSourceUrls = new Set<string>();
      const sources = usedChunks
        .filter(chunk => {
          const sourceUrl = chunk.originalData.metadata?.sourceUrl;
          if (!sourceUrl || uniqueSourceUrls.has(sourceUrl)) return false;
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

      yield { type: 'sources', payload: sources };

      // Step 5: Analyze for missing context
      const cleanedResponse = fullResponse.replace(/\[USED_CHUNK: \w+\]/g, '').trim();
      const contextAnalysis = this.analyzeForMissingContext(query, cleanedResponse);
      yield { type: 'analysis', payload: contextAnalysis };

      yield { type: 'complete', payload: null };

    } catch (error: any) {
      console.error("RAG streaming failed:", error);
      yield { type: 'error', payload: error.message };
    }
  }

  private buildStreamingPrompt(
    query: string, 
    contextChunks: Array<{ id: string; content: string; originalData: any }>,
    intent: string
  ): string {
    console.log("🚀 ~ RAGService ~ buildStreamingPrompt ~ intent:", intent);
    if (intent === 'sales') {
      return `You are a friendly, consultative sales agent.
Style: natural, human, second-person, and approachable; mirror the user's wording; avoid jargon.
Goal: understand the need, recommend from ONLY the provided context, highlight 2–3 benefits, and propose a clear CTA.
Constraints: ≤80 words; single short paragraph; no bullets, no numbered lists, no headings, no bold; factual only.

QUERY: ${query}

Context:
${contextChunks.map(c => c.content).join('\n\n---\n\n')}

IMPORTANT: When you use information from a chunk, include the chunk ID in your response like this: [USED_CHUNK: chunk_id]`;
    }

    return `You are an AI assistant that must answer questions **only** using the provided context.
    
QUERY: ${query}

CRITICAL INSTRUCTIONS:
1. Use only the provided context for answers.
2. Always give detailed answers with as much information as possible. 
2. Always cite source chunks: [USED_CHUNK: chunk_id], If you can't cite the chunks then the answer is of no value
3. If the exact answer is missing, say: "I don't have enough information in the uploaded documents."

Context from uploaded documents:
${contextChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`;
  }
}

export const ragService = new RAGService();
