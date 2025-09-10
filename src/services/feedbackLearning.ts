/**
 * Feedback Learning Service for Continuous Improvement
 * Implements Elysia's approach to learn from user feedback
 */

import { storage } from "../storage.js";
import { createEmbedding } from "./openai.js";

export interface FeedbackData {
  id?: string;
  query: string;
  response: string;
  sources: any[];
  userFeedback: 'helpful' | 'not_helpful';
  timestamp: Date;
  sessionContext?: {
    productName?: string;
    userId?: string;
    sessionId?: string;
  };
  metadata?: {
    decisionPath?: any[];
    modelUsed?: string;
    responseTime?: number;
    ragUsed?: boolean;
  };
}

export interface FeedbackPattern {
  pattern: string;
  successRate: number;
  examples: FeedbackData[];
  embedding?: number[];
}

export interface LearningInsight {
  type: 'query_pattern' | 'response_style' | 'source_relevance' | 'model_performance';
  insight: string;
  confidence: number;
  recommendations: string[];
}

export class FeedbackLearningService {
  private feedbackCache: Map<string, FeedbackData> = new Map();
  private patterns: Map<string, FeedbackPattern> = new Map();
  private readonly MIN_PATTERN_EXAMPLES = 3;
  private readonly SIMILARITY_THRESHOLD = 0.85;

  /**
   * Record user feedback for a query-response pair
   */
  async recordFeedback(feedback: FeedbackData): Promise<void> {
    const id = feedback.id || this.generateId();
    const enrichedFeedback: FeedbackData = {
      ...feedback,
      id,
      timestamp: feedback.timestamp || new Date()
    };

    // Store in cache
    this.feedbackCache.set(id, enrichedFeedback);

    // Persist to storage (in real implementation)
    await this.persistFeedback(enrichedFeedback);

    // Update patterns if feedback is helpful
    if (feedback.userFeedback === 'helpful') {
      await this.updatePatterns(enrichedFeedback);
    }

    // Analyze for insights
    await this.analyzeForInsights(enrichedFeedback);

    console.log(`📝 Feedback recorded: ${feedback.userFeedback} for query "${feedback.query.substring(0, 50)}..."`);
  }

  /**
   * Get successful patterns similar to a query
   */
  async getSuccessfulPatterns(query: string, limit: number = 5): Promise<FeedbackPattern[]> {
    const queryEmbedding = await createEmbedding(query);
    const similarPatterns: Array<{ pattern: FeedbackPattern; similarity: number }> = [];

    for (const pattern of this.patterns.values()) {
      if (!pattern.embedding || pattern.successRate < 0.7) continue;

      const similarity = this.cosineSimilarity(queryEmbedding, pattern.embedding);
      if (similarity > this.SIMILARITY_THRESHOLD) {
        similarPatterns.push({ pattern, similarity });
      }
    }

    return similarPatterns
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(p => p.pattern);
  }

  /**
   * Get learning insights from feedback data
   */
  async getLearningInsights(): Promise<LearningInsight[]> {
    const insights: LearningInsight[] = [];
    const feedbackArray = Array.from(this.feedbackCache.values());

    // Analyze query patterns
    const queryInsights = this.analyzeQueryPatterns(feedbackArray);
    insights.push(...queryInsights);

    // Analyze response effectiveness
    const responseInsights = this.analyzeResponseEffectiveness(feedbackArray);
    insights.push(...responseInsights);

    // Analyze source relevance
    const sourceInsights = this.analyzeSourceRelevance(feedbackArray);
    insights.push(...sourceInsights);

    // Analyze model performance
    const modelInsights = this.analyzeModelPerformance(feedbackArray);
    insights.push(...modelInsights);

    return insights;
  }

