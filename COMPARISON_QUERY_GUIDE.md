# Multi-Product Comparison Query Guide

## 🎯 Overview

The Enhanced RAG system now includes **intelligent multi-product comparison** capabilities that automatically:
1. Detects comparison queries (e.g., "difference between Product A and Product B")
2. Identifies multiple products in the query using fuzzy matching
3. Retrieves chunks for EACH product separately
4. Generates structured comparison responses

## 🚀 How It Works

### Architecture

```
User Query: "Key difference between Frido 3D Posture Plus Ergonomic Chair and Frido Aeroluxe Massage Chair?"
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 1: Query Analysis                                              │
│ ├─ Detect comparison keywords (difference, compare, vs, between)   │
│ ├─ Extract products using fuzzy matching                           │
│ └─ Result: 2 products detected → Comparison Mode ON                │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 2: Product-Specific Query Generation                          │
│ ├─ Product 1: Generate 3 queries specific to first product         │
│ ├─ Product 2: Generate 3 queries specific to second product        │
│ └─ Total: 6 queries (3 per product)                                │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 3: Multi-Product Retrieval                                    │
│ ├─ Retrieve chunks for Product 1 (with product filter)            │
│ ├─ Retrieve chunks for Product 2 (with product filter)            │
│ └─ Ensure balanced representation from both products               │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 4: Reranking & Compression                                    │
│ ├─ Rerank all chunks by relevance                                  │
│ ├─ Maintain balance between products                               │
│ └─ Select top N chunks (e.g., 20 for comparisons)                  │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 5: Comparison Response Generation                             │
│ ├─ Group chunks by product                                         │
│ ├─ Generate structured comparison                                  │
│ │  ├─ Overview                                                      │
│ │  ├─ Features comparison                                          │
│ │  ├─ Specifications comparison                                    │
│ │  ├─ Design & Comfort comparison                                  │
│ │  └─ Summary with key differences                                 │
│ └─ Return comprehensive comparison response                        │
└─────────────────────────────────────────────────────────────────────┘
```

## 📝 Usage Examples

### Example 1: Basic Comparison

**Query:**
```
"Key difference between Frido 3D Posture Plus Ergonomic Chair and Frido Aeroluxe Massage Chair?"
```

**API Request:**
```bash
POST /api/chat
Content-Type: application/json

{
  "message": "Key difference between Frido 3D Posture Plus Ergonomic Chair and Frido Aeroluxe Massage Chair?",
  "useEnhancedRAG": true,
  "useReranking": true,
  "useCompression": false,
  "useMultiQuery": true,
  "maxQueries": 3,
  "finalChunkCount": 20,
  "companyContext": {
    "companyName": "Frido",
    "companyDescription": "Orthopedic and ergonomic products",
    "productCategories": "chairs, pillows, cushions, insoles"
  }
}
```

**Expected Output:**
```
📊 Response:
The Frido 3D Posture Plus Ergonomic Chair and Frido Aeroluxe Massage Chair are designed for different primary purposes:

**3D Posture Plus Ergonomic Chair:**
- Focus: Posture correction and ergonomic seating
- Features: 3D adjustable lumbar support, breathable mesh back
- Design: Office/work environment oriented
- Key benefit: Long-term posture improvement

**Aeroluxe Massage Chair:**
- Focus: Relaxation and therapeutic massage
- Features: Built-in massage functions, reclining capability
- Design: Home/relaxation environment oriented
- Key benefit: Stress relief and muscle relaxation

**Key Differences:**
1. Primary purpose (work vs. relaxation)
2. Massage functionality (absent vs. present)
3. Target environment (office vs. home)
4. Price point and complexity
```

### Example 2: Feature Comparison

**Query:**
```
"Compare Cloud Seat Cushion and Slim Seat Cushion features"
```

