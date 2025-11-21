/**
 * Enhanced RAG Service
 * Production-grade RAG implementation with:
 * - Advanced query expansion with fuzzy product matching
 * - Multi-query retrieval for better recall
 * - Reranking for improved relevance
 * - Contextual compression for efficiency
 * - Dynamic chunk selection
 * - Iterative refinement
 * - Self-reflection and quality checks
 * - Configurable response formatting (Markdown/Plain text)
 */

import { advancedQueryExpander, ExpandedQuery } from "../components/advancedQueryExpander.js";
import { reranker, RankedResult } from "../components/reranker.js";
import { contextualCompressor, CompressedChunk } from "../components/contextualCompressor.js";
import { createEmbedding, createBatchEmbeddings } from "../providers/embeddingService.js";
import { qdrantService, SearchResult } from "../providers/qdrantHybrid.js";
import { inferenceProvider } from "../../../services/llm/inference.js";
import { detectResponseFormat } from "../../../utils/formatDetection.js";

export interface EnhancedRAGOptions {
  retrievalCount?: number;
  similarityThreshold?: number;
  productName?: string;
  intent?: string;
  skipGeneration?: boolean;
  companyContext?: {
    companyName?: string;
    companyDescription?: string;
    productCategories?: string;
  };
  // Advanced options
  useReranking?: boolean;
  useCompression?: boolean;
  useMultiQuery?: boolean;
  maxQueries?: number;
  finalChunkCount?: number;
  enableIterativeRefinement?: boolean;
  formatAsMarkdown?: boolean; // If true, beautify response in .md format; if false, plain text with structure
}

export interface EnhancedRAGResponse {
  query: string;
  response: string;
  responseFormat?: 'table' | 'markdown' | 'text';
  sources: Array<{
    documentId: number;
    filename: string;
    content: string;
    score: number;
    metadata?: any;
    sourceUrl?: string;
    uploadType?: string;
    relevanceScore?: number;
  }>;
  contextAnalysis: {
    isContextMissing: boolean;
    suggestedTopics: string[];
    category: string;
    priority: 'low' | 'medium' | 'high';
  };
  performance: {
    queryExpansion: number;
    retrieval: number;
    reranking: number;
    compression: number;
    generation: number;
    total: number;
  };
  metadata: {
    expandedQuery?: ExpandedQuery;
    retrievedChunks: number;
    rerankedChunks: number;
    finalChunks: number;
    compressionRatio?: number;
  };
}