  /**
   * Get recommendations for a new query based on past feedback
   */
  async getQueryRecommendations(query: string): Promise<{
    suggestedApproach?: 'rag' | 'direct' | 'hybrid';
    suggestedModel?: string;
    suggestedSources?: string[];
    confidence: number;
  }> {
    const patterns = await this.getSuccessfulPatterns(query);
    
    if (patterns.length === 0) {
      return { confidence: 0 };
    }

    // Aggregate recommendations from successful patterns
    const approaches = new Map<string, number>();
    const models = new Map<string, number>();
    const sources = new Map<string, number>();

    patterns.forEach(pattern => {
      pattern.examples.forEach(example => {
        // Count approaches
        const approach = example.metadata?.ragUsed ? 'rag' : 'direct';
        approaches.set(approach, (approaches.get(approach) || 0) + 1);

        // Count models
        if (example.metadata?.modelUsed) {
          models.set(example.metadata.modelUsed, (models.get(example.metadata.modelUsed) || 0) + 1);
        }

        // Count sources
        example.sources?.forEach(source => {
          if (source.filename) {
            sources.set(source.filename, (sources.get(source.filename) || 0) + 1);
          }
        });
      });
    });

    // Find most successful approach
    const suggestedApproach = this.getMostFrequent(approaches) as 'rag' | 'direct' | 'hybrid' | undefined;
    const suggestedModel = this.getMostFrequent(models);
    const suggestedSources = Array.from(sources.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([source]) => source);

    const confidence = patterns[0].successRate;

    return {
      suggestedApproach,
      suggestedModel,
      suggestedSources: suggestedSources.length > 0 ? suggestedSources : undefined,
      confidence
    };
  }

  /**
   * Improve response based on feedback patterns
   */
  async improveResponse(
    originalResponse: string,
    query: string,
    feedback: FeedbackData[]
  ): Promise<string> {
    const helpfulResponses = feedback
      .filter(f => f.userFeedback === 'helpful' && this.isSimilarQuery(f.query, query))
      .map(f => f.response);

    if (helpfulResponses.length === 0) {
      return originalResponse;
    }

    // Extract successful patterns from helpful responses
    const successPatterns = this.extractResponsePatterns(helpfulResponses);

    // Apply patterns to improve the response
    let improvedResponse = originalResponse;

    // Add successful phrases
    successPatterns.phrases.forEach(phrase => {
      if (!improvedResponse.includes(phrase) && Math.random() > 0.5) {
        improvedResponse = this.incorporatePhrase(improvedResponse, phrase);
      }
    });

    // Adjust tone based on successful responses
    if (successPatterns.tone) {
      improvedResponse = this.adjustTone(improvedResponse, successPatterns.tone);
    }

    return improvedResponse;
  }

  /**
   * Private helper methods
   */
  private async updatePatterns(feedback: FeedbackData): void {
    const patternKey = this.extractPatternKey(feedback.query);
    
    let pattern = this.patterns.get(patternKey);
    if (!pattern) {
      pattern = {
        pattern: patternKey,
        successRate: 0,
        examples: [],
        embedding: await createEmbedding(patternKey)
      };
      this.patterns.set(patternKey, pattern);
    }

    pattern.examples.push(feedback);
    
    // Recalculate success rate
    const helpfulCount = pattern.examples.filter(e => e.userFeedback === 'helpful').length;
    pattern.successRate = helpfulCount / pattern.examples.length;

    // Keep only recent examples (last 20)
    if (pattern.examples.length > 20) {
      pattern.examples = pattern.examples.slice(-20);
    }
  }