**System Behavior:**
1. Detects "compare" keyword → Comparison mode
2. Identifies 2 products: "Frido Cloud Seat Cushion" and "Frido Slim Seat Cushion"
3. Generates product-specific queries:
   - Cloud: "Cloud Seat Cushion features specifications design"
   - Cloud: "Cloud Seat Cushion materials comfort benefits"
   - Cloud: "Cloud Seat Cushion dimensions weight capacity"
   - Slim: "Slim Seat Cushion features specifications design"
   - Slim: "Slim Seat Cushion materials comfort benefits"
   - Slim: "Slim Seat Cushion dimensions weight capacity"
4. Retrieves chunks for each product separately
5. Generates structured comparison

### Example 3: "Which is Better" Query

**Query:**
```
"Which is better: Arch Support Insoles Rigid or Semi Rigid?"
```

**System Behavior:**
1. Detects "which is better" + "or" → Comparison mode
2. Identifies 2 products with fuzzy matching
3. Retrieves comprehensive info for both
4. Provides objective comparison without bias

## 🔧 Configuration for Comparison Queries

### Recommended Settings

```typescript
const result = await ragService.queryDocumentsEnhanced(comparisonQuery, {
  retrievalCount: 10,           // Retrieve more initially per product
  similarityThreshold: 0.5,     // Lower threshold for broader context
  useReranking: true,           // CRITICAL: Filter irrelevant chunks
  useCompression: false,        // Keep full context for comparison
  useMultiQuery: true,          // CRITICAL: Multi-query per product
  maxQueries: 3,                // 3 queries per product
  finalChunkCount: 20,          // More chunks for comparison (10 per product)
});
```

### Why These Settings?

1. **`useMultiQuery: true`** - Essential for generating product-specific queries
2. **`maxQueries: 3`** - Creates 3 queries per product (6 total for 2 products)
3. **`finalChunkCount: 20`** - Ensures ~10 chunks per product for comprehensive comparison
4. **`useCompression: false`** - Preserves full context needed for detailed comparison
5. **`useReranking: true`** - Filters out irrelevant chunks while maintaining balance

## 🎨 Comparison Detection

### Detected Keywords

The system automatically detects comparison queries using these keywords:

- **difference** - "What's the difference between X and Y?"
- **compare** - "Compare X and Y"
- **comparison** - "Comparison of X vs Y"
- **versus** / **vs** - "X versus Y" or "X vs Y"
- **between** - "Difference between X and Y"
- **or** - "X or Y?" (in context of choice)
- **which is better** - "Which is better: X or Y?"
- **better than** - "Is X better than Y?"
- **differ from** - "How does X differ from Y?"
- **similar to** - "Is X similar to Y?"
- **contrast** - "Contrast X and Y"

### Multi-Product Detection

The system uses fuzzy matching to detect multiple products in the query:

```typescript
Query: "difference between 3d posture chair and aerolux massage chair"
                          ↓ fuzzy matching
Detected: 
  - "Frido 3D Posture Plus Ergonomic Chair" (score: 0.85)
  - "Frido Aeroluxe Massage Chair" (score: 0.90)
                          ↓
Comparison Mode: ENABLED
```

## 📊 Comparison Aspects

The system automatically identifies what aspect the user is comparing:

### Detected Aspects

| Aspect | Keywords | Example Query |
|--------|----------|---------------|
| **Price** | price, cost, expensive, cheaper, affordable | "Which is more expensive: X or Y?" |
| **Features** | feature, function, capability | "What features differ between X and Y?" |
| **Specifications** | spec, dimension, size, weight, material | "Compare specifications of X and Y" |
| **Comfort** | comfort, ergonomic, support, feel | "Which is more comfortable: X or Y?" |
| **Design** | design, look, style, appearance | "Design differences between X and Y" |
| **Quality** | quality, durable, lasting, reliable | "Which has better quality: X or Y?" |
| **Performance** | performance, effective, work | "How do X and Y perform?" |

## 🔍 How Queries Are Generated

