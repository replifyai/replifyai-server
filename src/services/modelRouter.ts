/**
 * Model Router Service for Task-Based Model Selection
 * Routes different tasks to appropriate models based on complexity, cost, and speed
 */

export type TaskType = 
  | 'simple_qa'
  | 'complex_analysis'
  | 'summarization'
  | 'intent_detection'
  | 'embedding'
  | 'code_generation'
  | 'translation'
  | 'classification';

export type ModelProvider = 'groq' | 'openai' | 'nebius';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  costPer1kTokens?: number;
  speedScore?: number; // 1-10, higher is faster
  qualityScore?: number; // 1-10, higher is better
}

export interface RoutingCriteria {
  taskType: TaskType;
  complexity: number; // 1-10
  contextSize: number; // in tokens
  latencySensitive?: boolean;
  costSensitive?: boolean;
  qualityRequired?: number; // 1-10
}

export interface RoutingDecision {
  provider: ModelProvider;
  model: string;
  config: ModelConfig;
  reasoning: string;
  estimatedCost?: number;
  estimatedLatency?: number; // in ms
}

export class ModelRouterService {
  private modelConfigs: Map<string, ModelConfig> = new Map();

  constructor() {
    this.initializeModelConfigs();
  }

  private initializeModelConfigs(): void {
    // Groq models - fastest, good for simple tasks
    this.modelConfigs.set('groq-llama3-8b', {
      provider: 'groq',
      model: 'llama3-8b-8192',
      costPer1kTokens: 0.05,
      speedScore: 10,
      qualityScore: 6
    });

    this.modelConfigs.set('groq-llama3-70b', {
      provider: 'groq',
      model: 'llama3-70b-8192',
      costPer1kTokens: 0.59,
      speedScore: 8,
      qualityScore: 8
    });

    this.modelConfigs.set('groq-mixtral', {
      provider: 'groq',
      model: 'mixtral-8x7b-32768',
      costPer1kTokens: 0.27,
      speedScore: 9,
      qualityScore: 7
    });

    // OpenAI models - balanced speed and quality
    this.modelConfigs.set('openai-gpt4-mini', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      costPer1kTokens: 0.15,
      speedScore: 7,
      qualityScore: 8
    });

    this.modelConfigs.set('openai-gpt4', {
      provider: 'openai',
      model: 'gpt-4-turbo-preview',
      costPer1kTokens: 10.0,
      speedScore: 5,
      qualityScore: 10
    });

    this.modelConfigs.set('openai-gpt35', {
      provider: 'openai',
      model: 'gpt-3.5-turbo',
      costPer1kTokens: 0.5,
      speedScore: 8,
      qualityScore: 7
    });

