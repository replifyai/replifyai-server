/**
 * Hybrid Chunking Service for On-Demand Document Processing
 * Implements Elysia's approach: search full documents first, then chunk on-demand
 */

import { createEmbedding } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";
import { openai } from "./openai.js";

export interface FullDocumentResult {
  documentId: number;
  filename: string;
  content: string;
  score: number;
  metadata?: any;
  length: number;
}

export interface ChunkingDecision {
  shouldChunk: boolean;
  reason: string;
  strategy?: 'semantic' | 'sliding_window' | 'query_focused';
  targetChunkSize?: number;
}

export interface OnDemandChunk {
  content: string;
  relevanceScore: number;
  startIndex: number;
  endIndex: number;
  metadata?: any;
}

export class HybridChunkingService {
  private readonly MAX_CONTEXT_LENGTH = 4000; // Max tokens for context
  private readonly MIN_RELEVANCE_SCORE = 0.7;
  private readonly CHUNK_OVERLAP = 200; // Characters overlap between chunks

  /**
   * Search with hybrid approach: full documents first, then on-demand chunking
   */
  async searchWithHybridChunking(
    query: string,
    options: {
      retrievalCount?: number;
      similarityThreshold?: number;
      productName?: string;
      maxContextLength?: number;
    } = {}
  ): Promise<any[]> {
    const { 
      retrievalCount = 10, 
      similarityThreshold = 0.65,
      productName = "",
      maxContextLength = this.MAX_CONTEXT_LENGTH
    } = options;

    console.log(`🔍 Hybrid search for: "${query}"`);

    // Step 1: Get full documents from storage
    const allDocuments = await storage.getAllDocuments();
    const relevantDocs = allDocuments.filter(doc => 
      doc.status === 'indexed' && 
      (!productName || doc.metadata?.productName === productName)
    );

    if (relevantDocs.length === 0) {
      console.log("No indexed documents found");
      return [];
    }

    // Step 2: Search full documents using embeddings
    const queryEmbedding = await createEmbedding(query);
    const fullDocResults = await this.searchFullDocuments(
      queryEmbedding,
      relevantDocs,
      retrievalCount * 2 // Get more candidates
    );

    console.log(`📄 Found ${fullDocResults.length} relevant full documents`);

    // Step 3: Make chunking decisions for each document
    const results: any[] = [];
    let totalContextUsed = 0;

    for (const docResult of fullDocResults) {
      if (totalContextUsed >= maxContextLength) break;

      const decision = this.makeChunkingDecision(
        docResult,
        query,
        maxContextLength - totalContextUsed
      );

      console.log(`📊 Document "${docResult.filename}": ${decision.shouldChunk ? 'Will chunk' : 'Use full'} - ${decision.reason}`);

      if (decision.shouldChunk) {
        // Chunk on-demand based on query
        const chunks = await this.chunkOnDemand(
          docResult,
          query,
          decision
        );

        // Add top chunks until context limit
        for (const chunk of chunks) {
          if (totalContextUsed + chunk.content.length > maxContextLength) break;
          
          results.push({
            documentId: docResult.documentId,
            filename: docResult.filename,
            content: chunk.content,
            score: chunk.relevanceScore,
            metadata: {
              ...docResult.metadata,
              chunkStart: chunk.startIndex,
              chunkEnd: chunk.endIndex,
              isChunked: true
            }
          });
          
          totalContextUsed += chunk.content.length;
        }
      } else {
        // Use full document if it fits
        if (totalContextUsed + docResult.content.length <= maxContextLength) {
          results.push({
            ...docResult,
            metadata: {
              ...docResult.metadata,
              isChunked: false
            }
          });
          totalContextUsed += docResult.content.length;
        }
      }
    }

    console.log(`✅ Hybrid search complete: ${results.length} results, ${totalContextUsed} chars used`);
    return results;
  }

