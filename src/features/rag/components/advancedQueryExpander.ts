/**
 * Advanced Query Expander
 * Implements production-grade query expansion techniques:
 * - Fuzzy product name matching and normalization
 * - Multi-query generation for better recall
 * - Query decomposition for complex questions
 * - Semantic expansion with domain-specific terms
 * - Spelling correction and synonym expansion
 */

import { openai } from "../../../services/llm/openai.js";
import { productCatalog } from "./productCatalog.js";
import { env } from "../../../env.js";

export interface ExpandedQuery {
  originalQuery: string;
  normalizedQuery: string;
  detectedProducts: string[];
  expandedQueries: string[];
  queryType: 'greeting' | 'casual' | 'informational' | 'comparison' | 'specification' | 'unknown';
  needsRAG: boolean;
  directResponse?: string;
  queryIntent: string;
  searchQueries: string[]; // Multiple search queries for better recall
  isMultiProductQuery: boolean; // Flag for multi-product queries
  comparisonProducts?: string[]; // Products to compare (if comparison query)
}

export interface QueryExpansionOptions {
  companyContext?: {
    companyName?: string;
    companyDescription?: string;
    productCategories?: string;
  };
  productName?: string;
  maxQueries?: number; // Maximum number of search queries to generate
}

export class AdvancedQueryExpander {
  
  /**
   * Main expansion function - orchestrates all expansion techniques
   */
  async expandQuery(
    query: string,
    options: QueryExpansionOptions = {}
  ): Promise<ExpandedQuery> {
    const { companyContext, productName, maxQueries = 5 } = options;

    // Step 1: Detect and normalize product names with fuzzy matching
    const detectedProducts = await this.detectProductNames(query, productName);

    // Step 2: Normalize query by replacing misspellings with correct product names
    const normalizedQuery = this.normalizeQuery(query, detectedProducts);

    // Step 2.5: Detect if this is a comparison query with multiple products
    const isComparison = this.isComparisonQuery(normalizedQuery);
    const isMultiProduct = detectedProducts.length > 1;

    // Step 3: Classify query type and determine if RAG is needed
    const classification = await this.classifyQuery(normalizedQuery, companyContext);

    // If RAG is not needed, return early with direct response
    if (!classification.needsRAG && classification.directResponse) {
      return {
        originalQuery: query,
        normalizedQuery,
        detectedProducts,
        expandedQueries: [normalizedQuery],
        queryType: classification.queryType,
        needsRAG: false,
        directResponse: classification.directResponse,
        queryIntent: classification.intent,
        searchQueries: [normalizedQuery],
        isMultiProductQuery: false,
      };
    }

    // Step 4: Generate multiple search queries using different perspectives
    // For comparison queries with multiple products, generate product-specific queries
    let searchQueries: string[];
    if (isComparison && isMultiProduct) {
      searchQueries = await this.generateComparisonSearchQueries(
        normalizedQuery,
        detectedProducts,
        companyContext,
        maxQueries
      );
    } else {
      searchQueries = await this.generateMultipleSearchQueries(
        normalizedQuery,
        detectedProducts,
        classification.queryType,
        companyContext,
        maxQueries
      );
    }

    // Step 5: Expand each query with domain-specific terms
    const expandedQueries = await this.expandWithDomainTerms(
      searchQueries,
      detectedProducts,
      companyContext
    );

    return {
      originalQuery: query,
      normalizedQuery,
      detectedProducts,
      expandedQueries,
      queryType: classification.queryType,
      needsRAG: true,
      queryIntent: classification.intent,
      searchQueries,
      isMultiProductQuery: isMultiProduct && isComparison,
      comparisonProducts: isComparison && isMultiProduct ? detectedProducts : undefined,
    };
  }

  /**
   * Check if query is a comparison query
   */
  private isComparisonQuery(query: string): boolean {
    const comparisonKeywords = [
      'difference',
      'compare',
      'comparison',
      'versus',
      'vs',
      'between',
      'or',
      'which is better',
      'better than',
      'differ from',
      'similar to',
      'contrast',
    ];

    const lowerQuery = query.toLowerCase();
    return comparisonKeywords.some(keyword => lowerQuery.includes(keyword));
  }