  private analyzeQueryPatterns(feedback: FeedbackData[]): LearningInsight[] {
    const insights: LearningInsight[] = [];
    
    // Group by query type
    const queryTypes = new Map<string, { helpful: number; total: number }>();
    
    feedback.forEach(f => {
      const type = this.classifyQueryType(f.query);
      const stats = queryTypes.get(type) || { helpful: 0, total: 0 };
      stats.total++;
      if (f.userFeedback === 'helpful') stats.helpful++;
      queryTypes.set(type, stats);
    });

    // Generate insights
    queryTypes.forEach((stats, type) => {
      const successRate = stats.helpful / stats.total;
      
      if (stats.total >= this.MIN_PATTERN_EXAMPLES) {
        if (successRate < 0.5) {
          insights.push({
            type: 'query_pattern',
            insight: `Poor performance on ${type} queries (${Math.round(successRate * 100)}% success rate)`,
            confidence: Math.min(stats.total / 10, 1),
            recommendations: [
              `Improve training data for ${type} queries`,
              `Consider specialized handling for ${type} queries`,
              `Review failed ${type} query examples`
            ]
          });
        } else if (successRate > 0.8) {
          insights.push({
            type: 'query_pattern',
            insight: `Excellent performance on ${type} queries (${Math.round(successRate * 100)}% success rate)`,
            confidence: Math.min(stats.total / 10, 1),
            recommendations: [
              `Use ${type} query handling as a model for other types`,
              `Document successful ${type} patterns`
            ]
          });
        }
      }
    });

    return insights;
  }

  private analyzeResponseEffectiveness(feedback: FeedbackData[]): LearningInsight[] {
    const insights: LearningInsight[] = [];
    
    // Analyze response length correlation
    const helpful = feedback.filter(f => f.userFeedback === 'helpful');
    const notHelpful = feedback.filter(f => f.userFeedback === 'not_helpful');
    
    if (helpful.length > 5 && notHelpful.length > 5) {
      const avgHelpfulLength = helpful.reduce((sum, f) => sum + f.response.length, 0) / helpful.length;
      const avgNotHelpfulLength = notHelpful.reduce((sum, f) => sum + f.response.length, 0) / notHelpful.length;
      
      if (Math.abs(avgHelpfulLength - avgNotHelpfulLength) > 100) {
        insights.push({
          type: 'response_style',
          insight: avgHelpfulLength > avgNotHelpfulLength 
            ? 'Longer, more detailed responses tend to be more helpful'
            : 'Concise responses tend to be more helpful',
          confidence: 0.7,
          recommendations: [
            `Target response length around ${Math.round(avgHelpfulLength)} characters`,
            'Analyze successful response structures'
          ]
        });
      }
    }

    return insights;
  }

  private analyzeSourceRelevance(feedback: FeedbackData[]): LearningInsight[] {
    const insights: LearningInsight[] = [];
    
    // Track source effectiveness
    const sourceStats = new Map<string, { helpful: number; total: number }>();
    
    feedback.forEach(f => {
      f.sources?.forEach(source => {
        const key = source.filename || 'unknown';
        const stats = sourceStats.get(key) || { helpful: 0, total: 0 };
        stats.total++;
        if (f.userFeedback === 'helpful') stats.helpful++;
        sourceStats.set(key, stats);
      });
    });

    // Generate insights about source effectiveness
    sourceStats.forEach((stats, source) => {
      if (stats.total >= 5) {
        const effectiveness = stats.helpful / stats.total;
        
        if (effectiveness < 0.3) {
          insights.push({
            type: 'source_relevance',
            insight: `Source "${source}" rarely contributes to helpful responses`,
            confidence: Math.min(stats.total / 10, 1),
            recommendations: [
              `Review content quality of "${source}"`,
              `Consider re-indexing or removing "${source}"`,
              `Improve chunking strategy for "${source}"`
            ]
          });
        }
      }
    });

    return insights;
  }

  private analyzeModelPerformance(feedback: FeedbackData[]): LearningInsight[] {
    const insights: LearningInsight[] = [];
    
    // Group by model
    const modelStats = new Map<string, { helpful: number; total: number; avgTime: number }>();
    
    feedback.forEach(f => {
      const model = f.metadata?.modelUsed || 'unknown';
      const stats = modelStats.get(model) || { helpful: 0, total: 0, avgTime: 0 };
      stats.total++;
      if (f.userFeedback === 'helpful') stats.helpful++;
      if (f.metadata?.responseTime) {
        stats.avgTime = (stats.avgTime * (stats.total - 1) + f.metadata.responseTime) / stats.total;
      }
      modelStats.set(model, stats);
    });

    // Generate model performance insights
    modelStats.forEach((stats, model) => {
      if (stats.total >= 5) {
        const successRate = stats.helpful / stats.total;
        
        insights.push({
          type: 'model_performance',
          insight: `Model "${model}": ${Math.round(successRate * 100)}% success rate, ${Math.round(stats.avgTime)}ms avg response time`,
          confidence: Math.min(stats.total / 20, 1),
          recommendations: successRate < 0.6 
            ? [`Consider using alternative models instead of "${model}" for better results`]
            : [`"${model}" is performing well, consider using it more frequently`]
        });
      }
    });

    return insights;
  }