  /**
   * Search full documents without chunking
   */
  private async searchFullDocuments(
    queryEmbedding: number[],
    documents: any[],
    limit: number
  ): Promise<FullDocumentResult[]> {
    const results: FullDocumentResult[] = [];

    for (const doc of documents) {
      // Get document content
      const content = doc.content || '';
      if (!content) continue;

      // Create embedding for full document (or use cached if available)
      const docEmbedding = await this.getOrCreateDocumentEmbedding(doc);
      
      // Calculate similarity
      const score = this.cosineSimilarity(queryEmbedding, docEmbedding);
      
      results.push({
        documentId: doc.id,
        filename: doc.filename,
        content,
        score,
        metadata: doc.metadata,
        length: content.length
      });
    }

    // Sort by score and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Decide whether to chunk a document based on various factors
   */
  private makeChunkingDecision(
    doc: FullDocumentResult,
    query: string,
    remainingContext: number
  ): ChunkingDecision {
    // Factor 1: Document length
    if (doc.length <= 1000) {
      return { shouldChunk: false, reason: 'Document is short enough to use in full' };
    }

    // Factor 2: Relevance score
    if (doc.score < this.MIN_RELEVANCE_SCORE) {
      return { shouldChunk: false, reason: 'Document relevance too low for chunking' };
    }

    // Factor 3: Document fits in remaining context
    if (doc.length <= remainingContext) {
      return { shouldChunk: false, reason: 'Document fits in remaining context' };
    }

    // Factor 4: Query type analysis
    const queryAnalysis = this.analyzeQueryType(query);
    
    if (queryAnalysis.isSpecific) {
      return {
        shouldChunk: true,
        reason: 'Specific query requires focused chunks',
        strategy: 'query_focused',
        targetChunkSize: 800
      };
    }

    if (queryAnalysis.requiresContext) {
      return {
        shouldChunk: true,
        reason: 'Query requires semantic context',
        strategy: 'semantic',
        targetChunkSize: 1200
      };
    }

    // Default: sliding window for general queries
    return {
      shouldChunk: true,
      reason: 'Document too long for full inclusion',
      strategy: 'sliding_window',
      targetChunkSize: 1000
    };
  }

  /**
   * Chunk document on-demand based on query and strategy
   */
  private async chunkOnDemand(
    doc: FullDocumentResult,
    query: string,
    decision: ChunkingDecision
  ): Promise<OnDemandChunk[]> {
    switch (decision.strategy) {
      case 'query_focused':
        return this.queryFocusedChunking(doc, query, decision.targetChunkSize!);
      
      case 'semantic':
        return this.semanticChunking(doc, query, decision.targetChunkSize!);
      
      case 'sliding_window':
      default:
        return this.slidingWindowChunking(doc, query, decision.targetChunkSize!);
    }
  }

  /**
   * Query-focused chunking: Extract chunks most relevant to the query
   */
  private async queryFocusedChunking(
    doc: FullDocumentResult,
    query: string,
    targetSize: number
  ): Promise<OnDemandChunk[]> {
    const chunks: OnDemandChunk[] = [];
    const sentences = this.splitIntoSentences(doc.content);
    const queryTerms = query.toLowerCase().split(/\s+/);

    // Score each sentence based on query relevance
    const scoredSentences = sentences.map((sentence, index) => {
      const text = sentence.toLowerCase();
      let score = 0;
      
      // Term frequency
      queryTerms.forEach(term => {
        if (text.includes(term)) score += 1;
      });
      
      // Boost for exact phrase matches
      if (text.includes(query.toLowerCase())) score += 5;
      
      return { sentence, index, score, startIndex: 0, endIndex: sentence.length };
    });

    // Sort by score and create chunks around high-scoring sentences
    scoredSentences.sort((a, b) => b.score - a.score);
    
    const used = new Set<number>();
    
    for (const scored of scoredSentences) {
      if (scored.score === 0) break;
      if (used.has(scored.index)) continue;
      
      // Build chunk around this sentence
      let chunkText = scored.sentence;
      let startIdx = scored.index;
      let endIdx = scored.index;
      
      // Add surrounding sentences until target size
      while (chunkText.length < targetSize) {
        if (startIdx > 0 && !used.has(startIdx - 1)) {
          startIdx--;
          chunkText = sentences[startIdx] + ' ' + chunkText;
        }
        
        if (endIdx < sentences.length - 1 && !used.has(endIdx + 1)) {
          endIdx++;
          chunkText = chunkText + ' ' + sentences[endIdx];
        }
        
        if (startIdx === 0 && endIdx === sentences.length - 1) break;
      }
      
      // Mark sentences as used
      for (let i = startIdx; i <= endIdx; i++) {
        used.add(i);
      }
      
      chunks.push({
        content: chunkText.trim(),
        relevanceScore: scored.score / queryTerms.length,
        startIndex: this.getCharIndex(sentences, startIdx),
        endIndex: this.getCharIndex(sentences, endIdx + 1)
      });
    }
    
    return chunks.slice(0, 5); // Return top 5 chunks
  }

  /**
   * Semantic chunking: Use AI to identify semantic boundaries
   */
  private async semanticChunking(
    doc: FullDocumentResult,
    query: string,
    targetSize: number
  ): Promise<OnDemandChunk[]> {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a document chunking expert. Given a document and a query, identify the most relevant semantic chunks.
Each chunk should:
1. Be self-contained and make sense independently
2. Be relevant to the query
3. Be approximately ${targetSize} characters
4. Not break in the middle of important information

Return JSON array of chunks with structure:
[{
  "content": "chunk text",
  "relevance": 0.0-1.0,
  "reason": "why this chunk is relevant"
}]`
          },
          {
            role: "user",
            content: `Query: ${query}\n\nDocument:\n${doc.content.substring(0, 8000)}`
          }
        ],
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0]?.message?.content || '{"chunks":[]}');
      
      return (result.chunks || []).map((chunk: any, index: number) => ({
        content: chunk.content,
        relevanceScore: chunk.relevance || 0.5,
        startIndex: doc.content.indexOf(chunk.content),
        endIndex: doc.content.indexOf(chunk.content) + chunk.content.length,
        metadata: { reason: chunk.reason }
      }));
    } catch (error) {
      console.error("Semantic chunking failed, falling back to sliding window:", error);
      return this.slidingWindowChunking(doc, query, targetSize);
    }
  }

  /**
   * Sliding window chunking: Simple overlapping chunks
   */
  private slidingWindowChunking(
    doc: FullDocumentResult,
    query: string,
    targetSize: number
  ): OnDemandChunk[] {
    const chunks: OnDemandChunk[] = [];
    const stride = targetSize - this.CHUNK_OVERLAP;
    
    for (let i = 0; i < doc.content.length; i += stride) {
      const chunk = doc.content.substring(i, i + targetSize);
      
      // Score chunk relevance to query
      const relevance = this.calculateChunkRelevance(chunk, query);
      
      chunks.push({
        content: chunk,
        relevanceScore: relevance,
        startIndex: i,
        endIndex: Math.min(i + targetSize, doc.content.length)
      });
    }
    
    // Sort by relevance and return top chunks
    return chunks
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 5);
  }

  /**
   * Helper methods
   */
  private async getOrCreateDocumentEmbedding(doc: any): Promise<number[]> {
    // In a real implementation, cache embeddings in the database
    // For now, create on-demand
    const text = doc.content.substring(0, 8000); // Limit for embedding
    return createEmbedding(text);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private analyzeQueryType(query: string): {
    isSpecific: boolean;
    requiresContext: boolean;
  } {
    const specific = /what is|how to|where|when|specific|exact|precise/i.test(query);
    const contextual = /explain|describe|overview|summary|compare|relationship/i.test(query);
    
    return {
      isSpecific: specific,
      requiresContext: contextual
    };
  }

  private splitIntoSentences(text: string): string[] {
    // Simple sentence splitting (can be improved with NLP library)
    return text.match(/[^.!?]+[.!?]+/g) || [text];
  }

  private calculateChunkRelevance(chunk: string, query: string): number {
    const chunkLower = chunk.toLowerCase();
    const queryTerms = query.toLowerCase().split(/\s+/);
    
    let score = 0;
    queryTerms.forEach(term => {
      if (chunkLower.includes(term)) score += 1;
    });
    
    return score / queryTerms.length;
  }

  private getCharIndex(sentences: string[], sentenceIndex: number): number {
    let charIndex = 0;
    for (let i = 0; i < sentenceIndex && i < sentences.length; i++) {
      charIndex += sentences[i].length + 1; // +1 for space
    }
    return charIndex;
  }
}

export const hybridChunkingService = new HybridChunkingService();