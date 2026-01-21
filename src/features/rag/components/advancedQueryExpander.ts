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
  queryType: 'greeting' | 'casual' | 'informational' | 'comparison' | 'specification' | 'catalog' | 'unknown';
  needsRAG: boolean;
  directResponse?: string;
  queryIntent: string;
  searchQueries: string[]; // Multiple search queries for better recall
  isMultiProductQuery: boolean; // Flag for multi-product queries
  comparisonProducts?: string[]; // Products to compare (if comparison query)
  isProductCatalogQuery?: boolean; // Flag for product catalog/overview queries
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
   * 🚀 OPTIMIZED: Comprehensive query analysis in ONE LLM call
   * Replaces 4 separate LLM calls: smartProductDetection, isProductCatalogQuery, isComparisonQuery, classifyQuery
   * This dramatically reduces latency by consolidating analysis into a single request.
   */
  private async analyzeQueryComprehensive(
    query: string,
    productHint?: string,
    companyContext?: QueryExpansionOptions['companyContext']
  ): Promise<{
    // Query classification
    queryType: ExpandedQuery['queryType'];
    needsRAG: boolean;
    directResponse?: string;
    intent: string;
    // Product detection
    isSpecificProductQuery: boolean;
    detectedProducts: string[];
    productDetectionReason: string;
    // Query type flags
    isComparisonQuery: boolean;
    isCatalogQuery: boolean;
  }> {
    const contextInfo = {
      companyName: companyContext?.companyName || env.COMPANY_NAME,
      companyDescription: companyContext?.companyDescription || env.COMPANY_DESCRIPTION,
      productCategories: companyContext?.productCategories || env.PRODUCT_CATEGORIES,
    };

    // Get product catalog for reference
    const allProducts = productCatalog.getAllProductNames();
    const productList = allProducts.slice(0, 80).join(', '); // Limit to prevent token overflow

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', // Use gpt-4o for comprehensive analysis
        messages: [
          {
            role: 'system',
            content: `You are an expert query analyzer for ${contextInfo.companyName}.

ANALYZE the user query and return a comprehensive JSON response. This SINGLE analysis replaces multiple separate calls, so be thorough.

═══════════════════════════════════════════════════════════════
AVAILABLE PRODUCTS (for reference):
${productList}
${productHint ? `\nUser also mentioned: "${productHint}"` : ''}
═══════════════════════════════════════════════════════════════

ANALYSIS REQUIRED:

1. **QUERY CLASSIFICATION**:
   - queryType: "greeting" | "casual" | "informational" | "comparison" | "specification" | "catalog"
   - needsRAG: true/false (greetings/casual → false, others → true)
   - directResponse: If needsRAG is false, provide a friendly response
   - intent: Brief description of user intent

2. **PRODUCT DETECTION**:
   - isSpecificProductQuery: Is user asking about SPECIFIC named products?
     - TRUE: "Price of Mattress Topper", "Features of Frido Ultimate Pillow"
     - FALSE: "Which is the best cushion for car?", "Recommend something for back pain"
   - detectedProducts: Array of EXACT product names from the list above ([] if category query)
   - productDetectionReason: Brief explanation

3. **QUERY TYPE FLAGS**:
   - isComparisonQuery: Does query compare 2+ products? ("A vs B", "difference between", "which is better")
   - isCatalogQuery: Is user asking for product overview/catalog? ("what products available", "show me your products")

═══════════════════════════════════════════════════════════════
CRITICAL RULES:
═══════════════════════════════════════════════════════════════
1. "best", "recommend", "suggest", "which is best for" → isSpecificProductQuery: FALSE, detectedProducts: []
2. Only return products that EXACTLY match names from the product list
3. Generic words like "cushion", "insole", "pillow" alone are NOT product names
4. For comparison queries, detect ALL products being compared
5. Be very accurate - wrong product detection causes bad user experience

RETURN JSON:
{
  "queryType": "...",
  "needsRAG": true/false,
  "directResponse": "..." or null,
  "intent": "...",
  "isSpecificProductQuery": true/false,
  "detectedProducts": [...],
  "productDetectionReason": "...",
  "isComparisonQuery": true/false,
  "isCatalogQuery": true/false
}`
          },
          { role: 'user', content: query }
        ],
        temperature: 0.0,
        max_completion_tokens: 500,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content || '{}';
      const result = JSON.parse(content);

      // Log analysis results
      console.log(`🧠 Comprehensive Query Analysis:`);
      console.log(`   ├─ Type: ${result.queryType} | RAG: ${result.needsRAG}`);
      console.log(`   ├─ Specific Product: ${result.isSpecificProductQuery} | Products: [${(result.detectedProducts || []).join(', ')}]`);
      console.log(`   ├─ Comparison: ${result.isComparisonQuery} | Catalog: ${result.isCatalogQuery}`);
      console.log(`   └─ Reason: ${result.productDetectionReason}`);

      return {
        queryType: result.queryType || 'unknown',
        needsRAG: result.needsRAG !== false,
        directResponse: result.directResponse || undefined,
        intent: result.intent || 'General query',
        isSpecificProductQuery: result.isSpecificProductQuery === true,
        detectedProducts: Array.isArray(result.detectedProducts) ? result.detectedProducts : [],
        productDetectionReason: result.productDetectionReason || 'No reason provided',
        isComparisonQuery: result.isComparisonQuery === true,
        isCatalogQuery: result.isCatalogQuery === true,
      };

    } catch (error) {
      console.error('❌ Comprehensive query analysis failed:', error);
      // Return safe defaults on error
      return {
        queryType: 'informational',
        needsRAG: true,
        intent: 'General query (analysis failed)',
        isSpecificProductQuery: false,
        detectedProducts: [],
        productDetectionReason: 'Analysis failed - defaulting to broad search',
        isComparisonQuery: false,
        isCatalogQuery: false,
      };
    }
  }

  /**
   * Main expansion function - orchestrates all expansion techniques
   * 🚀 OPTIMIZED: Uses single comprehensive LLM call instead of 4 separate calls
   */
  async expandQuery(
    query: string,
    options: QueryExpansionOptions = {}
  ): Promise<ExpandedQuery> {
    const { companyContext, productName, maxQueries = 5 } = options;

    // Ensure product catalog is loaded
    await productCatalog.refreshProducts();

    // 🚀 OPTIMIZED: Single comprehensive analysis call replaces 4 sequential LLM calls
    // Before: smartProductDetection → isProductCatalogQuery/isComparisonQuery → classifyQuery
    // After: One call that returns all analysis in ~0.5-1s instead of ~2-4s
    const analysis = await this.analyzeQueryComprehensive(query, productName, companyContext);

    // Extract results from comprehensive analysis
    const detectedProducts = analysis.detectedProducts;
    const isCatalog = analysis.isCatalogQuery;
    const isComparison = analysis.isComparisonQuery;
    const isMultiProduct = detectedProducts.length > 1;

    // Log detection results
    if (analysis.isSpecificProductQuery && detectedProducts.length > 0) {
      console.log(`🎯 Specific product query detected - Products: ${detectedProducts.join(', ')}`);
    } else if (!analysis.isSpecificProductQuery) {
      console.log(`🔓 Category/recommendation query - No product lock`);
    }

    // Normalize query by replacing misspellings with correct product names
    const normalizedQuery = this.normalizeQuery(query, detectedProducts);

    // If RAG is not needed, return early with direct response
    if (!analysis.needsRAG && analysis.directResponse) {
      return {
        originalQuery: query,
        normalizedQuery,
        detectedProducts,
        expandedQueries: [normalizedQuery],
        queryType: analysis.queryType,
        needsRAG: false,
        directResponse: analysis.directResponse,
        queryIntent: analysis.intent,
        searchQueries: [normalizedQuery],
        isMultiProductQuery: false,
      };
    }

    // Step 4: Generate multiple search queries using different perspectives
    let searchQueries: string[];

    // 🔍 Detect if this is a recommendation/category query where we should NOT lock to a single product
    // These queries ask for suggestions across a category rather than asking about a specific named product
    const isRecommendationQuery = this.isRecommendationOrCategoryQuery(normalizedQuery);

    // 🚀 CRITICAL FIX: Only lock to a specific product when:
    // 1. User explicitly mentions a specific product name (e.g., "Price of Mattress topper")
    // 2. NOT a recommendation/category query (e.g., "best back support cushion for car")
    // 3. Either it's a "Pro" variant match OR exactly 1 product detected
    let singleExactProductMatch: string | null = null;

    if (!isRecommendationQuery) {
      singleExactProductMatch = detectedProducts.find(p =>
        p.toLowerCase().includes('pro') && normalizedQuery.toLowerCase().includes('pro')
      ) || (detectedProducts.length === 1 ? detectedProducts[0] : null);
    }

    if (isRecommendationQuery) {
      console.log(`🔓 Recommendation/category query detected - NOT locking to single product`);
      console.log(`   Query: "${normalizedQuery}"`);
    }

    if (isCatalog) {
      // For product catalog queries, generate diverse queries to retrieve all products
      searchQueries = await this.generateCatalogSearchQueries(
        normalizedQuery,
        companyContext,
        maxQueries
      );
    } else if (isComparison && isMultiProduct) {
      // For comparison queries with multiple products
      // 🚀 Use detected products for comparison queries, respecting any LLM refinement
      searchQueries = await this.generateComparisonSearchQueries(
        normalizedQuery,
        detectedProducts, // Use the refined detectedProducts list here
        companyContext,
        maxQueries
      );
    } else {
      // For regular informational queries
      searchQueries = await this.generateMultipleSearchQueries(
        normalizedQuery,
        detectedProducts,
        analysis.queryType,
        companyContext,
        maxQueries
      );

      // 🔒 PRODUCT LOCK: Only lock when user asks about a specific product, NOT for recommendations
      if (singleExactProductMatch) {
        console.log(`🔒 Locking search to exact product: "${singleExactProductMatch}"`);
        searchQueries = searchQueries.map(q => {
          // If the query doesn't contain the exact product name, append it
          if (!q.includes(singleExactProductMatch)) {
            return `${q} "${singleExactProductMatch}"`; // Quote it for emphasis if supported, or just append
          }
          return q;
        });
      }
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
      queryType: isCatalog ? 'catalog' : analysis.queryType,
      needsRAG: true,
      queryIntent: analysis.intent,
      searchQueries,
      isMultiProductQuery: isMultiProduct && isComparison,
      comparisonProducts: isComparison && isMultiProduct ? detectedProducts : undefined,
      isProductCatalogQuery: isCatalog,
    };
  }

  /**
   * Verify product matches using LLM to ensure accuracy
   * This helps resolve ambiguity between similar product names (e.g., "Pro" vs standard)
   */
  private async verifyProductMatchesWithLLM(query: string, candidates: string[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    if (candidates.length === 1) return candidates; // Single candidate is usually correct

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a product identification expert.
Your task is to identify which specific product(s) the user is referring to in their query, given a list of candidate products found by fuzzy matching.

User Query: "${query}"

Candidate Products:
${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Instructions:
1. Select the product(s) that BEST match the user's query.
2. Be precise. If the user says "Pro", ONLY select the "Pro" version, not the standard one.
3. If multiple products are legitimately mentioned or implied, select all of them.
4. If the query is vague and could refer to multiple candidates, select the most likely ones.
5. Return ONLY a JSON object with the selected product names.

Example:
Query: "Price of Frido Dual Gel Insoles Pro"
Candidates: ["Frido Dual Gel Insoles", "Frido Dual Gel Insoles Pro"]
Result: {"selected": ["Frido Dual Gel Insoles Pro"]}
`
          },
          { role: 'user', content: query }
        ],
        temperature: 0.0,
        max_completion_tokens: 200,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content || '{"selected": []}';
      const result = JSON.parse(content);

      // If LLM returns valid selection, use it. Otherwise fall back to original candidates.
      if (result.selected && Array.isArray(result.selected) && result.selected.length > 0) {
        console.log(`🧠 LLM Refined Product Selection: ${JSON.stringify(result.selected)} (Original: ${JSON.stringify(candidates)})`);
        return result.selected;
      }

      return candidates;
    } catch (error) {
      console.error('❌ LLM product verification failed:', error);
      return candidates;
    }
  }

  /**
   * 🧠 SMART PRODUCT DETECTION using LLM
   * 
   * This is the core intelligence for product locking. It determines:
   * 1. Is this query about a SPECIFIC product? (e.g., "Price of Mattress topper")
   * 2. Or is it about a CATEGORY/RECOMMENDATION? (e.g., "best back support cushion for car")
   * 
   * If specific product → identify and return the product name(s)
   * If category → return empty, no product lock
   */
  private async smartProductDetection(query: string, productHint?: string): Promise<{
    isSpecificProductQuery: boolean;
    detectedProducts: string[];
    reason: string;
  }> {
    try {
      // Get the product catalog for reference
      const allProducts = productCatalog.getAllProductNames();

      // Limit to first 100 products to avoid token limits
      const productList = allProducts.slice(0, 100).join('\n');

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are an expert product query analyzer. Your task is to determine if a user query is about:

1. **SPECIFIC PRODUCT(S)**: User is asking about a particular named product
   - Examples: "Price of Mattress Topper", "Features of Frido Ultimate Pillow", "Is Frido Coccyx Cushion good?"
   
2. **CATEGORY/RECOMMENDATION**: User is asking for suggestions, recommendations, or the "best" product for a use case
   - Examples: "Which is the best back support cushion for car?", "Recommend a cushion for office", "Best insole for running"
   - These queries should NOT lock to any specific product - they need to compare ALL relevant products

CRITICAL: If the query asks "which is best", "recommend", "suggest", "looking for", "need a...for" → This is CATEGORY, NOT specific product!

Available Products (for reference):
${productList}

${productHint ? `User also mentioned: "${productHint}"` : ''}

Analyze the query and return JSON:
{
  "isSpecificProductQuery": true/false,
  "detectedProducts": ["Product Name 1", "Product Name 2"] or [] if category query,
  "reason": "Brief explanation of your decision"
}

RULES:
1. If user mentions a specific product by name (even partial) → isSpecificProductQuery: true, detect the product
2. If user asks for recommendation/best/suggest → isSpecificProductQuery: false, detectedProducts: []
3. Only return products that EXACTLY match names from the product list
4. Be VERY careful - "back support cushion" is a CATEGORY, not a specific product name
5. Do NOT match generic words like "support", "cushion", "chair" to specific products`
          },
          { role: 'user', content: query }
        ],
        temperature: 0.0,
        max_completion_tokens: 300,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content || '{}';
      const result = JSON.parse(content);

      console.log(`🧠 Smart Detection: ${result.isSpecificProductQuery ? 'SPECIFIC PRODUCT' : 'CATEGORY'} - ${result.reason}`);

      return {
        isSpecificProductQuery: result.isSpecificProductQuery === true,
        detectedProducts: Array.isArray(result.detectedProducts) ? result.detectedProducts : [],
        reason: result.reason || 'No reason provided'
      };

    } catch (error) {
      console.error('❌ Smart product detection failed:', error);
      // On error, return as category query (safer - won't lock to wrong product)
      return {
        isSpecificProductQuery: false,
        detectedProducts: [],
        reason: 'Error in detection - defaulting to category query'
      };
    }
  }

  /**
   * Check if query is asking for product catalog/overview
   */
  private async isProductCatalogQuery(query: string): Promise<boolean> {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a query classifier. Determine if the user's query is asking for a PRODUCT CATALOG or OVERVIEW of available products.

A product catalog/overview query asks about:
- What products/types of products are available
- Product categories or collections
- Product lineup or range
- All products offered
- Product catalog or list

Examples of CATALOG queries:
- "What type of products does the company offer?"
- "What products are available?"
- "Show me your product catalog"
- "What do you sell?"
- "What are your product categories?"
- "List all products"
- "What's in your product lineup?"

Examples of NON-CATALOG queries:
- "What are the features of Product A?"
- "Compare Product A and Product B"
- "How much does Product A cost?"
- "Is Product A good for running?"

Respond with ONLY a JSON object:
{"isCatalog": true} or {"isCatalog": false}`
          },
          {
            role: 'user',
            content: query
          }
        ],
        temperature: 0.0,
        max_completion_tokens: 20,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return false;

      const parsed = JSON.parse(content);
      const isCatalog = parsed.isCatalog === true;

      console.log(`🔍 Catalog Detection: "${query}" → ${isCatalog ? '✅ CATALOG' : '❌ NOT CATALOG'}`);

      return isCatalog;

    } catch (error) {
      console.error('❌ Catalog detection failed:', error);
      // Fallback to keyword-based detection
      const catalogKeywords = [
        'what products',
        'what type of products',
        'product catalog',
        'products offer',
        'products available',
        'product categories',
        'product lineup',
        'what do you sell',
        'list all products',
        'show me products'
      ];
      const lowerQuery = query.toLowerCase();
      return catalogKeywords.some(keyword => lowerQuery.includes(keyword));
    }
  }

  /**
   * Check if query is a comparison query using GPT-4o-mini for robust detection
   */
  private async isComparisonQuery(query: string): Promise<boolean> {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a query classifier. Determine if the user's query is a COMPARISON query.

A comparison query asks to compare, contrast, or evaluate differences/similarities between 2 or more items, products, or options.

Examples of COMPARISON queries:
- "What's the difference between Product A and Product B?"
- "Compare Product X and Product Y"
- "Which is better: Option A or Option B?"
- "Product A vs Product B"
- "How does X differ from Y?"
- "Is X similar to Y?"
- "Contrast A and B"

Examples of NON-COMPARISON queries:
- "What are the features of Product A?"
- "How much does Product A cost?"
- "Tell me about Product A"
- "Is Product A good for running?"
- "What colors does Product A come in?"

Respond with ONLY a JSON object:
{"isComparison": true} or {"isComparison": false}

Be strict: Only return true if the query explicitly asks to compare or contrast multiple items.`
          },
          {
            role: 'user',
            content: query
          }
        ],
        temperature: 0.0,
        max_completion_tokens: 20,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return false;

      const parsed = JSON.parse(content);
      const isComparison = parsed.isComparison === true;

      console.log(`🔍 Comparison Detection (GPT-4o-mini): "${query}" → ${isComparison ? '✅ COMPARISON' : '❌ NOT COMPARISON'}`);

      return isComparison;

    } catch (error) {
      console.error('❌ LLM comparison detection failed:', error);
      // Fallback to keyword-based detection
      const comparisonKeywords = [
        'difference',
        'compare',
        'comparison',
        'versus',
        'vs',
        'between',
        'which is better',
        'better than',
        'differ from',
        'contrast',
      ];
      const lowerQuery = query.toLowerCase();
      return comparisonKeywords.some(keyword => lowerQuery.includes(keyword));
    }
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
   * Generate search queries for product catalog/overview requests
   */
  private async generateCatalogSearchQueries(
    query: string,
    companyContext?: QueryExpansionOptions['companyContext'],
    maxQueries: number = 8
  ): Promise<string[]> {
    const contextInfo = {
      companyName: companyContext?.companyName || env.COMPANY_NAME,
      companyDescription: companyContext?.companyDescription || env.COMPANY_DESCRIPTION,
      productCategories: companyContext?.productCategories || env.PRODUCT_CATEGORIES,
    };

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: "system",
            content: `You are an expert at generating search queries for product catalog overview.
The user wants to know about ALL products and product types offered by the company.

Context:
- Company: ${contextInfo.companyName}
- Description: ${contextInfo.companyDescription}
- Product Categories: ${contextInfo.productCategories}

Generate ${maxQueries} diverse search queries that will help retrieve information about ALL different products and categories.

Guidelines:
1. Include queries for product categories and types
2. Include queries for product lineup and collections
3. Include specific product name queries for known products
4. Include feature-based queries that span multiple products
5. Include benefit/use-case queries that cover different products
6. Vary the query structure to maximize coverage

Examples:
- "product categories lineup collection"
- "all products available orthopedic medical"
- "foot care products ball metatarsal heel arch support"
- "insoles cushions pads gel silicone products"
- "[specific product name] features specifications"

Return JSON:
{
  "queries": ["query1", "query2", "query3", ...]
}`
          },
          { role: "user", content: query },
        ],
        max_completion_tokens: 800,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content || '{"queries": []}';
      const result = JSON.parse(content);

      console.log(`📚 Generated ${result.queries?.length || 0} catalog search queries`);

      return result.queries || [query];
    } catch (error) {
      console.error('Error generating catalog queries:', error);
      // Fallback queries for catalog
      return [
        "all products product categories types",
        "product lineup collection catalog",
        "foot care orthopedic medical products",
        "insoles cushions pads gel products",
        "arch support heel pain relief products",
        query
      ];
    }
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

    if (queryMatches.length > 0) {
      console.log(`🔍 Detected Products in Query: ${queryMatches.map(m => `"${m.product.name}" (Score: ${m.score.toFixed(2)})`).join(', ')}`);
    } else {
      console.log(`🔍 No products detected in query: "${query}"`);
    }

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
   * Detect if query is asking for recommendations or suggestions across a product category
   * These queries should NOT lock to a single product - they need to retrieve multiple products for comparison
   * 
   * Examples:
   * - "Which is the best back support cushion for car?" → TRUE (recommendation query)
   * - "Recommend a cushion for office use" → TRUE
   * - "Best mattress topper under 5000" → TRUE
   * - "Price of Mattress topper" → FALSE (specific product query)
   * - "Tell me about Frido Ultimate Pillow" → FALSE (specific product query)
   */
  private isRecommendationOrCategoryQuery(query: string): boolean {
    const lowerQuery = query.toLowerCase();

    // Patterns that indicate recommendation/category queries
    const recommendationPatterns = [
      /which\s+(is\s+)?(the\s+)?best/i,           // "which is the best...", "which best..."
      /what\s+(is\s+)?(the\s+)?best/i,            // "what is the best...", "what best..."
      /recommend\s+(a|me|some)/i,                  // "recommend a...", "recommend me..."
      /suggest\s+(a|me|some)/i,                    // "suggest a...", "suggest me..."
      /best\s+\w+\s+(for|under|below|around)/i,   // "best cushion for...", "best mattress under..."
      /which\s+\w+\s+(should|would|can)\s+i/i,    // "which product should I buy"
      /good\s+\w+\s+for/i,                         // "good cushion for..."
      /suitable\s+\w+\s+for/i,                     // "suitable product for..."
      /looking\s+for\s+(a|the|some)/i,            // "looking for a cushion..."
      /need\s+(a|some)\s+\w+\s+for/i,             // "need a cushion for..."
      /can\s+you\s+(suggest|recommend)/i,         // "can you suggest..."
      /what\s+\w+\s+(do\s+you|would\s+you)\s+recommend/i, // "what do you recommend"
      /options\s+for/i,                            // "options for back pain"
      /alternatives?\s+(for|to)/i,                 // "alternatives for...", "alternative to..."
    ];

    // Check if query matches any recommendation pattern
    for (const pattern of recommendationPatterns) {
      if (pattern.test(lowerQuery)) {
        return true;
      }
    }

    // Additional keyword-based detection
    const recommendationKeywords = [
      'which is best',
      'which one is best',
      'which should i',
      'which would you',
      'best option',
      'best choice',
      'top pick',
      'recommendation',
      'suggestions',
    ];

    for (const keyword of recommendationKeywords) {
      if (lowerQuery.includes(keyword)) {
        return true;
      }
    }

    return false;
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

