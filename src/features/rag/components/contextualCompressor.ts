/**
 * Contextual Compressor
 * Implements production-grade context compression:
 * - Extracts only relevant sentences from chunks
 * - Removes redundant information
 * - Preserves semantic meaning
 * - Reduces token usage while maintaining quality
 */

import { openai } from "../../../services/llm/openai.js";
import { RankedResult } from "./reranker.js";

export interface CompressedChunk {
  originalChunkId: number;
  originalContent: string;
  compressedContent: string;
  compressionRatio: number;
  extractedSentences: string[];
  relevanceScore: number;
  metadata?: any;
}

export interface CompressionOptions {
  query: string;
  maxTokensPerChunk?: number;
  preserveMetadata?: boolean;
  aggressiveCompression?: boolean;
}

export class ContextualCompressor {
  /**
   * Compress chunks to only relevant information
   */
  async compress(
    chunks: RankedResult[],
    options: CompressionOptions
  ): Promise<CompressedChunk[]> {
    const { query, maxTokensPerChunk = 300, preserveMetadata = true, aggressiveCompression = false } = options;

    if (chunks.length === 0) {
      return [];
    }

    const compressed: CompressedChunk[] = [];

    // Process chunks in batches for efficiency
    const batchSize = 3;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchCompressed = await this.compressBatch(
        batch,
        query,
        maxTokensPerChunk,
        aggressiveCompression
      );
      compressed.push(...batchCompressed);
    }

