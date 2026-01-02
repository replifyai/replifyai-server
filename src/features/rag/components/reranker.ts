/**
 * Reranker Service
 * Implements production-grade reranking techniques:
 * - LLM-based relevance scoring
 * - Multi-criteria scoring (relevance, completeness, specificity)
 * - Deduplication and diversity
 * - Context-aware reranking
 */

import { openai } from "../../../services/llm/openai.js";
import { SearchResult } from "../providers/qdrantHybrid.js";

export interface RankedResult extends SearchResult {
  relevanceScore: number;
  completenessScore: number;
  specificityScore: number;
  finalScore: number;
  rerankedPosition: number;
}

export interface RerankOptions {
  query: string;
  topK?: number; // Return top K results after reranking
  diversityThreshold?: number; // Minimum similarity threshold for diversity
  useMultiCriteria?: boolean; // Use multi-criteria scoring
}

export class Reranker {
  /**
   * Rerank search results based on relevance to query
   */
  async rerank(
    results: SearchResult[],
    options: RerankOptions
  ): Promise<RankedResult[]> {
    const { query, topK = 10, useMultiCriteria = true } = options;

    if (results.length === 0) {
      return [];
    }

    // Step 1: Score each result
    const scoredResults = await this.scoreResults(results, query, useMultiCriteria);

    // Step 2: Remove duplicates and ensure diversity
    const diverseResults = this.ensureDiversity(scoredResults);

    // Step 3: Sort by final score
    diverseResults.sort((a, b) => b.finalScore - a.finalScore);

    // Step 4: Assign reranked positions
    diverseResults.forEach((result, index) => {
      result.rerankedPosition = index + 1;
    });

    // Step 5: Return top K
    const topResults = diverseResults.slice(0, topK);

    return topResults;
  }

  /**
   * Score results using LLM-based relevance assessment
   */
  private async scoreResults(
    results: SearchResult[],
    query: string,
    useMultiCriteria: boolean
  ): Promise<RankedResult[]> {
    const batchSize = 5; // Process in batches to avoid overwhelming the LLM
    const rankedResults: RankedResult[] = [];

    for (let i = 0; i < results.length; i += batchSize) {
      const batch = results.slice(i, i + batchSize);
      const batchScores = await this.scoreBatch(batch, query, useMultiCriteria);
      rankedResults.push(...batchScores);
    }

    return rankedResults;
  }