    // Nebius models - cost-effective
    this.modelConfigs.set('nebius-llama3', {
      provider: 'nebius',
      model: 'llama3-8b',
      costPer1kTokens: 0.03,
      speedScore: 7,
      qualityScore: 6
    });
  }

  /**
   * Route a task to the most appropriate model
   */
  async routeTask(criteria: RoutingCriteria): Promise<RoutingDecision> {
    const candidates = this.getCandidateModels(criteria);
    const scored = this.scoreModels(candidates, criteria);
    const selected = scored[0];

    if (!selected) {
      throw new Error('No suitable model found for the given criteria');
    }

    return {
      provider: selected.config.provider,
      model: selected.config.model,
      config: selected.config,
      reasoning: this.generateReasoning(selected, criteria),
      estimatedCost: this.estimateCost(selected.config, criteria.contextSize),
      estimatedLatency: this.estimateLatency(selected.config, criteria.contextSize)
    };
  }

  private getCandidateModels(criteria: RoutingCriteria): ModelConfig[] {
    const candidates: ModelConfig[] = [];

    // Filter models based on task type
    switch (criteria.taskType) {
      case 'simple_qa':
      case 'intent_detection':
      case 'classification':
        // Fast, simple models preferred
        candidates.push(
          this.modelConfigs.get('groq-llama3-8b')!,
          this.modelConfigs.get('nebius-llama3')!,
          this.modelConfigs.get('openai-gpt35')!
        );
        break;

      case 'complex_analysis':
      case 'code_generation':
        // High-quality models required
        candidates.push(
          this.modelConfigs.get('openai-gpt4')!,
          this.modelConfigs.get('openai-gpt4-mini')!,
          this.modelConfigs.get('groq-llama3-70b')!
        );
        break;

      case 'summarization':
      case 'translation':
        // Balanced models
        candidates.push(
          this.modelConfigs.get('groq-mixtral')!,
          this.modelConfigs.get('openai-gpt4-mini')!,
          this.modelConfigs.get('openai-gpt35')!
        );
        break;

      case 'embedding':
        // Special case - only OpenAI for now
        return [{
          provider: 'openai',
          model: 'text-embedding-3-small',
          costPer1kTokens: 0.02,
          speedScore: 10,
          qualityScore: 8
        }];

      default:
        // Return all models for general use
        candidates.push(...Array.from(this.modelConfigs.values()));
    }

    // Filter by context size limits
    return candidates.filter(model => {
      const maxContext = this.getMaxContextSize(model);
      return criteria.contextSize <= maxContext;
    });
  }

  private scoreModels(
    models: ModelConfig[], 
    criteria: RoutingCriteria
  ): Array<{ config: ModelConfig; score: number }> {
    const scored = models.map(model => {
      let score = 0;

      // Quality score (weighted by requirement)
      const qualityWeight = criteria.qualityRequired || 5;
      score += (model.qualityScore || 5) * qualityWeight;

      // Speed score (weighted if latency sensitive)
      if (criteria.latencySensitive) {
        score += (model.speedScore || 5) * 3;
      } else {
        score += (model.speedScore || 5);
      }

      // Cost score (inverse, weighted if cost sensitive)
      const costScore = 10 - Math.min(10, (model.costPer1kTokens || 1) * 2);
      if (criteria.costSensitive) {
        score += costScore * 3;
      } else {
        score += costScore;
      }

      // Complexity match bonus
      const complexityMatch = 10 - Math.abs(criteria.complexity - (model.qualityScore || 5));
      score += complexityMatch * 2;

      // Provider-specific bonuses
      if (criteria.taskType === 'embedding' && model.provider === 'openai') {
        score += 20; // Strong preference for OpenAI embeddings
      }

      return { config: model, score };
    });

    // Sort by score descending
    return scored.sort((a, b) => b.score - a.score);
  }

  private generateReasoning(
    selected: { config: ModelConfig; score: number },
    criteria: RoutingCriteria
  ): string {
    const reasons: string[] = [];

    if (criteria.latencySensitive && selected.config.speedScore && selected.config.speedScore >= 8) {
      reasons.push(`Selected for high speed (score: ${selected.config.speedScore}/10)`);
    }

    if (criteria.costSensitive && selected.config.costPer1kTokens && selected.config.costPer1kTokens < 0.5) {
      reasons.push(`Cost-effective at $${selected.config.costPer1kTokens}/1k tokens`);
    }

    if (criteria.qualityRequired && criteria.qualityRequired >= 8) {
      reasons.push(`High quality model (score: ${selected.config.qualityScore}/10)`);
    }

    if (criteria.taskType === 'simple_qa' && selected.config.provider === 'groq') {
      reasons.push('Groq excels at simple Q&A with ultra-low latency');
    }

    if (criteria.taskType === 'complex_analysis' && selected.config.model.includes('gpt-4')) {
      reasons.push('GPT-4 provides best reasoning for complex analysis');
    }

    return reasons.join('; ') || 'Selected based on overall score optimization';
  }

  private estimateCost(config: ModelConfig, contextSize: number): number {
    const tokensInThousands = contextSize / 1000;
    return (config.costPer1kTokens || 0) * tokensInThousands;
  }

  private estimateLatency(config: ModelConfig, contextSize: number): number {
    const baseLatency = 100; // Base network latency
    const speedFactor = 11 - (config.speedScore || 5); // Inverse of speed score
    const contextFactor = contextSize / 1000; // Linear with context size
    
    return baseLatency + (speedFactor * 50) + (contextFactor * 10);
  }

  private getMaxContextSize(model: ModelConfig): number {
    const contextLimits: Record<string, number> = {
      'llama3-8b-8192': 8192,
      'llama3-70b-8192': 8192,
      'mixtral-8x7b-32768': 32768,
      'gpt-4o-mini': 128000,
      'gpt-4-turbo-preview': 128000,
      'gpt-3.5-turbo': 16385,
      'text-embedding-3-small': 8191
    };

    return contextLimits[model.model] || 4096;
  }

  /**
   * Get model recommendation for a specific use case
   */
  getRecommendation(useCase: string): RoutingCriteria {
    const recommendations: Record<string, RoutingCriteria> = {
      'chat_greeting': {
        taskType: 'simple_qa',
        complexity: 2,
        contextSize: 100,
        latencySensitive: true,
        costSensitive: true,
        qualityRequired: 5
      },
      'product_inquiry': {
        taskType: 'complex_analysis',
        complexity: 7,
        contextSize: 2000,
        latencySensitive: false,
        costSensitive: false,
        qualityRequired: 8
      },
      'quick_classification': {
        taskType: 'classification',
        complexity: 3,
        contextSize: 500,
        latencySensitive: true,
        costSensitive: true,
        qualityRequired: 6
      },
      'document_analysis': {
        taskType: 'complex_analysis',
        complexity: 9,
        contextSize: 8000,
        latencySensitive: false,
        costSensitive: false,
        qualityRequired: 9
      },
      'code_review': {
        taskType: 'code_generation',
        complexity: 8,
        contextSize: 4000,
        latencySensitive: false,
        costSensitive: false,
        qualityRequired: 9
      }
    };

    return recommendations[useCase] || {
      taskType: 'simple_qa',
      complexity: 5,
      contextSize: 1000,
      qualityRequired: 7
    };
  }

  /**
   * Get all available models for debugging/admin
   */
  getAllModels(): Array<{ key: string; config: ModelConfig }> {
    return Array.from(this.modelConfigs.entries()).map(([key, config]) => ({
      key,
      config
    }));
  }
}

export const modelRouterService = new ModelRouterService();