  /**
   * Generate search queries specifically for comparison queries
   * Creates product-specific queries to retrieve comprehensive info for each product
   */
  private async generateComparisonSearchQueries(
    query: string,
    products: string[],
    companyContext?: QueryExpansionOptions['companyContext'],
    maxQueriesPerProduct: number = 3
  ): Promise<string[]> {
    const contextInfo = {
      companyName: companyContext?.companyName || env.COMPANY_NAME,
      productCategories: companyContext?.productCategories || env.PRODUCT_CATEGORIES,
    };

    // Extract comparison aspects from the query
    const comparisonAspect = this.extractComparisonAspect(query);

    // Parallelize LLM calls for all products
    const queryPromises = products.map(product => 
      openai.chat.completions.create({
        model: 'gpt-4o-mini', // ⚡ OPTIMIZATION: Use faster model
        messages: [
          {
            role: "system",
            content: `You are an expert at generating search queries for product comparison.

Given a product and comparison aspect, generate ${maxQueriesPerProduct} search queries to retrieve comprehensive information about that product.

Context:
- Company: ${contextInfo.companyName}
- Product Categories: ${contextInfo.productCategories}
- Product: ${product}
- Comparison Aspect: ${comparisonAspect}

Guidelines:
1. Focus on the specific comparison aspect if provided
2. Include general product information (features, specifications, benefits)
3. Include product-specific details (materials, dimensions, design)
4. Each query should be distinct and comprehensive

Return JSON:
{
  "queries": ["query1", "query2", "query3"]
}`,
          },
          { role: "user", content: `Product: ${product}\nComparison Aspect: ${comparisonAspect}` },
        ],
        max_completion_tokens: 500,
        response_format: { type: "json_object" },
      })
    );

    // Execute all LLM calls in parallel
    const responses = await Promise.all(queryPromises);

    // Process results
    const allQueries: string[] = [];
    responses.forEach((response, idx) => {
      const content = response.choices[0]?.message?.content || '{"queries": []}';
      const result = JSON.parse(content);
      const productQueries = result.queries || [];

      // Add product name to each query to ensure filtering works
      const queriesWithProduct = productQueries.map((q: string) => `${q} ${products[idx]}`);
      allQueries.push(...queriesWithProduct);
    });

    return allQueries;
  }

  /**
   * Extract the comparison aspect from the query
   */
  private extractComparisonAspect(query: string): string {
    const lowerQuery = query.toLowerCase();
    
    // Common comparison aspects
    const aspects = {
      'price': ['price', 'cost', 'expensive', 'cheaper', 'affordable'],
      'features': ['feature', 'function', 'capability', 'what does'],
      'specifications': ['spec', 'dimension', 'size', 'weight', 'material'],
      'comfort': ['comfort', 'ergonomic', 'support', 'feel'],
      'design': ['design', 'look', 'style', 'appearance', 'aesthetic'],
      'quality': ['quality', 'durable', 'lasting', 'reliable'],
      'performance': ['performance', 'effective', 'work', 'good'],
    };

    for (const [aspect, keywords] of Object.entries(aspects)) {
      if (keywords.some(keyword => lowerQuery.includes(keyword))) {
        return aspect;
      }
    }

    return 'general comparison';
  }

  /**
   * Detect product names in query using fuzzy matching
   */
  private async detectProductNames(query: string, productHint?: string): Promise<string[]> {
    const detected: string[] = [];

    // If product hint is provided, try to match it first
    if (productHint && productHint.trim()) {
      const hintMatches = productCatalog.fuzzyMatchProducts(productHint, 0.3, 1);
      if (hintMatches.length > 0) {
        detected.push(hintMatches[0].product.name);
      }
    }

    // Extract products from query
    const queryMatches = productCatalog.fuzzyMatchProducts(query, 0.4, 3);
    for (const match of queryMatches) {
      if (!detected.includes(match.product.name)) {
        detected.push(match.product.name);
      }
    }

    return detected;
  }

