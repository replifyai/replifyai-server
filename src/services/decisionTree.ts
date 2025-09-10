/**
 * Decision Tree Service for Structured Agent Routing
 * Inspired by Elysia's approach to guide AI agents through contextual paths
 */

export interface DecisionNode {
  id: string;
  type: 'condition' | 'action' | 'router';
  description: string;
  condition?: (context: DecisionContext) => Promise<boolean> | boolean;
  action?: (context: DecisionContext) => Promise<any>;
  children?: DecisionNode[];
  metadata?: {
    debugInfo?: any;
    impossibleFlag?: boolean;
    confidence?: number;
  };
}

export interface DecisionContext {
  query: string;
  productName?: string;
  previousDecisions: DecisionStep[];
  metadata?: any;
}

export interface DecisionStep {
  nodeId: string;
  decision: any;
  reasoning: string;
  confidence: number;
  timestamp: Date;
  impossibleFlag?: boolean;
}

export interface DecisionResult {
  result: any;
  path: string[];
  decisions: DecisionStep[];
  impossibleFlag?: boolean;
}

export class DecisionTreeService {
  private trees: Map<string, DecisionNode> = new Map();

  constructor() {
    this.initializeDefaultTree();
  }

  private initializeDefaultTree(): void {
    // Main decision tree for assistant responses
    const mainTree: DecisionNode = {
      id: 'root',
      type: 'router',
      description: 'Root decision node for assistant responses',
      children: [
        {
          id: 'check_greeting',
          type: 'condition',
          description: 'Check if query is a greeting or small talk',
          condition: (ctx) => this.isGreeting(ctx.query),
          children: [
            {
              id: 'handle_greeting',
              type: 'action',
              description: 'Handle greeting with friendly response',
              action: async (ctx) => ({
                useRAG: false,
                intent: 'greeting',
                confidence: 0.95
              })
            }
          ]
        },
        {
          id: 'check_product_intent',
          type: 'condition',
          description: 'Check if query has product-related intent',
          condition: async (ctx) => await this.hasProductIntent(ctx),
          children: [
            {
              id: 'check_rag_availability',
              type: 'condition',
              description: 'Check if RAG context is available',
              condition: async (ctx) => await this.hasRAGContext(ctx),
              children: [
                {
                  id: 'use_rag',
                  type: 'action',
                  description: 'Use RAG for product-related query',
                  action: async (ctx) => ({
                    useRAG: true,
                    intent: 'product_query',
                    confidence: 0.9
                  })
                }
              ]
            },
            {
              id: 'set_impossible_flag',
              type: 'action',
              description: 'Set impossible flag when no relevant context exists',
              action: async (ctx) => ({
                useRAG: false,
                intent: 'product_query_no_context',
                impossibleFlag: true,
                confidence: 0.85,
                suggestion: "I don't have information about that in the available documents. Could you provide more context or upload relevant documents?"
              }),
              metadata: { impossibleFlag: true }
            }
          ]
        },
        {
          id: 'use_general_llm',
          type: 'action',
          description: 'Use general LLM for non-product queries',
          action: async (ctx) => ({
            useRAG: false,
            intent: 'general_query',
            confidence: 0.8
          })
        }
      ]
    };

    this.trees.set('main', mainTree);
  }

  async execute(
    treeName: string,
    context: DecisionContext
  ): Promise<DecisionResult> {
    const tree = this.trees.get(treeName);
    if (!tree) {
      throw new Error(`Decision tree '${treeName}' not found`);
    }

    const result: DecisionResult = {
      result: null,
      path: [],
      decisions: [],
      impossibleFlag: false
    };

    await this.traverseNode(tree, context, result);
    return result;
  }

