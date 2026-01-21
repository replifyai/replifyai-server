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
import { encodeMetadataToToon } from "../../../utils/toonFormatter.js";

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
    /no.*information.*available/i,
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
    /no information.*about/i,
    /not mentioned/i,
    /not find any information/i,
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

        // 🚀 OPTIMIZATION: Use scoped semantic search + reranking for comparison
        // This avoids fetching ALL chunks which causes context overflow
        const comparisonChunksByProduct = await this.fetchAllChunksForProducts(
          expandedQuery.comparisonProducts,
          expandedQuery.normalizedQuery
        );

        // Process comparison with pre-organized chunks
        performance.retrieval = Date.now() - retrievalStart;

        if (Object.values(comparisonChunksByProduct).every(chunks => chunks.length === 0)) {
          const noResultsResponse = "I don't have enough information in the uploaded documents to answer this question. Please try uploading relevant documents first.";
          const contextAnalysis = await this.analyzeForMissingContext(query, noResultsResponse);

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

        // Skip standard flow and go directly to comparison generation
        const genStart = Date.now();
        let responseStyle: 'markdown' | 'table' | 'text' = formatAsMarkdown ? 'markdown' : 'text';
        if (formatAsMarkdown) {
          const detectedStyle = await this.analyzeResponseStyle(query);
          if (detectedStyle === 'table') {
            responseStyle = 'table';
          }
        }

        const responseData = await this.generateDirectComparisonResponse(
          expandedQuery.normalizedQuery,
          comparisonChunksByProduct,
          expandedQuery.comparisonProducts,
          responseStyle
        );

        performance.generation = Date.now() - genStart;
        performance.total = Date.now() - startTime;

        const contextAnalysis = await this.analyzeForMissingContext(query, responseData.response);

        // Prepare sources from all products
        const allChunks = Object.values(comparisonChunksByProduct).flat();
        const sources = this.prepareSources(
          allChunks.map((chunk, idx) => ({
            id: `chunk_${idx}`,
            content: chunk.content,
            originalData: chunk,
          }))
        );

        return {
          query,
          response: responseData.response,
          responseFormat: formatAsMarkdown ? detectResponseFormat(responseData.response) : 'text',
          sources,
          contextAnalysis,
          performance,
          metadata: {
            expandedQuery,
            retrievedChunks: allChunks.length,
            rerankedChunks: allChunks.length,
            finalChunks: allChunks.length,
          },
        };
      } else if (expandedQuery.detectedProducts.length > 1) {
        // Multiple specific products detected (e.g., "Details of seating combos" -> 2 products)
        // Retrieve chunks for ALL detected products, not just the first one
        console.log(`\n🎯 Multi-Specific-Product Mode`);
        console.log(`  - Products: ${expandedQuery.detectedProducts.join(', ')}`);

        allRetrievedChunks = await this.multiProductRetrieval(
          expandedQuery.searchQueries,
          expandedQuery.detectedProducts,
          retrievalCount,
          similarityThreshold
        );
      } else {
        // Standard multi-query retrieval (single product or no product)
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
        const contextAnalysis = await this.analyzeForMissingContext(query, noResultsResponse);

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

        finalChunks = topCompressed.map((chunk, index) => {
          const sourceChunk = rankedChunks.find(r => r.chunkId === chunk.originalChunkId);
          const filename = sourceChunk?.filename || 'unknown';
          let content = `[CHUNK_ID: chunk_${index}] [From: ${filename}]\n${chunk.compressedContent}`;

          const metadataForEncoding = sourceChunk?.metadata ?? chunk.metadata;
          if (metadataForEncoding) {
            const toonMetadata = encodeMetadataToToon(metadataForEncoding, filename);
            if (toonMetadata) {
              content += `\n\nMetadata (Toon):\n${toonMetadata}`;
            }
          }

          const fallbackSource: RankedResult = sourceChunk ?? {
            chunkId: chunk.originalChunkId,
            documentId: chunk.metadata?.documentId ?? 0,
            content: chunk.originalContent,
            filename,
            score: chunk.relevanceScore,
            metadata: metadataForEncoding,
            relevanceScore: chunk.relevanceScore,
            completenessScore: chunk.relevanceScore,
            specificityScore: chunk.relevanceScore,
            finalScore: chunk.relevanceScore,
            rerankedPosition: index + 1,
          };

          return {
            id: `chunk_${index}`,
            content,
            originalData: fallbackSource,
          };
        });

      } else {
        // No compression, use top ranked chunks
        finalChunks = rankedChunks.slice(0, finalChunkCount).map((chunk, index) => {
          let content = `[CHUNK_ID: chunk_${index}] [From: ${chunk.filename}]\n${chunk.content}`;

          if (chunk.metadata) {
            const toonMetadata = encodeMetadataToToon(chunk.metadata, chunk.filename);
            if (toonMetadata) {
              content += `\n\nMetadata (Toon):\n${toonMetadata}`;
            }
          }

          return {
            id: `chunk_${index}`,
            content,
            originalData: chunk,
          };
        });
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
      const contextAnalysis = await this.analyzeForMissingContext(query, responseData.response);

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

      // Propagate specific connection errors
      if (error.message && error.message.includes("Having trouble connecting with server")) {
        throw error;
      }

      throw new Error(`Failed to process query: ${error.message}`);
    }
  }

  /**
   * 🚀 DIRECT FETCH: Fetch RELEVANT chunks for each product using semantic search + reranking
   * Used for comparison queries to avoid context overflow while maintaining relevance
   */
  private async fetchAllChunksForProducts(
    products: string[],
    query: string
  ): Promise<Record<string, SearchResult[]>> {
    const chunksByProduct: Record<string, SearchResult[]> = {};

    // Create embedding for semantic search
    const queryEmbedding = await createEmbedding(query);

    for (const product of products) {
      const trimmedProduct = product.trim();
      console.log(`📥 Fetching RELEVANT chunks for product: "${trimmedProduct}"`);

      try {
        // 1. Semantic search scoped to product (get top 50 candidates)
        const candidates = await qdrantService.searchSimilar(
          queryEmbedding,
          50,
          0.3, // Lower threshold for broad capture
          trimmedProduct
        );

        // 2. Rerank candidates to find most relevant ones
        const rankedChunks = reranker.fastRerank(
          candidates,
          query,
          10 // Keep top 10 chunks per product for comparison (total ~20-30 for 2-3 products)
        );

        // Map back to SearchResult format
        chunksByProduct[product] = rankedChunks.map(c => ({
          chunkId: c.chunkId,
          documentId: c.documentId,
          content: c.content,
          filename: c.filename,
          score: c.finalScore,
          metadata: c.metadata,
        }));

        console.log(`   ✅ Found ${candidates.length} candidates, keeping top ${rankedChunks.length} for "${trimmedProduct}"`);
      } catch (error) {
        console.error(`   ❌ Error fetching chunks for "${trimmedProduct}":`, error);
        chunksByProduct[product] = [];
      }
    }

    return chunksByProduct;
  }

  /**
   * 🚀 DIRECT COMPARISON: Generate comparison response with pre-organized chunks
   * This bypasses the grouping step which can fail due to product name matching
   */
  private async generateDirectComparisonResponse(
    query: string,
    chunksByProduct: Record<string, SearchResult[]>,
    products: string[],
    responseStyle: 'markdown' | 'table' | 'text' = 'text'
  ): Promise<{ response: string; usedChunkIds: string[] }> {
    // Build context organized by product - chunks are already pre-grouped
    const organizedContext = products.map(product => {
      const productChunks = chunksByProduct[product] || [];
      console.log(`📊 Building context for "${product}": ${productChunks.length} chunks`);

      // Format each chunk with metadata
      const formattedChunks = productChunks.map((chunk, idx) => {
        let content = `[CHUNK_ID: ${product}_chunk_${idx}]\n${chunk.content}`;

        // Include metadata if available
        if (chunk.metadata) {
          const toonMetadata = encodeMetadataToToon(chunk.metadata, chunk.filename);
          if (toonMetadata) {
            content += `\n\nMetadata:\n${toonMetadata}`;
          }
        }

        return content;
      });

      return `
=== ${product} (${productChunks.length} chunks) ===
${formattedChunks.join('\n---\n')}
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
  ## Specifications Comparison (MUST include weight, dimensions, price, materials)
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
- Create clear comparison sections:
  Overview
  Features Comparison
  Specifications Comparison (MUST include weight, dimensions, price, materials)
  Design & Comfort
  Use Cases & Benefits
- Add a blank line after each section header
- Within each section, use bullet points "- Product A: ..." and "- Product B: ..."
- End with "Summary" highlighting key differences and recommendations`;
    }

    const systemPrompt = `You are an AI assistant helping users compare products.

QUERY: ${query}

PRODUCTS TO COMPARE: ${products.join(' vs ')}

CRITICAL INSTRUCTIONS:
1. Provide a DETAILED COMPARISON of the products
2. Use ONLY the provided context - never use external knowledge
3. **EXTRACT ALL SPECIFICATIONS FROM EACH PRODUCT'S CHUNKS**:
   - Product Weight (look for "weight", "g", "gram", "kg")
   - Dimensions/Size
   - Price/MRP (look for "₹", "MRP", "price")
   - Material/Composition
   - Country of Origin
   - Manufacturer details
   - Available variants/sizes/colors
4. Each product's information is clearly separated in the context below
5. If a specification exists in ONE product but not the other, explicitly note this difference
6. Only say "Not available in provided data" if you've searched all chunks for that product and truly cannot find the information
7. Cite chunks using [USED_CHUNK: chunk_id] after each statement

${responseFormat}

CONTEXT - ORGANIZED BY PRODUCT:
${organizedContext}`;

    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.1, maxTokens: 2000 }
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

    // Clean response
    const cleanResponse = responseText
      .replace(/\[(?:USED_CHUNK|CHUNK_ID):\s*[^\]]+\]/gi, '')
      .replace(/\\n/g, '\n')
      .replace(/ +/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return { response: cleanResponse, usedChunkIds };
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
   * When a specific product is detected (locked), only retrieve chunks for that product.
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

    // Determine if we have a locked product (specific product detected)
    const hasLockedProduct = productName?.trim() !== '';

    if (hasLockedProduct) {
      console.log(`🔒 Product locked: "${productName}" - retrieving only matching chunks`);
    }

    for (let i = 0; i < searchQueries.length; i++) {
      const query = searchQueries[i];
      const embedding = queryEmbeddings[i];

      let results: SearchResult[];

      if (hasLockedProduct) {
        // 🔒 LOCKED PRODUCT MODE: Only search with product filter
        // Skip unfiltered search to prevent irrelevant products from polluting context
        results = await qdrantService.searchSimilar(
          embedding,
          retrievalCount,
          similarityThreshold,
          productName.trim()
        );
      } else {
        // NO PRODUCT LOCKED: Use broad search without filter
        results = await qdrantService.searchSimilar(
          embedding,
          retrievalCount,
          similarityThreshold,
          undefined
        );
      }

      // Add unique results
      for (const result of results) {
        if (!seenChunkIds.has(result.chunkId)) {
          allResults.push(result);
          seenChunkIds.add(result.chunkId);
        }
      }
    }

    if (hasLockedProduct) {
      console.log(`🔒 Retrieved ${allResults.length} chunks for locked product "${productName}"`);
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
      let productResults: SearchResult[] = [];
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
            productResults.push(result);
            allResults.push(result);
            seenChunkIds.add(result.chunkId);
          }
        }
      }

      // 🔄 FALLBACK: If no results for this product, try without filter
      // This handles case where product name doesn't exactly match in Qdrant
      if (productResults.length === 0) {
        console.log(`⚠️ No chunks found for "${trimmedProduct}" - trying unfiltered search...`);
        for (let i = 0; i < productQueries.length; i++) {
          const embedding = embeddings[i];
          const results = await qdrantService.searchSimilar(
            embedding,
            retrievalCount,
            similarityThreshold,
            undefined // No filter - rely on query terms
          );

          for (const result of results) {
            if (!seenChunkIds.has(result.chunkId)) {
              allResults.push(result);
              seenChunkIds.add(result.chunkId);
            }
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

    const systemPrompt = `You are an AI assistant helping sales agents find product information quickly.
    
    QUERY: ${query}

    RESPONSE RULES (CRITICAL):
    1. Sales agents need quick, scannable answers.
    2. **Key differentiator**: 1 line per product explaining WHY it fits the query.
    3. **No repetition**: Don't repeat the same features for multiple products.
    4. **No filler**: Skip phrases like "Additionally", "Furthermore", "It's worth noting".
    5. Never mention "chunk", "document", "source", or "context".
    6. Response should not be very big or very small. Depending on the query, adjust the response length.
    7. Response should completely answer the query. Do not over explain the response.


    CITATION RULES (MANDATORY):
    - After EACH factual statement from context, add: [USED_CHUNK: chunk_id]
    - If info comes from multiple chunks, cite all: [USED_CHUNK: chunk_0, chunk_1]
    - Every product detail MUST have a citation
    - Citations will be removed before showing to user

    FORMAT EXAMPLE:
    "For [use case]:
    • **Product A** — [key benefit] [USED_CHUNK: chunk_0]
    • **Product B** — [key benefit] [USED_CHUNK: chunk_2]
    
    Best for [specific need]: Product A."

    ${responseFormat}

    Context:
    ${contextChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`;

    const responseText = await inferenceProvider.chatCompletion(
      systemPrompt,
      query,
      { temperature: 0.4, maxTokens: 500 }
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
    // Group chunks by product using fuzzy/case-insensitive matching
    const chunksByProduct: Record<string, typeof contextChunks> = {};
    products.forEach(product => {
      chunksByProduct[product] = [];
    });

    // Helper function to find matching product using case-insensitive comparison
    const findMatchingProduct = (chunkProductName: string | undefined, chunkFilename: string | undefined): string | null => {
      if (!chunkProductName && !chunkFilename) return null;

      // Normalize strings for comparison
      const normalize = (str: string) => str.toLowerCase().trim().replace(/\s+/g, ' ');

      // Try to match against product names
      for (const product of products) {
        const normalizedProduct = normalize(product);

        // Check metadata productName (case-insensitive)
        if (chunkProductName && normalize(chunkProductName) === normalizedProduct) {
          return product;
        }

        // Check if product name is contained in metadata (for partial matches)
        if (chunkProductName && normalize(chunkProductName).includes(normalizedProduct)) {
          return product;
        }
        if (chunkProductName && normalizedProduct.includes(normalize(chunkProductName))) {
          return product;
        }

        // Fallback: check filename
        if (chunkFilename && normalize(chunkFilename).includes(normalizedProduct)) {
          return product;
        }
        if (chunkFilename && normalizedProduct.includes(normalize(chunkFilename).replace(/\.[^.]+$/, ''))) {
          return product;
        }
      }

      return null;
    };

    // Track unassigned chunks for debugging
    const unassignedChunks: typeof contextChunks = [];

    for (const chunk of contextChunks) {
      const chunkProductName = chunk.originalData.metadata?.productName;
      const chunkFilename = chunk.originalData.filename;

      const matchedProduct = findMatchingProduct(chunkProductName, chunkFilename);

      if (matchedProduct) {
        chunksByProduct[matchedProduct].push(chunk);
      } else {
        unassignedChunks.push(chunk);
        console.warn(`⚠️ Comparison: Could not match chunk to any product. Metadata productName: "${chunkProductName}", Filename: "${chunkFilename}"`);
      }
    }

    // Log chunk distribution for debugging
    for (const product of products) {
      console.log(`📊 Comparison chunks for "${product}": ${chunksByProduct[product].length}`);
    }
    if (unassignedChunks.length > 0) {
      console.warn(`⚠️ ${unassignedChunks.length} chunks could not be assigned to any product`);
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
5. **EXTRACT ALL SPECIFICATIONS**: Look carefully in the context for:
   - Product Weight (often in grams or kg)
   - Dimensions/Size
   - Price/MRP
   - Material/Composition
   - Country of Origin
   - Manufacturer details
   - Available variants/sizes/colors
   These may appear in different formats (JSON, bullet points, or prose) - extract them ALL.
6. If a specification is truly NOT present anywhere in the context for a product, state "Not found in provided context"
7. Cite chunks using [USED_CHUNK: chunk_id] after each statement

IMPORTANT: Scan the ENTIRE context carefully. Specifications like weight may appear in metadata sections labeled "Toon" or in structured data formats. Do NOT say "Not specified" unless you've confirmed the information is truly absent.

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
   * Prepare sources from chunks - deduplicate by product name (filename)
   */
  private prepareSources(
    chunks: Array<{ id: string; content: string; originalData: any }>
  ): EnhancedRAGResponse['sources'] {
    // Deduplicate by filename (product name) to show all unique products
    const seenProducts = new Set<string>();
    return chunks
      .filter(chunk => {
        const filename = chunk.originalData.filename;
        if (!filename) return true;
        if (seenProducts.has(filename)) return false;
        seenProducts.add(filename);
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
   * 🚀 ENHANCED: Analyze if response indicates missing context using LLM
   * More robust and scalable than regex pattern matching
   */
  private async analyzeForMissingContext(query: string, response: string): Promise<{
    isContextMissing: boolean;
    suggestedTopics: string[];
    category: string;
    priority: 'low' | 'medium' | 'high';
  }> {
    // FAST PATH: Quick pattern check for obvious cases
    const detectedPatterns = this.MISSING_CONTEXT_PATTERNS.filter(pattern => pattern.test(response));

    // If even ONE pattern matches, it's highly likely context is missing
    if (detectedPatterns.length >= 1) {
      const analysis = this.analyzeQuery(query);
      return {
        isContextMissing: true,
        suggestedTopics: analysis.suggestedTopics,
        category: analysis.category,
        priority: analysis.priority,
      };
    }

    // If no patterns at all and response is substantial, likely answered
    if (detectedPatterns.length === 0 && response.length > 100) {
      return {
        isContextMissing: false,
        suggestedTopics: [],
        category: 'answered',
        priority: 'low',
      };
    }

    // ROBUST PATH: Use LLM for edge cases (1 pattern match or short responses)
    try {
      const llmResult = await inferenceProvider.chatCompletion(
        `You are a response quality analyzer. Analyze if the AI response adequately answered the user's question.

USER QUESTION: "${query}"

AI RESPONSE:
${response.substring(0, 800)}

═══════════════════════════════════════════════════════════════
ANALYZE AND RETURN JSON:
{
  "isContextMissing": true/false,
  "reason": "Brief explanation",
  "confidence": 0.0-1.0
}

CRITERIA FOR isContextMissing = TRUE:
- Response says it cannot find/access information
- Response explicitly states lack of context or data
- Response asks user to provide more info because it lacks knowledge
- Response gives generic advice instead of specific product info

CRITERIA FOR isContextMissing = FALSE:
- Response provides specific product details, prices, features
- Response answers with concrete information from knowledge base
- Response makes clear recommendations with product names
- Response provides actionable information

Be strict: If the response provides SOME useful info, isContextMissing = FALSE`,
        'Analyze response quality',
        { temperature: 0, maxTokens: 150 }
      );

      const result = JSON.parse(llmResult);

      if (result.isContextMissing === true) {
        const analysis = this.analyzeQuery(query);
        return {
          isContextMissing: true,
          suggestedTopics: analysis.suggestedTopics,
          category: analysis.category,
          priority: analysis.priority,
        };
      }

      return {
        isContextMissing: false,
        suggestedTopics: [],
        category: 'answered',
        priority: 'low',
      };

    } catch (error) {
      console.warn('LLM context analysis failed, using pattern fallback:', error);
      // Fallback to pattern-based detection
      return {
        isContextMissing: detectedPatterns.length > 0,
        suggestedTopics: [],
        category: detectedPatterns.length > 0 ? 'unanswered' : 'answered',
        priority: 'low',
      };
    }
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