For a comparison query, the system generates product-specific queries:

### Example: "Difference between Product A and Product B?"

**Aspect Detected:** General comparison

**Generated Queries:**

**For Product A:**
1. "Product A features specifications benefits"
2. "Product A materials dimensions design"
3. "Product A use cases applications advantages"

**For Product B:**
1. "Product B features specifications benefits"
2. "Product B materials dimensions design"
3. "Product B use cases applications advantages"

**Total:** 6 queries (3 per product)

### Example: "Which is more comfortable: Product A or Product B?"

**Aspect Detected:** Comfort

**Generated Queries:**

**For Product A:**
1. "Product A comfort ergonomic support"
2. "Product A cushioning padding materials"
3. "Product A user comfort experience feedback"

**For Product B:**
1. "Product B comfort ergonomic support"
2. "Product B cushioning padding materials"
3. "Product B user comfort experience feedback"

**Total:** 6 queries (3 per product)

## 📈 Performance Metrics

### Typical Comparison Query Performance

```
Query: "Difference between Product A and Product B?"

Performance Breakdown:
├─ Query Expansion: 2.5s (2 LLM calls for product-specific queries)
├─ Retrieval: 1.2s (6 queries × 2 embeddings)
├─ Reranking: 3.0s (LLM scoring of all chunks)
├─ Compression: 0s (disabled for comparisons)
└─ Generation: 4.5s (structured comparison response)

Total: ~11s

Retrieved Chunks:
├─ Product A: 15 chunks
├─ Product B: 12 chunks
└─ Total: 27 chunks → Reranked to 20 → Used in response
```

## 🧪 Testing

### Test File

Run the comparison test:

```bash
npx tsx src/services/testComparison.ts
```

### Manual Testing via API

```bash
curl -X POST http://localhost:5000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Key difference between Frido 3D Posture Plus Ergonomic Chair and Frido Aeroluxe Massage Chair?",
    "useEnhancedRAG": true,
    "useReranking": true,
    "useMultiQuery": true,
    "maxQueries": 3,
    "finalChunkCount": 20
  }'
```

## ⚡ Optimization Tips

### For Faster Comparisons

1. **Reduce maxQueries**: Use 2 queries per product instead of 3
2. **Disable reranking**: Use fast reranking or skip entirely
3. **Lower finalChunkCount**: Use 10-15 chunks instead of 20

```typescript
// Fast comparison mode
{
  useReranking: false,
  maxQueries: 2,
  finalChunkCount: 12
}
```

### For More Accurate Comparisons

1. **Increase maxQueries**: Use 4-5 queries per product
2. **Enable compression**: Extract only relevant sentences
3. **Higher finalChunkCount**: Use 25-30 chunks

```typescript
// Accurate comparison mode
{
  useReranking: true,
  useCompression: true,
  maxQueries: 4,
  finalChunkCount: 30
}
```

## 🎯 Best Practices

1. **Always enable useMultiQuery** for comparison queries
2. **Use finalChunkCount of 15-20** for balanced comparisons
3. **Disable compression** to preserve full context
4. **Set maxQueries to 3** for optimal balance of speed and accuracy
5. **Ensure products have good metadata** in Qdrant (productName field)

## 🔮 Future Enhancements

1. **3+ Product Comparisons** - Support comparing more than 2 products
2. **Comparison Tables** - Generate structured comparison tables
3. **Visual Comparisons** - Integration with chart generation
4. **Smart Aspect Selection** - Auto-select most relevant comparison aspects
5. **Comparison Caching** - Cache common product comparisons

## 📚 Related Documentation

- `ENHANCED_RAG_GUIDE.md` - Main enhanced RAG documentation
- `IMPLEMENTATION_SUMMARY.md` - Overall implementation summary
- `src/services/testComparison.ts` - Test examples

---

**Status:** ✅ Ready for Production Use
**Version:** 1.0
**Last Updated:** October 11, 2025