  /**
   * Score a batch of results
   */
  private async scoreBatch(
    batch: SearchResult[],
    query: string,
    useMultiCriteria: boolean
  ): Promise<RankedResult[]> {
    const systemPrompt = useMultiCriteria
      ? this.getMultiCriteriaPrompt()
      : this.getSimpleRelevancePrompt();

    const chunksText = batch.map((result, idx) => 
      `[CHUNK ${idx}]\nContent: ${result.content.substring(0, 1000)}\nFilename: ${result.filename}\n`
    ).join('\n---\n');

    const userPrompt = `Query: "${query}"\n\nChunks to score:\n${chunksText}`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini', // Use faster model for scoring
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_completion_tokens: 1000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content || '{}';
      const scores = JSON.parse(content);

      return batch.map((result, idx) => {
        const chunkScore = scores[`chunk_${idx}`] || {};
        const relevance = chunkScore.relevance || 0.5;
        const completeness = chunkScore.completeness || 0.5;
        const specificity = chunkScore.specificity || 0.5;

        // Calculate final score (weighted combination)
        const finalScore = useMultiCriteria
          ? (relevance * 0.5 + completeness * 0.3 + specificity * 0.2)
          : relevance;

        return {
          ...result,
          relevanceScore: relevance,
          completenessScore: completeness,
          specificityScore: specificity,
          finalScore,
          rerankedPosition: 0, // Will be assigned later
        };
      });
    } catch (error) {
      console.error('Error scoring batch:', error);
      // Fallback: use original scores
      return batch.map(result => ({
        ...result,
        relevanceScore: result.score,
        completenessScore: result.score,
        specificityScore: result.score,
        finalScore: result.score,
        rerankedPosition: 0,
      }));
    }
  }

  /**
   * Get multi-criteria scoring prompt
   */
  private getMultiCriteriaPrompt(): string {
    return `You are a relevance assessment expert. Score each chunk based on three criteria:

1. **Relevance** (0-1): How relevant is the chunk to the query?
   - 1.0: Directly answers the query
   - 0.7-0.9: Contains related information
   - 0.4-0.6: Tangentially related
   - 0-0.3: Not relevant

2. **Completeness** (0-1): How complete is the information?
   - 1.0: Fully answers the question
   - 0.7-0.9: Mostly complete with minor gaps
   - 0.4-0.6: Partial information
   - 0-0.3: Minimal information
   **IMPORTANT**: Chunks containing product specifications (weight, dimensions, price, material, origin, manufacturer) should score HIGHER on completeness as these are essential details.

3. **Specificity** (0-1): How specific is the information to the query?
   - 1.0: Very specific and detailed (includes exact specifications like weight in grams, exact dimensions)
   - 0.7-0.9: Reasonably specific
   - 0.4-0.6: General information
   - 0-0.3: Very generic

Return JSON:
{
  "chunk_0": {"relevance": 0.9, "completeness": 0.8, "specificity": 0.85},
  "chunk_1": {"relevance": 0.7, "completeness": 0.6, "specificity": 0.7},
  ...
}`;
  }

  /**
   * Get simple relevance scoring prompt
   */
  private getSimpleRelevancePrompt(): string {
    return `You are a relevance assessment expert. Score each chunk based on how relevant it is to the query.

Scoring guide:
- 1.0: Directly answers the query
- 0.7-0.9: Contains related information
- 0.4-0.6: Tangentially related
- 0-0.3: Not relevant

Return JSON:
{
  "chunk_0": {"relevance": 0.9},
  "chunk_1": {"relevance": 0.7},
  ...
}`;
  }

  /**
   * Ensure diversity in results by removing near-duplicates
   */
  private ensureDiversity(results: RankedResult[]): RankedResult[] {
    const diverse: RankedResult[] = [];
    const contentHashes = new Set<string>();

    for (const result of results) {
      // Create a simple hash of the content
      const contentHash = this.simpleHash(result.content);
      
      // Check if we've seen very similar content
      if (!contentHashes.has(contentHash)) {
        diverse.push(result);
        contentHashes.add(contentHash);
      }
    }

    return diverse;
  }

  /**
   * Simple hash function for content similarity
   */
  private simpleHash(content: string): string {
    // Normalize and take first 200 chars as hash
    const normalized = content
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
    return normalized;
  }

  /**
   * Fast reranking using only original scores + simple heuristics
   * (for when LLM-based reranking is too slow)
   */
  fastRerank(
    results: SearchResult[],
    query: string,
    topK: number = 10
  ): RankedResult[] {
    const lowerQuery = query.toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/);

    // Check if this is likely a comparison or specification query
    const isComparisonQuery = ['compare', 'difference', 'vs', 'versus', 'between', 'differentiate'].some(
      term => lowerQuery.includes(term)
    );

    const scored = results.map(result => {
      const content = result.content.toLowerCase();
      
      // Heuristic 1: Keyword overlap bonus
      let keywordBonus = 0;
      for (const token of queryTokens) {
        if (token.length > 3 && content.includes(token)) {
          keywordBonus += 0.05;
        }
      }

      // Heuristic 2: Position bonus (earlier in content is better)
      const firstMatchPosition = queryTokens
        .map(token => content.indexOf(token))
        .filter(pos => pos !== -1)
        .sort((a, b) => a - b)[0];
      
      const positionBonus = firstMatchPosition !== undefined
        ? (1 - Math.min(firstMatchPosition / content.length, 1)) * 0.1
        : 0;

      // Heuristic 3: Exact phrase bonus
      const exactPhraseBonus = content.includes(lowerQuery) ? 0.15 : 0;

      // Heuristic 4: Specification data bonus - boost chunks with product specs
      // This is especially important for comparison queries
      let specificationBonus = 0;
      const specTerms = ['weight', 'gram', ' g ', ' kg ', 'dimension', 'price', 'mrp', '₹', 'material', 'origin', 'manufacturer'];
      for (const term of specTerms) {
        if (content.includes(term)) {
          specificationBonus = isComparisonQuery ? 0.1 : 0.05;
          break;
        }
      }

      const finalScore = Math.min(
        result.score + keywordBonus + positionBonus + exactPhraseBonus + specificationBonus,
        1.0
      );

      return {
        ...result,
        relevanceScore: result.score,
        completenessScore: result.score,
        specificityScore: result.score,
        finalScore,
        rerankedPosition: 0,
      };
    });

    // Sort and assign positions
    scored.sort((a, b) => b.finalScore - a.finalScore);
    scored.forEach((result, index) => {
      result.rerankedPosition = index + 1;
    });

    return scored.slice(0, topK);
  }
}

export const reranker = new Reranker();