  private extractPatternKey(query: string): string {
    // Simple pattern extraction - can be improved with NLP
    const normalized = query.toLowerCase().trim();
    const words = normalized.split(/\s+/);
    
    // Extract key terms
    const keyTerms = words.filter(w => 
      w.length > 3 && 
      !['what', 'when', 'where', 'how', 'why', 'which', 'the', 'and', 'or'].includes(w)
    );
    
    return keyTerms.slice(0, 3).join('_');
  }

  private classifyQueryType(query: string): string {
    const lower = query.toLowerCase();
    
    if (lower.includes('how') || lower.includes('guide')) return 'how_to';
    if (lower.includes('what') || lower.includes('define')) return 'definition';
    if (lower.includes('why') || lower.includes('reason')) return 'explanation';
    if (lower.includes('compare') || lower.includes('vs')) return 'comparison';
    if (lower.includes('price') || lower.includes('cost')) return 'pricing';
    if (lower.includes('error') || lower.includes('fix')) return 'troubleshooting';
    
    return 'general';
  }

  private isSimilarQuery(query1: string, query2: string): boolean {
    // Simple similarity check - can be improved with embeddings
    const words1 = new Set(query1.toLowerCase().split(/\s+/));
    const words2 = new Set(query2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size > 0.5;
  }

  private extractResponsePatterns(responses: string[]): {
    phrases: string[];
    tone?: string;
  } {
    // Extract common successful phrases
    const phrases: string[] = [];
    const commonPhrases = new Map<string, number>();
    
    responses.forEach(response => {
      // Extract phrases (simple approach)
      const sentences = response.match(/[^.!?]+[.!?]+/g) || [];
      sentences.forEach(sentence => {
        if (sentence.length > 20 && sentence.length < 100) {
          commonPhrases.set(sentence.trim(), (commonPhrases.get(sentence.trim()) || 0) + 1);
        }
      });
    });
    
    // Get frequently used phrases
    commonPhrases.forEach((count, phrase) => {
      if (count >= 2) phrases.push(phrase);
    });
    
    return { phrases: phrases.slice(0, 5) };
  }

  private incorporatePhrase(response: string, phrase: string): string {
    // Simple incorporation - add to end if not present
    if (!response.includes(phrase)) {
      return response + ' ' + phrase;
    }
    return response;
  }

  private adjustTone(response: string, targetTone: string): string {
    // Simple tone adjustment - would need more sophisticated NLP in production
    return response;
  }

  private getMostFrequent<T>(map: Map<T, number>): T | undefined {
    let maxCount = 0;
    let mostFrequent: T | undefined;
    
    map.forEach((count, item) => {
      if (count > maxCount) {
        maxCount = count;
        mostFrequent = item;
      }
    });
    
    return mostFrequent;
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

  private generateId(): string {
    return `feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private async persistFeedback(feedback: FeedbackData): Promise<void> {
    // In production, save to database
    // For now, just log
    console.log(`Persisting feedback: ${feedback.id}`);
  }

  private async analyzeForInsights(feedback: FeedbackData): Promise<void> {
    // Trigger async analysis
    // In production, this might queue a job
    setTimeout(() => {
      this.getLearningInsights().then(insights => {
        if (insights.length > 0) {
          console.log(`📊 New insights available: ${insights.length} insights generated`);
        }
      });
    }, 1000);
  }
}

export const feedbackLearningService = new FeedbackLearningService();