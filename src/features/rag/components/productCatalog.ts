/**
 * Product Catalog Service
 * Maintains a list of all products and provides fuzzy matching capabilities
 */

export interface Product {
  id: string;
  name: string;
  aliases?: string[]; // Alternative names or common misspellings
}

export const FRIDO_PRODUCTS: Product[] = [
  { id: "Frido 3D Posture Plus Ergonomic Chair", name: "Frido 3D Posture Plus Ergonomic Chair", aliases: ["3D Posture Chair", "Posture Plus Chair"] },
  { id: "Frido Active Socks Product Description", name: "Frido Active Socks Product Description", aliases: ["Active Socks", "Frido Socks"] },
  { id: "Frido AeroMesh Ergo Chair", name: "Frido AeroMesh Ergo Chair", aliases: ["AeroMesh Chair", "Aero Mesh Chair"] },
  { id: "Frido Aeroluxe Massage Chair", name: "Frido Aeroluxe Massage Chair", aliases: ["Aeroluxe Chair", "Massage Chair"] },
  { id: "Frido Arch Sports Insole", name: "Frido Arch Sports Insole", aliases: ["Arch Insole", "Sports Insole"] },
  { id: "Frido Arch Support Insole - Rigid", name: "Frido Arch Support Insole - Rigid", aliases: ["Rigid Arch Support", "Rigid Insole"] },
  { id: "Frido Arch Support Insoles - Semi Rigid", name: "Frido Arch Support Insoles - Semi Rigid", aliases: ["Semi Rigid Arch Support", "Semi Rigid Insole"] },
  { id: "Frido Ball of Foot Cushion Pro", name: "Frido Ball of Foot Cushion Pro", aliases: ["Ball Cushion Pro", "Foot Cushion Pro"] },
  { id: "Frido Barefoot Sock Shoe Classic", name: "Frido Barefoot Sock Shoe Classic", aliases: ["Barefoot Shoe", "Sock Shoe"] },
  { id: "Frido Cervical Butterfly pillow", name: "Frido Cervical Butterfly pillow", aliases: ["Cervical Pillow", "Butterfly Pillow"] },
  { id: "Frido Cloud Back Rest Cushion", name: "Frido Cloud Back Rest Cushion", aliases: ["Cloud Backrest", "Back Rest Cushion"] },
  { id: "Frido Cloud Seat Cushion", name: "Frido Cloud Seat Cushion", aliases: ["Cloud Cushion", "Cloud Seat"] },
  { id: "Frido Cuddle Sleep Pillow", name: "Frido Cuddle Sleep Pillow", aliases: ["Cuddle Pillow", "Sleep Pillow"] },
  { id: "Frido Dual Gel Insoles", name: "Frido Dual Gel Insoles", aliases: ["Gel Insoles", "Dual Gel"] },
  { id: "Frido Dual Gel Insoles Pro", name: "Frido Dual Gel Insoles Pro", aliases: ["Gel Insoles Pro", "Dual Gel Pro"] },
  { id: "Frido Glide Ergo Chair", name: "Frido Glide Ergo Chair", aliases: ["Glide Chair", "Ergo Chair"] },
  { id: "Frido Knee Pillow", name: "Frido Knee Pillow", aliases: ["Knee Support Pillow"] },
  { id: "Frido Leg Elevation Pillow", name: "Frido Leg Elevation Pillow", aliases: ["Leg Pillow", "Elevation Pillow"] },
  { id: "Frido Lumbo Sacral Belt", name: "Frido Lumbo Sacral Belt", aliases: ["Lumbar Belt", "Back Support Belt"] },
  { id: "Frido Maternity Pillow", name: "Frido Maternity Pillow", aliases: ["Pregnancy Pillow"] },
  { id: "Frido Max Comfort Hi-Per Foam Insoles", name: "Frido Max Comfort Hi-Per Foam Insoles", aliases: ["Max Comfort Insoles", "Foam Insoles"] },
  { id: "Frido Mini Car Neck Pillow", name: "Frido Mini Car Neck Pillow", aliases: ["Car Neck Pillow Mini", "Mini Neck Pillow"] },
  { id: "Frido Mouse Wrist Support", name: "Frido Mouse Wrist Support", aliases: ["Wrist Support", "Mouse Pad Wrist"] },
  { id: "Frido Ortho Memory Foam Pillow", name: "Frido Ortho Memory Foam Pillow", aliases: ["Memory Foam Pillow", "Ortho Pillow"] },
  { id: "Frido Orthopedic Heel Pad", name: "Frido Orthopedic Heel Pad", aliases: ["Heel Pad", "Ortho Heel Pad"] },
  { id: "Frido Orthotics Bunion Corrector", name: "Frido Orthotics Bunion Corrector", aliases: ["Bunion Corrector", "Toe Corrector"] },
  { id: "Frido Orthotics Compression Gloves", name: "Frido Orthotics Compression Gloves", aliases: ["Compression Gloves", "Hand Gloves"] },
  { id: "Frido Orthotics Posture Corrector", name: "Frido Orthotics Posture Corrector", aliases: ["Posture Corrector", "Back Brace"] },
  { id: "Frido Orthotics Wrist Support Brace", name: "Frido Orthotics Wrist Support Brace", aliases: ["Wrist Brace", "Wrist Support"] },
  { id: "Frido Ouch Free High Heels Ball of Foot Cushions", name: "Frido Ouch Free High Heels Ball of Foot Cushions", aliases: ["High Heel Cushion", "Ball Foot Cushion"] },
  { id: "Frido Plantar Fasciitis Pain Relief Ortho Insole", name: "Frido Plantar Fasciitis Pain Relief Ortho Insole", aliases: ["Plantar Fasciitis Insole", "Pain Relief Insole"] },
  { id: "Frido School Shoes", name: "Frido School Shoes", aliases: ["Kids Shoes", "School Footwear"] },
  { id: "Frido Silicone Gel Insole", name: "Frido Silicone Gel Insole", aliases: ["Silicone Insole", "Gel Insole"] },
  { id: "Frido Slim Seat Cushion", name: "Frido Slim Seat Cushion", aliases: ["Slim Cushion", "Thin Seat Cushion"] },
  { id: "Frido Travel Neck Pillow", name: "Frido Travel Neck Pillow", aliases: ["Travel Pillow", "Neck Support Travel"] },
  { id: "Frido Ultimate Back Lumbar Cushion", name: "Frido Ultimate Back Lumbar Cushion", aliases: ["Lumbar Cushion", "Back Support Cushion"] },
  { id: "Frido Ultimate Car Backrest Cushion", name: "Frido Ultimate Car Backrest Cushion", aliases: ["Car Backrest", "Car Back Support"] },
  { id: "Frido Ultimate Car Neck Rest Pillow", name: "Frido Ultimate Car Neck Rest Pillow", aliases: ["Car Neck Pillow", "Neck Rest Car"] },
  { id: "Frido Ultimate Car Wedge Seat Cushion", name: "Frido Ultimate Car Wedge Seat Cushion", aliases: ["Car Wedge Cushion", "Wedge Seat Car"] },
  { id: "Frido Ultimate Coccyx Seat Cushion", name: "Frido Ultimate Coccyx Seat Cushion", aliases: ["Coccyx Cushion", "Tailbone Cushion"] },
  { id: "Frido Ultimate Cozy Pillow", name: "Frido Ultimate Cozy Pillow", aliases: ["Cozy Pillow", "Comfort Pillow"] },
  { id: "Frido Ultimate Deep Sleep Pillow", name: "Frido Ultimate Deep Sleep Pillow", aliases: ["Deep Sleep Pillow", "Sleep Pillow"] },
  { id: "Frido Ultimate Lap Desk Pillow", name: "Frido Ultimate Lap Desk Pillow", aliases: ["Lap Desk", "Desk Pillow"] },
  { id: "Frido Ultimate Mattress Topper", name: "Frido Ultimate Mattress Topper", aliases: ["Mattress Topper", "Bed Topper"] },
  { id: "Frido Ultimate Neck Contour Cervical Pillow", name: "Frido Ultimate Neck Contour Cervical Pillow", aliases: ["Neck Contour Pillow", "Cervical Pillow"] },
  { id: "Frido Ultimate Neck Contour Cervical Plus Pillow", name: "Frido Ultimate Neck Contour Cervical Plus Pillow", aliases: ["Cervical Plus Pillow", "Neck Contour Plus"] },
  { id: "Frido Ultimate Office Neck Rest Pillow", name: "Frido Ultimate Office Neck Rest Pillow", aliases: ["Office Neck Pillow", "Work Neck Rest"] },
  { id: "Frido Ultimate Piles Pain Relief Seat Cushion", name: "Frido Ultimate Piles Pain Relief Seat Cushion", aliases: ["Piles Cushion", "Hemorrhoid Cushion"] },
  { id: "Frido Ultimate Pro Posture Corrector", name: "Frido Ultimate Pro Posture Corrector", aliases: ["Pro Posture Corrector", "Posture Corrector Pro"] },
  { id: "Frido Ultimate Pro Seat Cushion", name: "Frido Ultimate Pro Seat Cushion", aliases: ["Pro Seat Cushion", "Seat Cushion Pro"] },
  { id: "Frido Ultimate Socket Seat Cushion", name: "Frido Ultimate Socket Seat Cushion", aliases: ["Socket Cushion", "Socket Seat"] },
  { id: "Frido Ultimate Sofa Backrest Cushion", name: "Frido Ultimate Sofa Backrest Cushion", aliases: ["Sofa Backrest", "Couch Back Support"] },
  { id: "Frido Ultimate Tailbone Pain Relief Seat Cushion", name: "Frido Ultimate Tailbone Pain Relief Seat Cushion", aliases: ["Tailbone Cushion", "Coccyx Pain Relief"] },
  { id: "Frido Ultimate Wedge Cushion", name: "Frido Ultimate Wedge Cushion", aliases: ["Wedge Cushion", "Incline Cushion"] },
  { id: "Frido Ultimate Wedge Plus Cushion", name: "Frido Ultimate Wedge Plus Cushion", aliases: ["Wedge Plus", "Wedge Cushion Plus"] },
  { id: "Frido Ultimate Wedge Plus Max Cushion", name: "Frido Ultimate Wedge Plus Max Cushion", aliases: ["Wedge Plus Max", "Max Wedge Cushion"] },
  { id: "Frido Ultra Slim Deep Sleep Pillow", name: "Frido Ultra Slim Deep Sleep Pillow", aliases: ["Ultra Slim Pillow", "Slim Sleep Pillow"] },
  { id: "Frido Wedge Neck Rest Pillow", name: "Frido Wedge Neck Rest Pillow", aliases: ["Wedge Neck Pillow", "Neck Rest Wedge"] },
  { id: "Frido Wedge Plus Cushion Cover", name: "Frido Wedge Plus Cushion Cover", aliases: ["Wedge Cover", "Cushion Cover"] },
  { id: "Frido Women Comfort Sandal", name: "Frido Women Comfort Sandal", aliases: ["Women Sandal", "Comfort Sandal"] },
  { id: "Frido Orthopedic Heel Pad", name: "Frido Orthopedic Heel Pad", aliases: ["Pro Heel Pad", "Heel Cushion Pro","Orthopedic Heel Pad Pro","Heel Pad Pro"] },
  { id: "Max Comfort Arch Sports Insoles (Non RCB)", name: "Max Comfort Arch Sports Insoles (Non RCB)", aliases: ["Max Comfort Insoles", "Arch Sports Insole"] },
  { id: "Portable Standing Desk", name: "Portable Standing Desk", aliases: ["Standing Desk", "Portable Desk"] },
  { id: "Prime Electric Wheelchair", name: "Prime Electric Wheelchair", aliases: ["Electric Wheelchair", "Wheelchair"] },
];

