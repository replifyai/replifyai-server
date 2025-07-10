import { createEmbedding, generateChatResponse, openai } from "./openai.js";
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

      // Filter and rank chunks based on query specificity
      const filteredChunks = await this.filterAndRankChunks(query, searchResults);
      
      console.log(`🔍 RAG Query: "${query}"`);
      console.log(`📊 Original chunks: ${searchResults.length}, Filtered chunks: ${filteredChunks.length}`);
      console.log(`📈 Top 3 chunks by context score:`, filteredChunks.slice(0, 3).map(chunk => ({
        filename: chunk.filename,
        originalScore: chunk.originalScore?.toFixed(3),
        relevanceScore: chunk.relevanceScore?.toFixed(3),
        contextScore: chunk.contextScore?.toFixed(3),
        entityType: chunk.contextAnalysis?.entityType,
        attributeType: chunk.contextAnalysis?.attributeType,
        preview: chunk.content.substring(0, 100) + '...'
      })));
      
      // Prepare context from filtered search results
      const contextChunks = filteredChunks.map(result => 
        `[From: ${result.filename}]\n${result.content}`
      );

      // Generate response using OpenAI with enhanced context awareness
      const response = await this.generateContextAwareResponse(query, contextChunks);

      // Analyze response for missing context
      const contextAnalysis = this.analyzeForMissingContext(query, response);

      // Prepare sources information
      const sources = filteredChunks.map(result => ({
        documentId: result.documentId,
        filename: result.filename,
        content: '',
        score: result.score,
        metadata: [],
        sourceUrl: result.metadata?.sourceUrl,
        uploadType: result.metadata?.uploadType,
      }));

      // If context is missing, store the analysis for analytics
      if (contextAnalysis.isContextMissing) {
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
   * Filter and rank chunks based on query specificity and context relevance
   */
  private async filterAndRankChunks(query: string, searchResults: any[]): Promise<any[]> {
    // Use AI to analyze query intent and context requirements
    const queryAnalysis = await this.analyzeQueryIntent(query);
    
    console.log(`🧠 Query Analysis:`, queryAnalysis);
    
    // Score chunks based on AI-analyzed context relevance
    const scoredChunks = await Promise.all(
      searchResults.map(async (chunk) => {
        const contextRelevanceScore = await this.calculateContextRelevance(
          query,
          chunk.content,
          queryAnalysis
        );
        
        return {
          ...chunk,
          contextScore: chunk.score + contextRelevanceScore,
          originalScore: chunk.score,
          relevanceScore: contextRelevanceScore,
          contextAnalysis: queryAnalysis
        };
      })
    );

    // Sort by context score and return top results
    return scoredChunks
      .sort((a, b) => b.contextScore - a.contextScore)
      .slice(0, 10); // Limit to top 10 most relevant chunks
  }

  /**
   * Analyze query intent using AI to understand what the user is specifically looking for
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
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert query analyzer. Analyze the user's query to understand their specific intent and context requirements.

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
- "How much does shipping cost?" → entity: "service", attribute: "price", conflicting: ["product", "item"]`
          },
          {
            role: "user",
            content: query
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 500,
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
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
   * Calculate context relevance score using AI
   */
  private async calculateContextRelevance(
    query: string,
    chunkContent: string,
    queryAnalysis: any
  ): Promise<number> {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert content relevance analyzer. Your task is to determine how well a piece of content matches a specific query intent.

Given:
- User's query
- Query analysis (intent, entity type, attribute type, etc.)
- Content chunk

Analyze and return a JSON object with:
{
  "relevanceScore": 0.0-1.0,
  "reasoning": "Brief explanation of relevance",
  "hasConflictingInfo": true/false,
  "matchesIntent": true/false,
  "contextAlignment": 0.0-1.0
}

Scoring guidelines:
- 1.0: Perfect match, exactly what user is looking for
- 0.8-0.9: Very relevant, contains requested information
- 0.6-0.7: Somewhat relevant, related information
- 0.4-0.5: Marginally relevant, tangentially related
- 0.0-0.3: Not relevant or conflicting information

Pay special attention to:
- Exact matches for entity type (product vs packaging)
- Exact matches for attribute type (dimensions vs weight)
- Presence of conflicting information
- Context alignment with user's specific intent`
          },
          {
            role: "user",
            content: `Query: "${query}"

Query Analysis:
${JSON.stringify(queryAnalysis, null, 2)}

Content Chunk:
${chunkContent.substring(0, 800)}...`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 300,
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      // Convert relevance score to adjustment value (-0.5 to +0.5)
      const baseScore = result.relevanceScore || 0.5;
      const hasConflict = result.hasConflictingInfo || false;
      const matchesIntent = result.matchesIntent || false;
      
      let adjustmentScore = (baseScore - 0.5); // -0.5 to +0.5
      
      // Apply penalties and bonuses
      if (hasConflict) adjustmentScore -= 0.3;
      if (matchesIntent && baseScore > 0.8) adjustmentScore += 0.2;
      
      return Math.max(-0.5, Math.min(0.5, adjustmentScore));
      
    } catch (error) {
      console.error('Context relevance calculation failed:', error);
      return 0; // Neutral score on error
    }
  }

  /**
   * Get conflicting contexts for a specific term
   */
  private getConflictingContexts(term: string): string[] {
    // This method is now deprecated in favor of AI-powered analysis
    // Keeping for backward compatibility
    const conflicts: Record<string, string[]> = {
      'product dimensions': ['packaging', 'box', 'container', 'shipping'],
      'packaging dimensions': ['product', 'item', 'device', 'unit'],
      'product weight': ['packaging', 'box', 'container', 'shipping'],
      'packaging weight': ['product', 'item', 'device', 'unit'],
      'product specifications': ['packaging', 'shipping', 'delivery'],
      'shipping specifications': ['product', 'technical', 'device'],
    };
    
    return conflicts[term] || [];
  }

  /**
   * Generate context-aware response with AI-powered disambiguation
   */
  private async generateContextAwareResponse(query: string, contextChunks: string[]): Promise<string> {
    // Get query analysis for enhanced prompting
    const queryAnalysis = await this.analyzeQueryIntent(query);
    
    const systemPrompt = `You are a helpful AI assistant that answers questions based ONLY on the provided context from uploaded documents. 

QUERY ANALYSIS:
Primary Intent: ${queryAnalysis.primaryIntent}
Entity Type: ${queryAnalysis.entityType}
Attribute Type: ${queryAnalysis.attributeType}
Specific Terms Required: ${queryAnalysis.specificTerms.join(', ')}
Conflicting Terms to Avoid: ${queryAnalysis.conflictingTerms.join(', ')}

CRITICAL INSTRUCTIONS:
1. Focus ONLY on information that matches the entity type "${queryAnalysis.entityType}" and attribute type "${queryAnalysis.attributeType}"
2. If the user asks about "${queryAnalysis.entityType} ${queryAnalysis.attributeType}", provide ONLY that specific information
3. Ignore any information about conflicting entities: ${queryAnalysis.conflictingTerms.join(', ')}
4. If the context contains both relevant and conflicting information, clearly distinguish and provide only the relevant information
5. If the context doesn't contain the SPECIFIC information requested, say "I don't have information about ${queryAnalysis.entityType} ${queryAnalysis.attributeType} in the uploaded documents."

GENERAL RULES:
1. Only use information from the provided context
2. Always cite which document(s) your answer comes from
3. Be concise but thorough
4. Do not make up or infer information not present in the context
5. If multiple types of information are present, clearly specify which type you're providing

Context from uploaded documents:
${contextChunks.join('\n\n---\n\n')}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query }
      ],
      temperature: 0.1,
      max_tokens: 1000,
    });

    return response.choices[0].message.content || "I couldn't generate a response.";
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
