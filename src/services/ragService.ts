import { createEmbedding, generateChatResponse } from "./openai.js";
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
  } = {}): Promise<RAGResponse> {
    const { retrievalCount = 20, similarityThreshold = 0.75 } = options;

    try {
      // Create embedding for the query
      const queryEmbedding = await createEmbedding(query);

      // Search for similar chunks
      const searchResults = await qdrantService.searchSimilar(
        queryEmbedding,
        retrievalCount,
        similarityThreshold
      );

      if (searchResults.length === 0) {
        const noResultsResponse = "I don't have enough information in the uploaded documents to answer this question. Please try uploading relevant documents first.";
        
        // Analyze this response for context missing
        const contextAnalysis = this.analyzeForMissingContext(query, noResultsResponse);
        
        // Store the conversation with context missing flag
        // const savedMessage = await storage.createMessage({
        //   message: query,
        //   response: noResultsResponse,
        //   sources: [],
        //   isContextMissing: true,
        //   tags: [contextAnalysis.category],
        // });

        // Store the context missing query for analytics
        // await storage.createContextMissingQuery({
        //   chatMessageId: savedMessage.id,
        //   query,
        //   detectedPatterns: this.getDetectedPatterns(noResultsResponse),
        //   suggestedTopics: contextAnalysis.suggestedTopics,
        //   category: contextAnalysis.category,
        //   priority: contextAnalysis.priority,
        //   resolved: false,
        // });

        console.log(`No search results for query: "${query}" - Category: ${contextAnalysis.category}`);

        return {
          query,
          response: noResultsResponse,
          sources: [],
          contextAnalysis: {
            ...contextAnalysis,
            isContextMissing: true,
            // confidence: 1.0, // High confidence when no results found
          },
        };
      }

      // Prepare context from search results
      const contextChunks = searchResults.map(result => 
        `[From: ${result.filename}]\n${result.content}`
      );

      // Generate response using OpenAI
      const response = await generateChatResponse(query, contextChunks);

      // Analyze response for missing context
      const contextAnalysis = this.analyzeForMissingContext(query, response);

      // Prepare sources information
      const sources = searchResults.map(result => ({
        documentId: result.documentId,
        filename: result.filename,
        content: '',
        // content: result.content.substring(0, 200) + "...",
        score: result.score,
        // metadata: result.metadata,
        metadata: [],
        sourceUrl: result.metadata?.sourceUrl,
        uploadType: result.metadata?.uploadType,
      }));

      // Store the conversation with context missing flag
      // const savedMessage = await storage.createMessage({
      //   message: query,
      //   response,
      //   sources: sources,
      //   isContextMissing: contextAnalysis.isContextMissing,
      //   tags: contextAnalysis.isContextMissing ? [contextAnalysis.category] : null,
      // });

      // If context is missing, store the analysis for analytics
      if (contextAnalysis.isContextMissing) {
        // await storage.createContextMissingQuery({
        //   chatMessageId: savedMessage.id,
        //   query,
        //   detectedPatterns: this.getDetectedPatterns(response),
        //   suggestedTopics: contextAnalysis.suggestedTopics,
        //   category: contextAnalysis.category,
        //   priority: contextAnalysis.priority,
        //   resolved: false,
        // });
        
        console.log(`Context missing detected for query: "${query}" - Category: ${contextAnalysis.category}`);
      }

      return {
        query,
        response,
        sources,
        contextAnalysis,
      };

    } catch (error: any) {
      console.error("RAG query failed:", error);
      throw new Error(`Failed to process query: ${error.message}`);
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
        // confidence: 0,
        suggestedTopics: [],
        category: 'answered',
        priority: 'low'
      };
    }

    // Simple analysis based on query keywords
    const analysis = this.analyzeQuery(query);

    return {
      isContextMissing: true,
      // confidence: this.calculateConfidence(detectedPatterns),
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