  /**
   * Normalize query by replacing misspelled/fuzzy product names with correct ones
   */
  private normalizeQuery(query: string, detectedProducts: string[]): string {
    let normalized = query;

    for (const product of detectedProducts) {
      // Create regex patterns for variations of the product name
      const patterns = this.createSearchPatterns(product);
      
      for (const pattern of patterns) {
        const regex = new RegExp(pattern, 'gi');
        if (regex.test(normalized)) {
          // Replace with correct product name only once
          normalized = normalized.replace(regex, product);
          break;
        }
      }
    }

    return normalized;
  }

  /**
   * Create search patterns for a product name
   */
  private createSearchPatterns(productName: string): string[] {
    const patterns: string[] = [];
    const normalized = productName.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
    const words = normalized.split(/\s+/);

    // Pattern for key words from product name
    const keyWords = words.filter(w => w.length > 3 && !['frido', 'ultimate'].includes(w));
    if (keyWords.length >= 2) {
      patterns.push(keyWords.slice(0, 3).join('\\s+\\w*\\s+'));
    }

    return patterns;
  }

  /**
   * Classify query type and determine if RAG is needed
   */
  private async classifyQuery(
    query: string,
    companyContext?: QueryExpansionOptions['companyContext']
  ): Promise<{
    queryType: ExpandedQuery['queryType'];
    needsRAG: boolean;
    directResponse?: string;
    intent: string;
  }> {
    const contextInfo = {
      companyName: companyContext?.companyName || env.COMPANY_NAME,
      companyDescription: companyContext?.companyDescription || env.COMPANY_DESCRIPTION,
      productCategories: companyContext?.productCategories || env.PRODUCT_CATEGORIES,
    };

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // ⚡ OPTIMIZATION: Use faster model for classification
      messages: [
        {
          role: "system",
          content: `You are a query classifier for ${contextInfo.companyName}.

Analyze the user query and classify it into one of these types:
1. **greeting**: Hi, hello, hey, etc.
2. **casual**: Thank you, how are you, etc.
3. **informational**: Questions about products, features, specifications
4. **comparison**: Comparing multiple products
5. **specification**: Asking for specific specs or details

Return a JSON object:
{
  "queryType": "greeting|casual|informational|comparison|specification",
  "needsRAG": true|false,
  "directResponse": "optional response if no RAG needed",
  "intent": "brief description of user intent"
}

Guidelines:
- greeting/casual → needsRAG: false, provide friendly directResponse
- informational/comparison/specification → needsRAG: true
- Keep directResponse concise and mention the company name naturally`,
        },
        { role: "user", content: query },
      ],
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content || "{}";
    const classification = JSON.parse(content);

    return {
      queryType: classification.queryType || 'unknown',
      needsRAG: classification.needsRAG !== false,
      directResponse: classification.directResponse,
      intent: classification.intent || 'General query',
    };
  }