export class EnhancedRAGService {
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
    /cannot answer.*question/i,
    /therefore.*cannot answer/i,
    /unable to answer.*question/i,
    /context.*does not include/i,
    /provided context.*does not/i,
    /provided documents.*do not contain/i,
  ];

  /**
   * Analyze query to determine desired response format (Table, Markdown, etc.)
   */
  private async analyzeResponseStyle(query: string): Promise<'markdown' | 'table' | 'text'> {
    const systemPrompt = `You are a query analyzer. Determine the desired output format based on the user's request.
Options:
- "table": If the user explicitly requests a table, comparison matrix, grid, or structured rows/columns.
- "markdown": Default for general queries, explanations, lists, or when markdown is requested.

Query: ${query}

Return ONLY one word: "table" or "markdown".`;

    try {
      const result = await inferenceProvider.chatCompletion(
        systemPrompt,
        "Determine format",
        { temperature: 0, maxTokens: 10 }
      );
      
      const normalized = result.toLowerCase().trim();
      if (normalized.includes('table')) return 'table';
      return 'markdown';
    } catch (e) {
      return 'markdown'; // Fallback
    }
  }

  /**
   * Main query method with enhanced RAG pipeline
   */
  async query(query: string, options: EnhancedRAGOptions = {}): Promise<EnhancedRAGResponse> {
    const startTime = Date.now();
    const performance = {
      queryExpansion: 0,
      retrieval: 0,
      reranking: 0,
      compression: 0,
      generation: 0,
      total: 0,
    };

    const {
      retrievalCount = 30,
      similarityThreshold = 0.5,
      productName = "",
      intent = "query",
      skipGeneration = false,
      companyContext,
      useReranking = true,
      useCompression = true,
      useMultiQuery = true,
      maxQueries = 5,
      finalChunkCount = 10,
      enableIterativeRefinement = false,
      formatAsMarkdown = false,
    } = options;

    try {

      // ==================== Step 1: Query Expansion ====================
      const expandStart = Date.now();
      const expandedQuery = await advancedQueryExpander.expandQuery(query, {
        companyContext,
        productName,
        maxQueries: useMultiQuery ? maxQueries : 1,
      });
      performance.queryExpansion = Date.now() - expandStart;

      // If RAG not needed, return direct response
      if (!expandedQuery.needsRAG && expandedQuery.directResponse) {
        performance.total = Date.now() - startTime;
        return {
          query,
          response: expandedQuery.directResponse,
          responseFormat: formatAsMarkdown ? detectResponseFormat(expandedQuery.directResponse) : 'text',
          sources: [],
          contextAnalysis: {
            isContextMissing: false,
            suggestedTopics: [],
            category: expandedQuery.queryType,
            priority: 'low',
          },
          performance,
          metadata: {
            expandedQuery,
            retrievedChunks: 0,
            rerankedChunks: 0,
            finalChunks: 0,
          },
        };
      }

      // ==================== Step 2: Multi-Query Retrieval ====================
      const retrievalStart = Date.now();
      let allRetrievedChunks: SearchResult[];
      
      // Handle different query types with appropriate retrieval strategies
      if (expandedQuery.isProductCatalogQuery) {
        console.log(`\n📚 Product Catalog Query Mode`);
        console.log(`  - Retrieving diverse product information`);
        
        // For catalog queries, increase retrieval count and lower threshold to get diverse results
        allRetrievedChunks = await this.catalogRetrieval(
          expandedQuery.searchQueries,
          Math.max(retrievalCount * 2, 50), // Get more chunks for catalog queries
          Math.min(similarityThreshold, 0.4) // Lower threshold for broader coverage
        );
      } else if (expandedQuery.isMultiProductQuery && expandedQuery.comparisonProducts) {
        console.log(`\n🔄 Multi-Product Comparison Mode`);
        console.log(`  - Products: ${expandedQuery.comparisonProducts.join(' vs ')}`);
        
        allRetrievedChunks = await this.multiProductRetrieval(
          expandedQuery.searchQueries,
          expandedQuery.comparisonProducts,
          retrievalCount,
          similarityThreshold
        );
      } else {
        // Standard multi-query retrieval
        allRetrievedChunks = await this.multiQueryRetrieval(
          expandedQuery.searchQueries,
          expandedQuery.detectedProducts[0] || productName,
          retrievalCount,
          similarityThreshold
        );
      }
      
      performance.retrieval = Date.now() - retrievalStart;

      if (allRetrievedChunks.length === 0) {
        const noResultsResponse = "I don't have enough information in the uploaded documents to answer this question. Please try uploading relevant documents first.";
        const contextAnalysis = this.analyzeForMissingContext(query, noResultsResponse);

        performance.total = Date.now() - startTime;
        return {
          query,
          response: noResultsResponse,
          responseFormat: 'text',
          sources: [],
          contextAnalysis: { ...contextAnalysis, isContextMissing: true },
          performance,
          metadata: {
            expandedQuery,
            retrievedChunks: 0,
            rerankedChunks: 0,
            finalChunks: 0,
          },
        };
      }

      // ==================== Step 3: Reranking ====================
      let rankedChunks: RankedResult[];
      const rerankStart = Date.now();
      
      if (useReranking) {
        // ⚡ OPTIMIZATION: Use fast reranking for simple queries
        const isSimpleQuery = !expandedQuery.isMultiProductQuery && 
                              expandedQuery.searchQueries.length <= 2 &&
                              expandedQuery.queryType !== 'comparison';
        
        if (isSimpleQuery) {
          rankedChunks = reranker.fastRerank(
            allRetrievedChunks, 
            expandedQuery.normalizedQuery, 
            Math.min(finalChunkCount * 2, allRetrievedChunks.length)
          );
        } else {
          rankedChunks = await reranker.rerank(allRetrievedChunks, {
            query: expandedQuery.normalizedQuery,
            topK: Math.min(finalChunkCount * 2, allRetrievedChunks.length),
            useMultiCriteria: true,
          });
        }
        performance.reranking = Date.now() - rerankStart;
      } else {
        // Use fast reranking
        rankedChunks = reranker.fastRerank(
          allRetrievedChunks, 
          expandedQuery.normalizedQuery, 
          finalChunkCount * 2
        );
        performance.reranking = Date.now() - rerankStart;
      }

      // ==================== Step 4: Contextual Compression ====================
      let finalChunks: Array<{
        id: string;
        content: string;
        originalData: RankedResult;
      }>;

      if (useCompression) {
        const compressStart = Date.now();
        const compressed = await contextualCompressor.compress(rankedChunks, {
          query: expandedQuery.normalizedQuery,
          maxTokensPerChunk: 400,
          aggressiveCompression: false,
        });
        performance.compression = Date.now() - compressStart;

        // Take top N compressed chunks
        const topCompressed = compressed.slice(0, finalChunkCount);
        
        finalChunks = topCompressed.map((chunk, index) => ({
          id: `chunk_${index}`,
          content: `[CHUNK_ID: chunk_${index}] [From: ${rankedChunks.find(r => r.chunkId === chunk.originalChunkId)?.filename || 'unknown'}]\n${chunk.compressedContent}`,
          originalData: rankedChunks.find(r => r.chunkId === chunk.originalChunkId)!,
        }));

      } else {
        // No compression, use top ranked chunks
        finalChunks = rankedChunks.slice(0, finalChunkCount).map((chunk, index) => ({
          id: `chunk_${index}`,
          content: `[CHUNK_ID: chunk_${index}] [From: ${chunk.filename}]\n${chunk.content}`,
          originalData: chunk,
        }));
      }

      // ==================== Step 5: Skip Generation if Requested ====================
      if (skipGeneration) {
        const sources = this.prepareSources(finalChunks);
        performance.total = Date.now() - startTime;

        return {
          query,
          response: "",
          responseFormat: 'text',
          sources,
          contextAnalysis: {
            isContextMissing: false,
            suggestedTopics: [],
            category: 'answered',
            priority: 'low',
          },
          performance,
          metadata: {
            expandedQuery,
            retrievedChunks: allRetrievedChunks.length,
            rerankedChunks: rankedChunks.length,
            finalChunks: finalChunks.length,
          },
        };
      }

      // ==================== Step 6: Response Generation ====================
      const genStart = Date.now();
      let responseData;

      // Determine response style
      let responseStyle: 'markdown' | 'table' | 'text' = formatAsMarkdown ? 'markdown' : 'text';
      
      if (formatAsMarkdown) {
        // Analyze if user wants a table
        const detectedStyle = await this.analyzeResponseStyle(query);
        if (detectedStyle === 'table') {
          responseStyle = 'table';
        }
      }
      
      // Choose appropriate generation strategy based on query type
      if (expandedQuery.isProductCatalogQuery) {
        // Use catalog-specific generation for product overview queries
        responseData = await this.generateCatalogResponse(
          expandedQuery.normalizedQuery,
          finalChunks,
          responseStyle
        );
      } else if (expandedQuery.isMultiProductQuery && expandedQuery.comparisonProducts) {
        // Use comparison-specific generation for multi-product queries
        responseData = await this.generateComparisonResponse(
          expandedQuery.normalizedQuery,
          finalChunks,
          expandedQuery.comparisonProducts,
          responseStyle
        );
      } else if (intent === "query") {
        responseData = await this.generateResponse(expandedQuery.normalizedQuery, finalChunks, responseStyle);
      } else {
        responseData = await this.generateSalesAgentResponse(expandedQuery.normalizedQuery, finalChunks);
      }
      
      performance.generation = Date.now() - genStart;
      performance.total = Date.now() - startTime;

      // ==================== Step 8: Analyze Response ====================
      const contextAnalysis = this.analyzeForMissingContext(query, responseData.response);

      // Prepare sources
      const usedChunks = responseData.usedChunkIds.length > 0
        ? finalChunks.filter(chunk => responseData.usedChunkIds.includes(chunk.id))
        : finalChunks;

      const sources = this.prepareSources(usedChunks);

      return {
        query,
        response: responseData.response, // Use the beautified response, not the raw one
        responseFormat: formatAsMarkdown ? detectResponseFormat(responseData.response) : 'text',
        sources,
        contextAnalysis,
        performance,
        metadata: {
          expandedQuery,
          retrievedChunks: allRetrievedChunks.length,
          rerankedChunks: rankedChunks.length,
          finalChunks: finalChunks.length,
        },
      };

    } catch (error: any) {
      console.error("❌ Enhanced RAG query failed:", error);
      throw new Error(`Failed to process query: ${error.message}`);
    }
  }

  /**
   * Catalog retrieval - retrieve diverse chunks covering all products
   */
  private async catalogRetrieval(
    searchQueries: string[],
    retrievalCount: number,
    similarityThreshold: number
  ): Promise<SearchResult[]> {
    console.log(`📚 Catalog retrieval with ${searchQueries.length} queries`);
    
    // Create embeddings for all queries in batch
    const queryEmbeddings = await createBatchEmbeddings(searchQueries);
    
    // Use a Map to track unique products and their best chunks
    const productChunks = new Map<string, SearchResult[]>();
    const seenChunkIds = new Set<number>();
    
    for (let i = 0; i < searchQueries.length; i++) {
      const query = searchQueries[i];
      const embedding = queryEmbeddings[i];
      
      // Search without product filter to get diverse results
      const results = await qdrantService.searchSimilar(
        embedding,
        retrievalCount,
        similarityThreshold,
        undefined // No product filter for catalog queries
      );
      
      // Group results by product
      for (const result of results) {
        if (seenChunkIds.has(result.chunkId)) continue;
        
        const productName = result.metadata?.productName || 'general';
        
        if (!productChunks.has(productName)) {
          productChunks.set(productName, []);
        }
        
        const chunks = productChunks.get(productName)!;
        // Keep top 3 chunks per product to ensure diversity
        if (chunks.length < 3) {
          chunks.push(result);
          seenChunkIds.add(result.chunkId);
        }
      }
    }
    
    // Flatten the results, ensuring we have representation from multiple products
    const allResults: SearchResult[] = [];
    for (const [productName, chunks] of productChunks) {
      console.log(`  - Product "${productName}": ${chunks.length} chunks`);
      allResults.push(...chunks);
    }
    
    console.log(`📚 Total unique products found: ${productChunks.size}`);
    console.log(`📚 Total chunks retrieved: ${allResults.length}`);
    
    return allResults;
  }

  /**
   * Multi-query retrieval - retrieve using multiple query variations and merge results
   */
  private async multiQueryRetrieval(
    searchQueries: string[],
    productName: string,
    retrievalCount: number,
    similarityThreshold: number
  ): Promise<SearchResult[]> {

    // Create embeddings for all queries in batch
    const queryEmbeddings = await createBatchEmbeddings(searchQueries);

    // Search with each query embedding
    const allResults: SearchResult[] = [];
    const seenChunkIds = new Set<number>();

    for (let i = 0; i < searchQueries.length; i++) {
      const query = searchQueries[i];
      const embedding = queryEmbeddings[i];

      const results = await qdrantService.searchSimilar(
        embedding,
        retrievalCount,
        similarityThreshold,
        productName?.trim()
      );

      // Add unique results
      for (const result of results) {
        if (!seenChunkIds.has(result.chunkId)) {
          allResults.push(result);
          seenChunkIds.add(result.chunkId);
        }
      }
    }

    return allResults;
  }

  /**
   * Multi-product retrieval - retrieve chunks for each product separately
   * Used for comparison queries to ensure balanced representation
   */
  private async multiProductRetrieval(
    searchQueries: string[],
    products: string[],
    retrievalCount: number,
    similarityThreshold: number
  ): Promise<SearchResult[]> {
    console.log("🚀 ~ EnhancedRAGService ~ multiProductRetrieval ~ products:", products);
    console.log("🚀 ~ EnhancedRAGService ~ multiProductRetrieval ~ searchQueries:", searchQueries);

    const allResults: SearchResult[] = [];
    const seenChunkIds = new Set<number>();

    // Group queries by product (queries should have product names in them)
    const queryGroups = this.groupQueriesByProduct(searchQueries, products);

    // Retrieve chunks for each product
    for (const [product, productQueries] of Object.entries(queryGroups)) {
      if (productQueries.length === 0) {
        console.log(`⚠️ No queries found for product "${product}", skipping retrieval.`);
        continue;
      }
      
      // 🚀 Ensure whitespace is trimmed from product name before retrieval
      const trimmedProduct = product.trim();

      console.log(`🔍 Retrieving for product "${trimmedProduct}" with ${productQueries.length} queries...`);

      // Create embeddings for this product's queries
      const embeddings = await createBatchEmbeddings(productQueries);

      // Search with each query
      for (let i = 0; i < productQueries.length; i++) {
        const query = productQueries[i];
        const embedding = embeddings[i];

        const results = await qdrantService.searchSimilar(
          embedding,
          retrievalCount,
          similarityThreshold,
          trimmedProduct // Filter by specific product
        );

        // Add unique results
        for (const result of results) {
          if (!seenChunkIds.has(result.chunkId)) {
            allResults.push(result);
            seenChunkIds.add(result.chunkId);
          }
        }
      }
    }

    return allResults;
  }

  /**
   * Group queries by product
   */
  private groupQueriesByProduct(queries: string[], products: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    
    // Initialize groups
    products.forEach(product => {
      groups[product] = [];
    });

    // Sort products by length descending to match specific names first
    // e.g. "Frido Dual Gel Insoles Pro" (longer) before "Frido Dual Gel Insoles" (shorter)
    const sortedProducts = [...products].sort((a, b) => b.length - a.length);

    // Assign queries to products based on which product name they contain
    for (const query of queries) {
      const lowerQuery = query.toLowerCase();
      for (const product of sortedProducts) {
        const lowerProduct = product.toLowerCase();
        if (lowerQuery.includes(lowerProduct)) {
          groups[product].push(query);
          break; // Each query goes to one product
        }
      }
    }

    return groups;
  }

  /**
   * Count chunks by product
   */
  private countChunksByProduct(chunks: SearchResult[], products: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    
    products.forEach(product => {
      counts[product] = 0;
    });

    for (const chunk of chunks) {
      const productName = chunk.metadata?.productName;
      if (productName && products.includes(productName)) {
        counts[productName]++;
      }
    }

    return counts;
  }

  /**
   * Generate response for informational queries
   */
  private async generateResponse(
    query: string,
    contextChunks: Array<{ id: string; content: string; originalData: any }>,
    responseStyle: 'markdown' | 'table' | 'text' = 'text'
  ): Promise<{ response: string; usedChunkIds: string[] }> {
    
    let responseFormat = '';
    
    if (responseStyle === 'table') {
      responseFormat = `
You are a professional technical writer.
Respond in a **Markdown Table** format.
- Create a clear table with relevant columns based on the query.
- If comparing items, use the items as rows or columns as appropriate.
- Ensure the table is well-formatted.
- Add a brief introductory sentence before the table and a brief summary after.
`;
    } else if (responseStyle === 'markdown') {
      responseFormat = `
You are a professional technical writer.  
Respond in **beautifully formatted Markdown** that feels natural and easy to read.  
Use clear structure, meaningful headings, bullet points, and occasional bold or italics where it enhances readability.  
Avoid over-formatting or unnecessary symbols.  
`;
    } else {
      responseFormat = `
You are a professional technical writer.  
Respond in **plain text only** — no Markdown or special characters.  
Keep the response well-structured, easy to scan, and naturally formatted using simple section titles and bullet points.  
`;
    }

    const systemPrompt = `You are an AI assistant helping users find information about products.
    
    QUERY: ${query}

    CRITICAL INSTRUCTIONS:
    1. **Direct Answer First:** Always begin your response with the specific information found in the provided context.
    2. **Context Priority:** Use the provided context as the primary source. If the context contains details about specific products that answer the query (even partially), present those details immediately.
    3. **General Knowledge:** Use general knowledge ONLY to fill gaps *after* the specific answer, or if the context is completely missing the answer. Do NOT add generic lists, definitions, or "general knowledge" introductions before the specific answer.
    4. **Missing Information:** If the context is **completely missing** and you must rely *entirely* on general knowledge, start with: "The provided documents do not contain this specific information, but..."
    5. Never mention "chunk", "document", "source", or "context" in your response (except in the required disclaimer).
    6. Answer with confidence and clarity.
    7. Be comprehensive and cover all relevant aspects from the context.

    CITATION RULES:
    - IF you use information from the provided context, cite chunks using [USED_CHUNK: chunk_id] after each statement
    - Cite multiple chunks if information comes from multiple sources
    - Every factual statement from the context must have a citation

    ${responseFormat}

    Context from documents:
    ${contextChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`;

    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.4, maxTokens: 1200 }
    );

    // Extract used chunk IDs
    const usedChunkIds: string[] = [];
    const chunkIdPatterns = [
      /\[USED_CHUNK:\s*([^\]]+)\]/gi,
      /\[CHUNK_ID:\s*([^\]]+)\]/gi,
    ];

    chunkIdPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const chunkIdString = match[1];
        const individualIds = chunkIdString.split(',').map(id => id.trim());
        individualIds.forEach(id => {
          if (id && !usedChunkIds.includes(id)) {
            usedChunkIds.push(id);
          }
        });
      }
    });

    // Clean response - remove citation markers and format properly
    const cleanResponse = responseText
      .replace(/\[(?:USED_CHUNK|CHUNK_ID):\s*[^\]]+\]/gi, '')
      .replace(/\\n/g, '\n') // Convert literal \n to actual newlines
      .replace(/ +/g, ' ') // Collapse multiple spaces within lines
      .replace(/\n{3,}/g, '\n\n') // Collapse 3+ consecutive newlines to max 2
      .trim();

    return { response: cleanResponse, usedChunkIds };
  }

  /**
   * Generate comparison response for multi-product queries
   */
  private async generateComparisonResponse(
    query: string,
    contextChunks: Array<{ id: string; content: string; originalData: any }>,
    products: string[],
    responseStyle: 'markdown' | 'table' | 'text' = 'text'
  ): Promise<{ response: string; usedChunkIds: string[] }> {
    // Group chunks by product
    const chunksByProduct: Record<string, typeof contextChunks> = {};
    products.forEach(product => {
      chunksByProduct[product] = [];
    });

    for (const chunk of contextChunks) {
      const productName = chunk.originalData.metadata?.productName;
      if (productName && products.includes(productName)) {
        chunksByProduct[productName].push(chunk);
      }
    }

    // Build context organized by product
    const organizedContext = products.map(product => {
      const productChunks = chunksByProduct[product] || [];
      return `
=== ${product} ===
${productChunks.map(c => c.content).join('\n---\n')}
`;
    }).join('\n\n');

    let responseFormat = '';

    if (responseStyle === 'table') {
      responseFormat = `COMPARISON FORMAT - TABLE:
- Present the comparison as a **Markdown Table**.
- Columns should be the Products being compared.
- Rows should be the Features/Specifications/Aspects being compared.
- Add a brief introductory sentence before the table and a brief summary after.
- Ensure the table is clean and readable.`;
    } else if (responseStyle === 'markdown') {
      responseFormat = `COMPARISON FORMAT - MARKDOWN:
- Use proper Markdown formatting
- Start with "## Overview" describing both products briefly
- **IMPORTANT: Wrap all product names in bold using **Product Name** format throughout the entire response**
- Create clear comparison sections with headers:
  ## Features Comparison
  ## Specifications Comparison
  ## Design & Comfort
  ## Use Cases & Benefits
- Add a blank line after EVERY header before content starts
- Within each section, use bullet points with bold product names: "- **Product A**: ..." and "- **Product B**: ..."
- Use "  - " (2 spaces + dash) for nested details
- Add blank lines between sections
- End with "## Summary" highlighting key differences and recommendations`;
    } else {
      responseFormat = `COMPARISON FORMAT - PLAIN TEXT:
- Write in PLAIN TEXT only - NO markdown symbols (no ##, no **, no decorative characters)
- Start with "Overview" describing both products briefly
- Create clear comparison sections with section headers:
  Overview
  Features Comparison
  Specifications Comparison
  Design & Comfort
  Use Cases & Benefits
- Add a blank line after each section header
- Within each section, use bullet points "- Product A: ..." and "- Product B: ..."
- Use "  - " (2 spaces + dash) for nested details
- Add blank lines between sections
- End with "Summary" highlighting key differences and recommendations`;
    }

    const systemPrompt = `You are an AI assistant helping users compare products.

QUERY: ${query}

PRODUCTS TO COMPARE: ${products.join(' vs ')}

CRITICAL INSTRUCTIONS:
1. Provide a STRUCTURED COMPARISON of the products
2. Use ONLY the provided context - never use external knowledge
3. Organize your response with clear sections for each comparison aspect
4. Be objective and factual - highlight both similarities and differences
5. If information is missing for a product, explicitly state that
6. Cite chunks using [USED_CHUNK: chunk_id] after each statement

${responseFormat}

Context organized by product:
${organizedContext}`;

    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.1, maxTokens: 1500 }
    );

    // Extract used chunk IDs
    const usedChunkIds: string[] = [];
    const chunkIdPatterns = [
      /\[USED_CHUNK:\s*([^\]]+)\]/gi,
      /\[CHUNK_ID:\s*([^\]]+)\]/gi,
    ];

    chunkIdPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const chunkIdString = match[1];
        const individualIds = chunkIdString.split(',').map(id => id.trim());
        individualIds.forEach(id => {
          if (id && !usedChunkIds.includes(id)) {
            usedChunkIds.push(id);
          }
        });
      }
    });

    // Clean response - remove citation markers and format properly
    const cleanResponse = responseText
      .replace(/\[(?:USED_CHUNK|CHUNK_ID):\s*[^\]]+\]/gi, '')
      .replace(/\\n/g, '\n') // Convert literal \n to actual newlines
      .replace(/ +/g, ' ') // Collapse multiple spaces within lines
      .replace(/\n{3,}/g, '\n\n') // Collapse 3+ consecutive newlines to max 2
      .trim();

    return { response: cleanResponse, usedChunkIds };
  }

  /**
   * Generate catalog/overview response for product listing queries
   */
  private async generateCatalogResponse(
    query: string,
    contextChunks: Array<{ id: string; content: string; originalData: any }>,
    responseStyle: 'markdown' | 'table' | 'text' = 'text'
  ): Promise<{ response: string; usedChunkIds: string[] }> {
    // Group chunks by product to understand what products are available
    const productInfo = new Map<string, Array<{ id: string; content: string }>>();
    
    for (const chunk of contextChunks) {
      const productName = chunk.originalData.metadata?.productName || 'General Information';
      if (!productInfo.has(productName)) {
        productInfo.set(productName, []);
      }
      productInfo.get(productName)!.push({ id: chunk.id, content: chunk.content });
    }

    console.log(`📚 Generating catalog response for ${productInfo.size} products`);

    let responseFormat = '';

    if (responseStyle === 'table') {
      responseFormat = `CATALOG FORMAT - TABLE:
- Present the product catalog as a **Markdown Table**.
- Columns should include: Product Name, Key Features, Use Case, etc.
- List each product as a row.
- Add a brief introductory sentence before the table and a brief summary after.`;
    } else if (responseStyle === 'markdown') {
      responseFormat = `CATALOG FORMAT - MARKDOWN:
- Use proper Markdown formatting with headers and structure
- Start with "## Product Overview" or "## Our Product Lineup"
- List each product/category with a brief description
- Use bullet points or numbered lists for clear organization
- Include key features and benefits for each product
- Use bold for product names: **Product Name**
- Add sections like "## Product Categories" if multiple categories exist`;
    } else {
      responseFormat = `CATALOG FORMAT - PLAIN TEXT:
- Write in PLAIN TEXT only - NO markdown symbols
- Start with "Product Overview" or "Our Product Lineup"
- List each product/category with a brief description
- Use simple bullet points "-" for organization
- Include key features and benefits for each product
- Keep formatting clean and readable`;
    }

    const systemPrompt = `You are an AI assistant providing a comprehensive product catalog overview.

QUERY: ${query}

CRITICAL INSTRUCTIONS:
1. Provide a COMPLETE overview of ALL products/categories found in the context
2. List each distinct product or product type with its key characteristics
3. Use ONLY the provided context - never use external knowledge
4. Organize products logically (by category, type, or use case)
5. Include brief descriptions of what each product is for
6. If you find multiple products, list them ALL
7. Cite chunks using [USED_CHUNK: chunk_id] after each statement

IMPORTANT: This is a catalog/overview query. The user wants to know about ALL available products, not just one.

${responseFormat}

Products found in context (${productInfo.size} distinct products):
${Array.from(productInfo.keys()).join(', ')}

Context from documents:
${contextChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`;

    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.1, maxTokens: 1500 }
    );

    // Extract used chunk IDs
    const usedChunkIds: string[] = [];
    const chunkIdPatterns = [
      /\[USED_CHUNK:\s*([^\]]+)\]/gi,
      /\[CHUNK_ID:\s*([^\]]+)\]/gi,
    ];

    chunkIdPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const chunkIdString = match[1];
        const individualIds = chunkIdString.split(',').map(id => id.trim());
        individualIds.forEach(id => {
          if (id && !usedChunkIds.includes(id)) {
            usedChunkIds.push(id);
          }
        });
      }
    });

    // Clean response - remove citation markers and format properly
    const cleanResponse = responseText
      .replace(/\[(?:USED_CHUNK|CHUNK_ID):\s*[^\]]+\]/gi, '')
      .replace(/\\n/g, '\n')
      .replace(/ +/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return { response: cleanResponse, usedChunkIds };
  }

  /**
   * Generate sales agent response
   */
  private async generateSalesAgentResponse(
    query: string,
    contextChunks: Array<{ id: string; content: string; originalData: any }>
  ): Promise<{ response: string; usedChunkIds: string[] }> {
    const systemPrompt = `You are a friendly, consultative sales agent.
Style: natural, human, second-person, approachable; mirror user's wording; avoid jargon.
Goal: understand need, recommend from ONLY provided context, highlight 2-3 benefits, propose clear CTA.
Constraints: ≤80 words; single short paragraph; no bullets, no lists, no bold; factual only.

Context:
${contextChunks.map(c => c.content).join('\n\n---\n\n')}

IMPORTANT: Cite chunks using [USED_CHUNK: chunk_id]`;

    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.4, maxTokens: 240 }
    );

    // Extract used chunk IDs
    const usedChunkIds: string[] = [];
    const chunkIdPatterns = [
      /\[USED_CHUNK:\s*([^\]]+)\]/gi,
      /\[CHUNK_ID:\s*([^\]]+)\]/gi,
    ];

    chunkIdPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        const chunkIdString = match[1];
        const individualIds = chunkIdString.split(',').map(id => id.trim());
        individualIds.forEach(id => {
          if (id && !usedChunkIds.includes(id)) {
            usedChunkIds.push(id);
          }
        });
      }
    });

    // Clean response - remove citation markers, collapse all whitespace (sales agent is single paragraph)
    const cleanResponse = responseText
      .replace(/\[(?:USED_CHUNK|CHUNK_ID):\s*[^\]]+\]/gi, '')
      .replace(/\\n/g, ' ') // Convert literal \n to space (sales agent is single paragraph)
      .replace(/\s+/g, ' ') // Collapse all whitespace to single space (single paragraph format)
      .trim();

    return { response: cleanResponse, usedChunkIds };
  }

  /**
   * Prepare sources from chunks
   */
  private prepareSources(
    chunks: Array<{ id: string; content: string; originalData: any }>
  ): EnhancedRAGResponse['sources'] {
    const uniqueSourceUrls = new Set<string>();
    return chunks
      .filter(chunk => {
        const sourceUrl = chunk.originalData.metadata?.sourceUrl;
        if (!sourceUrl) return true;
        if (uniqueSourceUrls.has(sourceUrl)) return false;
        uniqueSourceUrls.add(sourceUrl);
        return true;
      })
      .map(chunk => ({
        documentId: chunk.originalData.documentId,
        filename: chunk.originalData.filename,
        content: '',
        score: chunk.originalData.score,
        relevanceScore: chunk.originalData.relevanceScore || chunk.originalData.score,
        metadata: [],
        sourceUrl: chunk.originalData.metadata?.sourceUrl,
        uploadType: chunk.originalData.metadata?.uploadType,
      }));
  }

  /**
   * Analyze if response indicates missing context
   */
  private analyzeForMissingContext(query: string, response: string): {
    isContextMissing: boolean;
    suggestedTopics: string[];
    category: string;
    priority: 'low' | 'medium' | 'high';
  } {
    const detectedPatterns = this.MISSING_CONTEXT_PATTERNS.filter(pattern => pattern.test(response));
    const isContextMissing = detectedPatterns.length > 0;

    if (!isContextMissing) {
      return {
        isContextMissing: false,
        suggestedTopics: [],
        category: 'answered',
        priority: 'low',
      };
    }

    // Simple analysis
    const analysis = this.analyzeQuery(query);
    return {
      isContextMissing: true,
      suggestedTopics: analysis.suggestedTopics,
      category: analysis.category,
      priority: analysis.priority,
    };
  }

  /**
   * Simple query analysis
   */
  private analyzeQuery(query: string): {
    suggestedTopics: string[];
    category: string;
    priority: 'low' | 'medium' | 'high';
  } {
    const suggestedTopics: string[] = [];
    let category = 'other';
    let priority: 'low' | 'medium' | 'high' = 'medium';

    const words = query.toLowerCase().split(/\s+/);
    const technicalTerms = ['api', 'sdk', 'code', 'function', 'integration'];
    const businessTerms = ['price', 'cost', 'plan', 'billing'];
    const processTerms = ['how to', 'steps', 'process'];

    if (words.some(word => technicalTerms.includes(word))) {
      category = 'technical';
      suggestedTopics.push('technical documentation');
    } else if (words.some(word => businessTerms.includes(word))) {
      category = 'business';
      suggestedTopics.push('pricing information');
    } else if (words.some(word => processTerms.includes(word))) {
      category = 'process';
      suggestedTopics.push('user guides');
    }

    return { suggestedTopics, category, priority };
  }
}

export const enhancedRAGService = new EnhancedRAGService();