    return compressed;
  }

  /**
   * Compress a batch of chunks
   */
  private async compressBatch(
    batch: RankedResult[],
    query: string,
    maxTokens: number,
    aggressive: boolean
  ): Promise<CompressedChunk[]> {
    const systemPrompt = this.getCompressionPrompt(aggressive);

    const chunksText = batch.map((chunk, idx) => 
      `[CHUNK ${idx}]\n${chunk.content}\n`
    ).join('\n---\n');

    const userPrompt = `Query: "${query}"\n\nMax tokens per chunk: ${maxTokens}\n\nChunks to compress:\n${chunksText}`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_completion_tokens: maxTokens * batch.length,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content || '{}';
      const compressionResult = JSON.parse(content);

      return batch.map((chunk, idx) => {
        const compressedData = compressionResult[`chunk_${idx}`] || {};
        const compressedContent = compressedData.compressed || chunk.content;
        const extractedSentences = compressedData.sentences || [chunk.content];

        return {
          originalChunkId: chunk.chunkId,
          originalContent: chunk.content,
          compressedContent,
          compressionRatio: compressedContent.length / chunk.content.length,
          extractedSentences,
          relevanceScore: chunk.relevanceScore,
          metadata: chunk.metadata,
        };
      });
    } catch (error) {
      console.error('Error compressing batch:', error);
      // Fallback: return original chunks
      return batch.map(chunk => ({
        originalChunkId: chunk.chunkId,
        originalContent: chunk.content,
        compressedContent: chunk.content,
        compressionRatio: 1.0,
        extractedSentences: [chunk.content],
        relevanceScore: chunk.relevanceScore,
        metadata: chunk.metadata,
      }));
    }
  }

  /**
   * Get compression prompt
   */
  private getCompressionPrompt(aggressive: boolean): string {
    if (aggressive) {
      return `You are a context compression expert. Your task is to extract ONLY the most relevant sentences from each chunk that directly answer or relate to the query.

Instructions:
1. Read each chunk carefully
2. Identify sentences that are directly relevant to the query
3. Extract ONLY those sentences (be very selective)
4. Combine extracted sentences into a compressed version
5. Remove any redundant or tangential information
6. Preserve factual accuracy and key details

Return JSON:
{
  "chunk_0": {
    "compressed": "compressed text with only relevant parts",
    "sentences": ["sentence 1", "sentence 2"]
  },
  "chunk_1": {
    "compressed": "compressed text",
    "sentences": ["sentence 1"]
  },
  ...
}`;
    }

    return `You are a context compression expert. Your task is to extract relevant information from each chunk while preserving important context.

Instructions:
1. Read each chunk carefully
2. Identify sentences that relate to the query
3. Keep supporting context that helps understand the main information
4. Remove only clearly irrelevant information
5. Preserve factual accuracy and key details
6. **CRITICAL**: ALWAYS preserve product specifications like:
   - Weight (g, kg, oz, lb)
   - Dimensions (cm, inches, mm)
   - Price/MRP/Cost
   - Material composition
   - Country of origin
   - Manufacturer details
   - Model numbers/SKUs
   These specifications are often essential for product comparisons and must NEVER be removed.

Return JSON:
{
  "chunk_0": {
    "compressed": "compressed text preserving relevant info and context",
    "sentences": ["sentence 1", "sentence 2", "sentence 3"]
  },
  "chunk_1": {
    "compressed": "compressed text",
    "sentences": ["sentence 1", "sentence 2"]
  },
  ...
}`;
  }

  /**
   * Fast compression using simple heuristics (no LLM)
   */
  fastCompress(
    chunks: RankedResult[],
    query: string,
    maxTokensPerChunk: number = 300
  ): CompressedChunk[] {
    const lowerQuery = query.toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/).filter(t => t.length > 3);

    return chunks.map(chunk => {
      const sentences = this.splitIntoSentences(chunk.content);
      const scoredSentences = sentences.map(sentence => ({
        sentence,
        score: this.scoreSentence(sentence, queryTokens),
      }));

      // Sort by score and take top sentences
      scoredSentences.sort((a, b) => b.score - a.score);
      
      const selectedSentences: string[] = [];
      let currentTokens = 0;
      const estimatedTokensPerChar = 0.25; // Rough estimate

      for (const { sentence, score } of scoredSentences) {
        const sentenceTokens = Math.ceil(sentence.length * estimatedTokensPerChar);
        if (currentTokens + sentenceTokens <= maxTokensPerChunk && score > 0) {
          selectedSentences.push(sentence);
          currentTokens += sentenceTokens;
        }
      }

      const compressedContent = selectedSentences.join(' ');

      return {
        originalChunkId: chunk.chunkId,
        originalContent: chunk.content,
        compressedContent: compressedContent || chunk.content.substring(0, 500),
        compressionRatio: compressedContent.length / chunk.content.length,
        extractedSentences: selectedSentences,
        relevanceScore: chunk.relevanceScore,
        metadata: chunk.metadata,
      };
    });
  }

  /**
   * Split text into sentences
   */
  private splitIntoSentences(text: string): string[] {
    return text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10); // Filter out very short fragments
  }

  /**
   * Score a sentence based on query tokens
   */
  private scoreSentence(sentence: string, queryTokens: string[]): number {
    const lowerSentence = sentence.toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      if (lowerSentence.includes(token)) {
        score += 1;
      }
    }

    // Bonus for sentence length (prefer informative sentences)
    if (sentence.length > 50 && sentence.length < 300) {
      score += 0.5;
    }

    // HIGH PRIORITY: Boost sentences containing product specifications
    // These are critical for product comparisons and should never be dropped
    const specificationTerms = [
      'weight', 'gram', 'kg', 'oz', 'lb',
      'dimension', 'size', 'cm', 'inch', 'mm',
      'price', 'mrp', 'cost', '₹', '$', 'rs',
      'material', 'made of', 'composition', 'fabric',
      'country', 'origin', 'manufactured', 'manufacturer',
      'model', 'sku', 'variant', 'color', 'colour'
    ];
    
    for (const term of specificationTerms) {
      if (lowerSentence.includes(term)) {
        score += 2; // High boost for specification sentences
        break; // Only count once
      }
    }

    return score;
  }

  /**
   * Calculate average compression ratio
   */
  private calculateAverageCompression(compressed: CompressedChunk[]): number {
    if (compressed.length === 0) return 1.0;
    
    const sum = compressed.reduce((acc, chunk) => acc + chunk.compressionRatio, 0);
    return sum / compressed.length;
  }

  /**
   * Merge compressed chunks into a single context string
   */
  mergeCompressedChunks(compressed: CompressedChunk[], query: string): string {
    if (compressed.length === 0) return '';

    const contextParts = compressed.map((chunk, idx) => {
      return `[Source ${idx + 1}]\n${chunk.compressedContent}`;
    });

    return contextParts.join('\n\n---\n\n');
  }
}

export const contextualCompressor = new ContextualCompressor();

