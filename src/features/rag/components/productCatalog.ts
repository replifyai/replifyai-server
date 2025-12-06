/**
 * Product Catalog Service
 * Maintains a list of all products and provides fuzzy matching capabilities
 */

export interface Product {
  id: string;
  name: string;
  aliases?: string[]; // Alternative names or common misspellings
}

// Exporting an empty array to maintain backward compatibility if needed, 
// but internal logic will use fetched products.
export const FRIDO_PRODUCTS: Product[] = [];

export class ProductCatalog {
  private products: Product[];
  private lastFetchTime: number = 0;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour
  private fetchPromise: Promise<void> | null = null;

  constructor() {
    this.products = [];
    // Trigger initial fetch
    this.refreshProducts().catch(err => console.error('Failed to initialize product catalog:', err));
  }

  /**
   * Fetches products from the API with caching
   */
  public async refreshProducts(): Promise<void> {
    // Return existing promise if a fetch is already in progress
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    // Check cache validity
    if (this.products.length > 0 && (Date.now() - this.lastFetchTime < this.CACHE_DURATION)) {
      return;
    }

    this.fetchPromise = (async () => {
      try {
        console.log('Fetching product list from API...');
        const response = await fetch('https://asia-south1-replify-9f49f.cloudfunctions.net/getProductList', {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (Array.isArray(data)) {
          // Map API response to internal Product interface
          this.products = data.map((item: any) => ({
            id: item.id,
            name: item.name,
            aliases: item.alias || item.aliases || []
          }));
          this.lastFetchTime = Date.now();
          console.log(`✅ Product catalog updated: ${this.products.length} products loaded`);
        } else {
          console.error('❌ Invalid product list format received from API');
        }
      } catch (error) {
        console.error('❌ Error fetching product list:', error);
        throw new Error("Having trouble connecting with server");
      } finally {
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  /**
   * Get all product names for reference
   */
  getAllProductNames(): string[] {
    // If products haven't loaded yet and it's been less than 5 seconds since start,
    // we might be in a race condition. But since this is sync, we return what we have.
    return this.products.map(p => p.name);
  }

  /**
   * Fuzzy match product names - returns best matches with scores
   * Uses multiple algorithms for best results
   */
  fuzzyMatchProducts(query: string, threshold: number = 0.3, maxResults: number = 5): Array<{
    product: Product;
    score: number;
    matchType: 'exact' | 'alias' | 'fuzzy';
  }> {
    // Ensure we have products (non-blocking attempt to refresh if stale)
    if (Date.now() - this.lastFetchTime > this.CACHE_DURATION && !this.fetchPromise) {
      this.refreshProducts().catch(e => console.error("Background refresh failed", e));
    }

    const normalizedQuery = this.normalizeText(query);
    const results: Array<{ product: Product; score: number; matchType: 'exact' | 'alias' | 'fuzzy' }> = [];

    // Common stop words to ignore in alias matching
    const stopWords = new Set(['of', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'a', 'an']);

    for (const product of this.products) {
      const normalizedName = this.normalizeText(product.name);
      let bestScore = 0;
      let bestMatchType: 'exact' | 'alias' | 'fuzzy' = 'fuzzy';

      // 1. Check Exact Match
      if (normalizedName === normalizedQuery) {
        bestScore = 1.0;
        bestMatchType = 'exact';
      }
      // 2. Check Exact Substring (Query is part of Name OR Name is part of Query)
      else if (normalizedName.includes(normalizedQuery)) {
        // User typed "Barefoot", matches "Barefoot Sock Shoe"
        bestScore = 0.9;
        bestMatchType = 'exact';
      } else if (normalizedQuery.includes(normalizedName)) {
        // User typed "I want Barefoot Sock Shoe", matches "Barefoot Sock Shoe"
        bestScore = 0.95;
        bestMatchType = 'exact';
      }

      // 3. Check Aliases
      // Only if exact/substring didn't give a perfect match
      if (bestScore < 1.0 && product.aliases) {
        for (const alias of product.aliases) {
          const normalizedAlias = this.normalizeText(alias);
          if (!normalizedAlias) continue;

          let currentAliasScore = 0;

          if (normalizedAlias === normalizedQuery) {
            currentAliasScore = 0.95;
          } else if (normalizedAlias.includes(normalizedQuery)) {
            // Query is substring of alias (User typing prefix)
            currentAliasScore = 0.85;
          } else if (normalizedQuery.includes(normalizedAlias)) {
            // Alias is substring of query (e.g. "Classic" in "Barefoot Sock Shoe Classic")

            // Skip stop words and very short aliases
            if (stopWords.has(normalizedAlias)) continue;
            if (normalizedAlias.length < 3) continue;

            // Calculate score based on alias length (longer aliases = more specific = higher score)
            // Base score 0.6. Boost up to 0.25 based on length.
            // This ensures "Barefoot Sock Shoe Classic" (long) > "Classic" (short)
            const lengthBoost = Math.min(0.25, (normalizedAlias.length / 50));
            currentAliasScore = 0.6 + lengthBoost;
          }

          if (currentAliasScore > bestScore) {
            bestScore = currentAliasScore;
            bestMatchType = 'alias';
          }
        }
      }

      // Log detailed scoring for this product if it's a potential candidate
      if (bestScore >= threshold) {
        console.log(`🔍 Fuzzy Match Candidate: "${product.name}" (Score: ${bestScore.toFixed(2)}, Type: ${bestMatchType})`);
      }

      // 4. Fuzzy Matching (only if we haven't found a good match yet)
      // We use a higher threshold for triggering calculation to avoid expensive ops if we have a good match
      if (bestScore < 0.8) {
        const fuzzyScore = this.calculateFuzzyScore(normalizedQuery, normalizedName, product.aliases);
        if (fuzzyScore > bestScore) {
          bestScore = fuzzyScore;
          bestMatchType = 'fuzzy';
        }
      }

      if (bestScore >= threshold) {
        results.push({ product, score: bestScore, matchType: bestMatchType });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, maxResults);
  }

  /**
   * Extract product names mentioned in a query
   */
  extractProductsFromQuery(query: string, threshold: number = 0.4): string[] {
    const matches = this.fuzzyMatchProducts(query, threshold);
    return matches.map(m => m.product.name);
  }

  /**
   * Normalize text for comparison
   */
  private normalizeText(text: string): string {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace special chars with space
      .replace(/\s+/g, ' ')      // Normalize whitespace
      .trim();
  }

  /**
   * Calculate fuzzy score using multiple techniques
   */
  private calculateFuzzyScore(query: string, productName: string, aliases?: string[]): number {
    let maxScore = 0;

    // Score against product name
    maxScore = Math.max(maxScore, this.stringSimilarity(query, productName));

    // Score against aliases
    if (aliases) {
      for (const alias of aliases) {
        const aliasScore = this.stringSimilarity(query, this.normalizeText(alias));
        maxScore = Math.max(maxScore, aliasScore);
      }
    }

    // Token-based matching (checks if query words appear in product name)
    const tokenScore = this.tokenBasedSimilarity(query, productName);
    maxScore = Math.max(maxScore, tokenScore);

    return maxScore;
  }

  /**
   * Calculate similarity between two strings using Levenshtein-inspired approach
   */
  private stringSimilarity(s1: string, s2: string): number {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Levenshtein distance calculation
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const costs: number[] = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) {
        costs[s2.length] = lastValue;
      }
    }
    return costs[s2.length];
  }

  /**
   * Token-based similarity (checks if query tokens appear in product name)
   */
  private tokenBasedSimilarity(query: string, productName: string): number {
    const queryTokens = query.split(/\s+/).filter(t => t.length > 2); // Ignore very short tokens
    const productTokens = productName.split(/\s+/);

    if (queryTokens.length === 0) return 0;

    let matchCount = 0;
    for (const qToken of queryTokens) {
      for (const pToken of productTokens) {
        if (pToken.includes(qToken) || qToken.includes(pToken)) {
          matchCount++;
          break;
        }
      }
    }

    return matchCount / queryTokens.length;
  }
}

export const productCatalog = new ProductCatalog();
