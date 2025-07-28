import { createEmbedding, openai } from "./openai.js";
import { generateGroqChatResponse } from "./groq.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";

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
  ];

  async queryDocuments(query: string, options: {
    retrievalCount?: number;
    similarityThreshold?: number;
    productName?: string;
  } = {}): Promise<RAGResponse> {
    const { retrievalCount = 20, similarityThreshold = 0.75, productName = "" } = options;
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
      const responseData = await this.generateResponse(query, contextChunks);

      // Analyze response for missing context
      const contextAnalysis = this.analyzeForMissingContext(query, responseData.response);

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
   * Generate response with simplified context handling using Groq
   */
  private async generateResponse(query: string, contextChunks: Array<{
    id: string;
    content: string;
    originalData: any;
  }>): Promise<{
    response: string;
    usedChunkIds: string[];
  }> {
    const systemPrompt = `You are a helpful AI assistant that answers questions based ONLY on the provided context from uploaded documents. 

INSTRUCTIONS:
1. Only use information from the provided context
2. Always cite which document(s) your answer comes from
3. Be concise but thorough
4. Do not make up or infer information not present in the context
5. If you don't have enough information to answer the question, say so clearly

IMPORTANT: When you use information from a chunk, include the chunk ID in your response like this: [USED_CHUNK: chunk_id]
You can include multiple chunk IDs if you use multiple chunks: [USED_CHUNK: chunk_0] [USED_CHUNK: chunk_1]

Context from uploaded documents:
${contextChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`;

    // Use Groq for generating the response
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query }
      ],
      temperature: 0.1,
      max_tokens: 1000,
    });

    const responseText = response.choices[0].message.content || "I couldn't generate a response.";

    // const responseText = await generateGroqChatResponse(systemPrompt, query, {
    //   model: "llama-3.1-8b-instant",
    //   temperature: 0.1,
    //   maxTokens: 1000,
    // });

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
}

export const ragService = new RAGService();