export class ProductCatalog {
  private products: Product[];

  constructor(products: Product[] = FRIDO_PRODUCTS) {
    this.products = products;
  }

  /**
   * Get all product names for reference
   */
  getAllProductNames(): string[] {
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
    const normalizedQuery = this.normalizeText(query);
    const results: Array<{ product: Product; score: number; matchType: 'exact' | 'alias' | 'fuzzy' }> = [];

    // Check for exact matches first
    for (const product of this.products) {
      const normalizedName = this.normalizeText(product.name);
      
      // Exact match
      if (normalizedName === normalizedQuery) {
        results.push({ product, score: 1.0, matchType: 'exact' });
        continue;
      }

      // Exact substring match
      if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) {
        results.push({ product, score: 0.9, matchType: 'exact' });
        continue;
      }

      // Check aliases
      if (product.aliases) {
        for (const alias of product.aliases) {
          const normalizedAlias = this.normalizeText(alias);
          if (normalizedAlias === normalizedQuery || normalizedAlias.includes(normalizedQuery) || normalizedQuery.includes(normalizedAlias)) {
            results.push({ product, score: 0.85, matchType: 'alias' });
            break;
          }
        }
        if (results[results.length - 1]?.product === product) continue;
      }

      // Fuzzy matching with multiple techniques
      const fuzzyScore = this.calculateFuzzyScore(normalizedQuery, normalizedName, product.aliases);
      if (fuzzyScore >= threshold) {
        results.push({ product, score: fuzzyScore, matchType: 'fuzzy' });
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

