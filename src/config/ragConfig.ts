/**
 * RAG Configuration Presets
 * 
 * Provides optimized configuration presets for different use cases
 */

import { EnhancedRAGOptions } from "../features/rag/core/enhancedRAG.js";

export type RAGPerformanceMode = 'fast' | 'balanced' | 'accurate';

/**
 * Performance mode configurations
 * 
 * FAST Mode: ~3-4s response time
 * - Best for: Simple queries, product lookups, quick answers
 * - Trade-off: Lower accuracy for speed
 * 
 * BALANCED Mode: ~6-7s response time (NEW DEFAULT)
 * - Best for: Most queries, good balance of speed and accuracy
 * - Trade-off: Balanced performance
 * 
 * ACCURATE Mode: ~9-10s response time
 * - Best for: Complex comparisons, detailed analysis, critical queries
 * - Trade-off: Higher latency for maximum accuracy
 */
export const RAG_PERFORMANCE_PRESETS: Record<RAGPerformanceMode, Partial<EnhancedRAGOptions>> = {
  /**
   * ⚡ FAST Mode
   * Target: 3-4s total time
   * 
   * Optimizations:
   * - Fast reranking (no LLM)
   * - Reduced queries (2 instead of 3)
   * - Fewer chunks (10 instead of 20)
   * - No compression
   * - gpt-4o-mini for expansion (already applied)
   * - Parallel LLM calls (already applied)
   */
  fast: {
    retrievalCount: 10,
    similarityThreshold: 0.5,
    useReranking: false,      // Use heuristic-based reranking
    useCompression: false,    // Skip compression for speed
    useMultiQuery: true,      // Still use multi-query for recall
    maxQueries: 2,           // Reduced from 3 to 2
    finalChunkCount: 10,     // Reduced from 20 to 10
  },

  /**
   * ⚖️ BALANCED Mode (DEFAULT)
   * Target: 6-7s total time
   * 
   * Optimizations:
   * - Smart reranking (fast for simple, LLM for complex)
   * - Standard queries (2)
   * - Moderate chunks (12)
   * - No compression
   * - gpt-4o-mini for expansion
   * - Parallel LLM calls
   */
  balanced: {
    retrievalCount: 10,
    similarityThreshold: 0.5,
    useReranking: true,       // Smart adaptive reranking
    useCompression: false,    // Skip for balance
    useMultiQuery: true,      
    maxQueries: 2,           // Optimal balance (was 5)
    finalChunkCount: 12,     // Moderate (was 20)
  },

  /**
   * 🎯 ACCURATE Mode
   * Target: 9-10s total time
   * 
   * Focus: Maximum accuracy
   * - Full LLM reranking
   * - More queries (3)
   * - More chunks (20)
   * - Compression for quality
   */
  accurate: {
    retrievalCount: 15,
    similarityThreshold: 0.5,
    useReranking: true,       // Always use LLM reranking
    useCompression: true,     // Use compression for quality
    useMultiQuery: true,      
    maxQueries: 3,           // More queries for better recall
    finalChunkCount: 20,     // More chunks for comprehensive answers
  },
};

/**
 * Get configuration for a performance mode
 */
export function getRAGConfig(mode: RAGPerformanceMode = 'balanced'): Partial<EnhancedRAGOptions> {
  return RAG_PERFORMANCE_PRESETS[mode];
}

/**
 * Merge user options with preset
 */
export function mergeWithPreset(
  mode: RAGPerformanceMode,
  userOptions: Partial<EnhancedRAGOptions> = {}
): EnhancedRAGOptions {
  const preset = getRAGConfig(mode);
  
  return {
    ...preset,
    ...userOptions,
    // Ensure critical options from user take precedence
  } as EnhancedRAGOptions;
}

/**
 * Get recommended mode based on query characteristics
 */
export function recommendMode(query: string, options?: {
  isComparison?: boolean;
  isComplex?: boolean;
  requiresAccuracy?: boolean;
}): RAGPerformanceMode {
  const {
    isComparison = false,
    isComplex = false,
    requiresAccuracy = false,
  } = options || {};

  // Accurate mode for critical queries
  if (requiresAccuracy || isComparison) {
    return 'accurate';
  }

  // Fast mode for simple queries
  const lowerQuery = query.toLowerCase();
  const isSimpleQuery = 
    query.length < 50 && 
    !lowerQuery.includes('compare') &&
    !lowerQuery.includes('difference') &&
    !isComplex;

  if (isSimpleQuery) {
    return 'fast';
  }

  // Default to balanced
  return 'balanced';
}

/**
 * Performance metrics expectations
 */
export const PERFORMANCE_EXPECTATIONS = {
  fast: {
    targetTime: 4000,        // 4s
    maxTime: 5000,           // 5s
    accuracyTarget: 0.85,    // 85% accuracy
  },
  balanced: {
    targetTime: 6500,        // 6.5s
    maxTime: 8000,           // 8s
    accuracyTarget: 0.95,    // 95% accuracy
  },
  accurate: {
    targetTime: 9500,        // 9.5s
    maxTime: 12000,          // 12s
    accuracyTarget: 0.99,    // 99% accuracy
  },
} as const;

/**
 * Export for easy access
 */
export const RAGConfig = {
  presets: RAG_PERFORMANCE_PRESETS,
  get: getRAGConfig,
  merge: mergeWithPreset,
  recommend: recommendMode,
  expectations: PERFORMANCE_EXPECTATIONS,
} as const;