  /**
   * Generate multiple search queries from different perspectives
   * This significantly improves recall
   */
  private async generateMultipleSearchQueries(
    query: string,
    detectedProducts: string[],
    queryType: ExpandedQuery['queryType'],
    companyContext?: QueryExpansionOptions['companyContext'],
    maxQueries: number = 5
  ): Promise<string[]> {
    const contextInfo = {
      companyName: companyContext?.companyName || env.COMPANY_NAME,
      productCategories: companyContext?.productCategories || env.PRODUCT_CATEGORIES,
    };

    const productContext = detectedProducts.length > 0
      ? `\nDetected Products: ${detectedProducts.join(', ')}`
      : '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // ⚡ OPTIMIZATION: Use faster model for query generation
      messages: [
        {
          role: "system",
          content: `You are an expert at generating diverse search queries to maximize retrieval recall.

Given a user query, generate ${maxQueries} different search queries that would help retrieve relevant information.

Context:
- Company: ${contextInfo.companyName}
- Products: ${contextInfo.productCategories}${productContext}

Guidelines for generating queries:
1. **Original Query**: Include the original query
2. **Decomposed Query**: Break complex questions into simpler parts
3. **Keyword-Focused**: Extract and focus on key terms
4. **Synonym Expansion**: Use synonyms and related terms
5. **Product-Specific**: Include product names explicitly if detected

For a query like "What is the price and weight of the pillow?":
- "What is the price and weight of the pillow?"
- "pillow price cost"
- "pillow weight dimensions specifications"
- "pillow pricing information"
- "pillow physical properties weight"

Return a JSON object:
{
  "queries": ["query1", "query2", "query3", "query4", "query5"]
}

Each query should be distinct and approach the information need differently.`,
        },
        { role: "user", content: query },
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content || '{"queries": []}';
    const result = JSON.parse(content);

    return result.queries || [query];
  }

  /**
   * Expand queries with domain-specific terminology
   */
  private async expandWithDomainTerms(
    queries: string[],
    detectedProducts: string[],
    companyContext?: QueryExpansionOptions['companyContext']
  ): Promise<string[]> {
    const contextInfo = {
      productCategories: companyContext?.productCategories || env.PRODUCT_CATEGORIES,
    };

    // Add product names and domain terms to each query
    const expanded = queries.map(query => {
      let expandedQuery = query;

      // Add product names if not already present
      for (const product of detectedProducts) {
        if (!query.toLowerCase().includes(product.toLowerCase())) {
          expandedQuery += ` ${product}`;
        }
      }

      // Add domain-specific terms based on product categories
      const domainTerms = this.getDomainTerms(query, contextInfo.productCategories);
      if (domainTerms.length > 0) {
        expandedQuery += ' ' + domainTerms.join(' ');
      }

      return expandedQuery.trim();
    });

    return expanded;
  }

  /**
   * Get domain-specific terms based on query and product categories
   */
  private getDomainTerms(query: string, productCategories: string): string[] {
    const terms: string[] = [];
    const lowerQuery = query.toLowerCase();

    // Orthopedic/Medical terms
    if (lowerQuery.includes('pain') || lowerQuery.includes('support') || lowerQuery.includes('relief')) {
      terms.push('orthopedic', 'medical-grade', 'therapeutic', 'ergonomic');
    }

    // Comfort terms
    if (lowerQuery.includes('comfort') || lowerQuery.includes('soft') || lowerQuery.includes('cushion')) {
      terms.push('memory foam', 'gel', 'breathable', 'plush');
    }

    // Material terms
    if (lowerQuery.includes('material') || lowerQuery.includes('made of') || lowerQuery.includes('fabric')) {
      terms.push('materials', 'construction', 'fabric', 'coating');
    }

    // Specification terms
    if (lowerQuery.includes('size') || lowerQuery.includes('dimension') || lowerQuery.includes('weight')) {
      terms.push('specifications', 'dimensions', 'measurements', 'weight');
    }

    // Features terms
    if (lowerQuery.includes('feature') || lowerQuery.includes('benefit') || lowerQuery.includes('advantage')) {
      terms.push('features', 'benefits', 'advantages', 'properties');
    }

    return terms;
  }

  /**
   * Quick method for simple expansion (backward compatibility)
   */
  async simpleExpand(
    query: string,
    companyContext?: QueryExpansionOptions['companyContext'],
    productName?: string
  ): Promise<{
    expandedQuery: string;
    needsRAG: boolean;
    queryType: ExpandedQuery['queryType'];
    directResponse?: string;
  }> {
    const result = await this.expandQuery(query, { companyContext, productName, maxQueries: 3 });
    
    return {
      expandedQuery: result.expandedQueries[0] || query,
      needsRAG: result.needsRAG,
      queryType: result.queryType,
      directResponse: result.directResponse,
    };
  }
}

export const advancedQueryExpander = new AdvancedQueryExpander();