  private async traverseNode(
    node: DecisionNode,
    context: DecisionContext,
    result: DecisionResult
  ): Promise<any> {
    result.path.push(node.id);

    if (node.type === 'condition' && node.condition) {
      const startTime = Date.now();
      const conditionResult = await node.condition(context);
      const confidence = this.calculateConfidence(node, conditionResult);

      const decision: DecisionStep = {
        nodeId: node.id,
        decision: conditionResult,
        reasoning: node.description,
        confidence,
        timestamp: new Date(),
        impossibleFlag: node.metadata?.impossibleFlag
      };

      context.previousDecisions.push(decision);
      result.decisions.push(decision);

      if (conditionResult && node.children && node.children.length > 0) {
        // Condition is true, traverse children
        for (const child of node.children) {
          const childResult = await this.traverseNode(child, context, result);
          if (childResult !== undefined) {
            return childResult;
          }
        }
      }
    } else if (node.type === 'action' && node.action) {
      const actionResult = await node.action(context);
      
      const decision: DecisionStep = {
        nodeId: node.id,
        decision: actionResult,
        reasoning: node.description,
        confidence: actionResult.confidence || 0.5,
        timestamp: new Date(),
        impossibleFlag: actionResult.impossibleFlag
      };

      context.previousDecisions.push(decision);
      result.decisions.push(decision);
      result.result = actionResult;
      
      if (actionResult.impossibleFlag) {
        result.impossibleFlag = true;
      }

      return actionResult;
    } else if (node.type === 'router' && node.children) {
      // Router node - evaluate all children
      for (const child of node.children) {
        const childResult = await this.traverseNode(child, context, result);
        if (childResult !== undefined) {
          return childResult;
        }
      }
    }
  }

  private isGreeting(query: string): boolean {
    const greetings = [
      'hello', 'hi', 'hey', 'good morning', 'good afternoon',
      'good evening', 'howdy', 'greetings', 'what\'s up', 'sup'
    ];
    const normalized = query.toLowerCase().trim();
    return greetings.some(g => normalized.includes(g)) && normalized.length < 30;
  }

  private async hasProductIntent(context: DecisionContext): Promise<boolean> {
    const { query, productName } = context;
    const text = query.toLowerCase();

    // Quick heuristic checks
    const productKeywords = [
      'price', 'cost', 'feature', 'spec', 'plan', 'package',
      'integration', 'api', 'support', 'documentation', 'how to',
      'setup', 'configure', 'install', 'troubleshoot', 'error',
      'detail', 'details', 'information', 'about', 'what is',
      'describe', 'overview', 'summary', 'benefits', 'usp'
    ];

    if (productKeywords.some(k => text.includes(k))) {
      return true;
    }

    if (productName && text.includes(productName.toLowerCase())) {
      return true;
    }

    // For ambiguous cases, we could add LLM classification here
    // but keeping it simple for now
    return false;
  }

  private async hasRAGContext(context: DecisionContext): Promise<boolean> {
    // This would check if we have relevant documents in the vector store
    // For now, returning true as a placeholder
    // In real implementation, this would query the vector store
    return true;
  }

  private calculateConfidence(node: DecisionNode, result: any): number {
    // Simple confidence calculation
    // Can be enhanced based on multiple factors
    if (typeof result === 'boolean') {
      return result ? 0.9 : 0.1;
    }
    return 0.5;
  }

  // Add custom decision tree
  addTree(name: string, tree: DecisionNode): void {
    this.trees.set(name, tree);
  }

  // Get decision tree for inspection/debugging
  getTree(name: string): DecisionNode | undefined {
    return this.trees.get(name);
  }

  // Visualize decision path (for debugging)
  visualizePath(result: DecisionResult): string {
    const lines: string[] = ['Decision Path:'];
    result.decisions.forEach((decision, index) => {
      const indent = '  '.repeat(index);
      lines.push(`${indent}├─ ${decision.nodeId}: ${decision.decision} (confidence: ${decision.confidence.toFixed(2)})`);
      if (decision.impossibleFlag) {
        lines.push(`${indent}   ⚠️  Impossible Flag Set`);
      }
    });
    return lines.join('\n');
  }
}

export const decisionTreeService = new DecisionTreeService();