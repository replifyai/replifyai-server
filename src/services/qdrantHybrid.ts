/**
 * Enhanced Vector store service for Qdrant integration
 * Includes improved error handling, batching, and debugging
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from "../env.js";
import { randomUUID } from 'crypto';

// Business logic interfaces - keep existing
export interface QdrantPoint {
  id: number;
  vector: number[];
  payload: {
    documentId: number;
    chunkIndex: number;
    content: string;
    filename: string;
    metadata?: any;
  };
}

export interface SearchResult {
  chunkId: number;
  documentId: number;
  content: string;
  filename: string;
  score: number;
  metadata?: any;
}

class QdrantCloudService {
  private client: QdrantClient;
  private collectionName: string = process.env.QDRANT_COLLECTION_NAME || "documents";

  // Batch size for document addition
  private addBatchSize: number = 10;
  
  // Maximum retries for Qdrant operations
  private maxRetries: number = 3;
  
  // Debug mode
  private debugMode: boolean = env.LOG_LEVEL === 'debug';
  
  // Track operations for debugging
  private operationStats = {
    addedDocuments: 0,
    failedDocuments: 0,
    searches: 0,
    errors: [] as any[]
  };

  constructor() {
    // Initialize the client with improved error handling
    this.client = new QdrantClient({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      checkCompatibility: false
    });
    
    console.log(`Initialized Qdrant client at ${env.QDRANT_URL} for collection ${this.collectionName}`);
  }

  getKnowledgeBase() {
    return this.collectionName;
  }

  /**
   * Generate a unique UUID for Qdrant point
   * @returns {string} UUID string
   */
  private generateUniqueId(): string {
    return randomUUID();
  }


  /**
   * Initialize the collection with improved error handling
   * @returns {Promise<void>}
   */
  async ensureCollection(): Promise<void> {
    try {
      // Check if collection exists
      let collections;
      console.log(`Checking if collection ${this.collectionName} exists`);

      try {
        collections = await this.client.getCollections();
      } catch (error) {
        console.error(`Failed to connect to Qdrant: ${(error as Error).message}`);
        throw new Error(`Failed to connect to Qdrant: ${(error as Error).message}`);
      }

      const collectionExists = collections.collections.some(
        collection => collection.name === this.collectionName
      );

      if (collectionExists) {
        console.log(`Collection ${this.collectionName} already exists`);
        
        // If debug mode is enabled, get collection info for verification
        if (this.debugMode) {
          try {
            const collectionInfo = await this.getCollectionInfo();
            console.log(`Collection ${this.collectionName} info:`, JSON.stringify({
              vectors_count: collectionInfo.result?.vectors_count,
              points_count: collectionInfo.result?.points_count,
              vector_size: collectionInfo.result?.config?.params?.vectors?.size
            }));
          } catch (infoError) {
            console.warn(`Could not get collection info: ${(infoError as Error).message}`);
          }
        }
        
        // Ensure required indexes exist
        await this.ensureIndexes();
        return;
      }

      // Create the collection with updated parameters
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: 1536,
          distance: "Cosine"
        }
      });

      console.log(`Created collection ${this.collectionName} with 1536 dimensions`);
      
      // Create required indexes after collection creation
      await this.ensureIndexes();
    } catch (error) {
      console.error(`Error initializing collection: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Ensure required indexes exist
   * @private
   */
  private async ensureIndexes(): Promise<void> {
    // Create payload index for metadata fields for better filtering
    const metadataFields = [
      { field: 'metadata.keyTopics', schema: 'keyword' },
      { field: 'metadata.docMetadata.key_entities.product_name', schema: 'keyword' },
      { field: 'metadata.productName', schema: 'keyword' }
    ];
    
    for (const { field, schema } of metadataFields) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: field,
          field_schema: schema as any
        });
        console.log(`Created payload index for ${field}`);
      } catch (indexError) {
        // Index might already exist, which is fine
        if (this.debugMode) {
          console.warn(`Could not create index for ${field}: ${(indexError as Error).message}`);
        }
      }
    }
  }

  /**
   * Add documents to the vector store with improved batching and error handling
   * @param {Array} points Document points to add
   * @returns {Promise<Object>} Result of the operation
   */
  async addPoints(points: QdrantPoint[]): Promise<void> {
    if (!points || points.length === 0) {
      console.warn('No points provided to add to vector store');
      return;
    }

    await this.ensureCollection();
    
    // Validate collection configuration
    try {
      const collectionInfo = await this.getCollectionInfo();
      console.log('Collection info:', {
        vectorSize: collectionInfo.result?.config?.params?.vectors?.size,
        distance: collectionInfo.result?.config?.params?.vectors?.distance,
        pointsCount: collectionInfo.result?.points_count
      });
    } catch (e) {
      console.warn('Could not retrieve collection info:', e);
    }
    
    console.log('Adding points to Qdrant:', {
      count: points.length,
      samplePoint: points[0] ? {
        originalId: points[0].id,
        vectorLength: points[0].vector?.length,
        payload: points[0].payload
      } : null
    });

    console.log(`Adding ${points.length} points to vector store in batches of ${this.addBatchSize}`);
    
    // Track operation results
    const results = {
      success: true,
      total: points.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [] as any[]
    };

    try {
      // Process in batches to avoid overwhelming the server
      for (let i = 0; i < points.length; i += this.addBatchSize) {
        const batch = points.slice(i, i + this.addBatchSize);
        console.log(`Processing batch ${Math.floor(i/this.addBatchSize) + 1}/${Math.ceil(points.length/this.addBatchSize)} (${batch.length} points)`);
        
        try {
          // Create points with properly validated data
          const validatedPoints = this._validatePoints(batch);
          
          // If no valid points were created, continue to next batch
          if (validatedPoints.length === 0) {
            console.warn(`No valid points in batch ${i} to ${i + this.addBatchSize}`);
            results.processed += batch.length;
            results.failed += batch.length;
            continue;
          }
          
          // Add points to collection - Generate unique UUIDs for each point
          await this.client.upsert(this.collectionName, {
            wait: true,
            points: validatedPoints.map(point => ({
              id: this.generateUniqueId(), // Generate unique UUID for Qdrant
              vector: point.vector,
              payload: {
                ...point.payload,
                originalChunkId: point.id, // Store original chunk ID for reference
                chunkReference: `${point.payload.documentId}_${point.payload.chunkIndex}` // Store reference
              },
            }))
          });
          
          results.processed += batch.length;
          results.succeeded += validatedPoints.length;
          
          if (validatedPoints.length < batch.length) {
            results.failed += (batch.length - validatedPoints.length);
          }
          
          this.operationStats.addedDocuments += validatedPoints.length;
          
          console.log(`Successfully added batch of ${validatedPoints.length} points to vector store (${results.processed}/${points.length})`);
          console.log(`Generated unique UUIDs for ${validatedPoints.length} points`);
          
          // Add a small delay between batches to reduce load
          if (i + this.addBatchSize < points.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (error) {
          console.error(`Error adding batch to vector store: ${(error as Error).message}`);
          
          results.processed += batch.length;
          results.failed += batch.length;
          results.errors.push({
            batch: Math.floor(i/this.addBatchSize) + 1,
            message: (error as Error).message
          });
          
          this.operationStats.failedDocuments += batch.length;
          this.operationStats.errors.push({
            operation: 'addPoints',
            message: (error as Error).message,
            batch: Math.floor(i/this.addBatchSize) + 1
          });
        }
        
        // Force garbage collection between batches (if running with --expose-gc)
        if (global.gc) {
          global.gc();
          console.log('Garbage collection triggered');
        }
      }

      if (results.failed > 0) {
        results.success = false;
        console.log(`Completed with ${results.failed} failed points out of ${points.length}`);
      } else {
        console.log(`Successfully added ${results.succeeded} points to vector store`);
      }
    } catch (error) {
      console.error(`Error in overall point addition process: ${(error as Error).message}`);
      this.operationStats.errors.push({
        operation: 'addPoints',
        message: (error as Error).message,
        global: true
      });
      throw error;
    }
  }

  /**
   * Validate points before adding to Qdrant
   * @private
   */
  private _validatePoints(points: QdrantPoint[]): QdrantPoint[] {
    const validPoints: QdrantPoint[] = [];
    
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      
      try {
        // Validate required fields
        if (!point.vector || !Array.isArray(point.vector) || point.vector.length !== 1536) {
          console.warn(`Point at index ${i} has invalid vector: expected 1536 dimensions, got ${point.vector?.length || 'none'}`);
          continue;
        }
        
        if (!point.payload || !point.payload.content || typeof point.payload.content !== 'string') {
          console.warn(`Point at index ${i} has no valid content, skipping`);
          continue;
        }
        
        // Limit payload content size for Qdrant
        const validatedPoint = {
          ...point,
          payload: {
            ...point.payload,
            content: point.payload.content.substring(0, 8000)
          }
        };
        
        validPoints.push(validatedPoint);
      } catch (error) {
        console.error(`Error validating point ${i}: ${(error as Error).message}`);
        // Continue with other points
      }
    }
    
    return validPoints;
  }

  async searchSimilar(
    queryVector: number[], 
    limit: number = 5, 
    scoreThreshold: number = 0.7,
    productName?: string
  ): Promise<SearchResult[]> {
    console.log("🚀 ~ QdrantCloudService ~ productName:", productName);
    
    try {
      console.log(`Searching for similar vectors (limit: ${limit}, threshold: ${scoreThreshold})`);
      this.operationStats.searches++;
      
      // Validate query vector
      if (!queryVector || !Array.isArray(queryVector) || queryVector.length !== 1536) {
        throw new Error('Invalid query vector: expected 1536 dimensions');
      }
      
      // Prepare search parameters
      const searchParams: any = {
        vector: queryVector,
        limit: Math.min(limit, 100), // Cap at 100 for performance
        score_threshold: scoreThreshold,
        with_payload: true,
        with_vector: false, // Don't return vectors to save bandwidth
        search_params: {
          hnsw_ef: 64,
          exact: false,
          indexed_only: true
        }
      };
      
      // Add filters if provided
      if (productName && productName.trim() !== '') {
        searchParams.filter = {
          must: [
            { key: "metadata.productName", match: { value: productName } }
          ]
        };
      }
      
      // Search in collection
      const results = await this.client.search(this.collectionName, searchParams);
      
      // Format results to match existing interface
      const formattedResults = results.map((result: any) => ({
        chunkId: result.id,
        documentId: result.payload.documentId,
        content: result.payload.content,
        filename: result.payload.filename,
        score: result.score,
        metadata: result.payload.metadata,
      }));

      console.log("🚀 ~ QdrantCloudService ~ search results:", JSON.stringify(formattedResults, null, 2));
      return formattedResults;
    } catch (error) {
      console.error(`Error searching vector store: ${(error as Error).message}`);
      this.operationStats.errors.push({
        operation: 'searchSimilar',
        message: (error as Error).message
      });
      throw error;
    }
  }

  async deleteByDocumentId(productName: string): Promise<void> {
    console.log("🚀 Deleting by productName:", productName);
  
    try {
      await this.client.delete(this.collectionName, {
        filter: {
          must: [
            {
              key: "metadata.productName",
              match: { value: productName },
            },
          ],
        },
      });
    } catch (error) {
      console.error(`Error deleting by document ID: ${(error as Error).message}`);
      throw error;
    }
  }
  
  

  async getCollectionInfo(): Promise<any> {
    await this.ensureCollection();
    return await this.client.getCollection(this.collectionName);
  }

  /**
   * Get the number of points in the collection
   * @returns {Promise<number>} Point count
   */
  async getPointCount(): Promise<number> {
    try {
      const info = await this.getCollectionInfo();
      return info.result?.points_count || 0;
    } catch (error) {
      console.error(`Error getting point count: ${(error as Error).message}`);
      return 0;
    }
  }

  /**
   * Get system statistics
   * @returns {Object} System statistics
   */
  getStats() {
    return {
      ...this.operationStats,
      timestamp: new Date().toISOString()
    };
  }

  // Expose client for advanced operations
  get qdrantClient() {
    return this.client;
  }
}

export class QdrantService {
  private cloudService: QdrantCloudService;

  constructor() {
    this.cloudService = new QdrantCloudService();
  }

  async ensureCollection(): Promise<void> {
    await this.cloudService.ensureCollection();
  }

  async addPoints(points: QdrantPoint[]): Promise<void> {
    await this.cloudService.addPoints(points);
  }

  async searchSimilar(
    queryVector: number[], 
    limit: number = 5, 
    scoreThreshold: number = 0.7,
    productName?: string
  ): Promise<SearchResult[]> {
    return await this.cloudService.searchSimilar(queryVector, limit, scoreThreshold, productName);
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    await this.cloudService.deleteByDocumentId(documentId);
  }

  async getCollectionInfo(): Promise<any> {
    const result = await this.cloudService.getCollectionInfo();
    return {
      ...result,
      backend: "qdrant-cloud"
    };
  }

  async getChunksByProductsOrTopics(products: string[], topics: string[]): Promise<SearchResult[]> {
    // await this.cloudService.ensureCollection();
    
    // Create filter for product names and topics - find chunks where they match any of the provided values
    const filter = {
      should: [
        ...products.map(product => ({
          key: "metadata.productName",
          match: { value: product }
        })),
        ...topics.map(topic => ({
          key: "metadata.keyTopics",
          match: { value: topic }
        }))
      ]
    };
    
    let allResults: SearchResult[] = [];
    let offset = 0;
    const limit = 30;
    let hasMore = true;
    
    while (hasMore) {
      try {
        const response = await this.cloudService.qdrantClient.scroll(this.cloudService.getKnowledgeBase(), {
          filter,
          limit,
          offset,
          with_payload: true,
        });
        
        const results = (response.points || []).map((point: any) => ({
          chunkId: point.id,
          documentId: point.payload.documentId,
          content: point.payload.content,
          filename: point.payload.filename,
          score: 1,
          metadata: point.payload.metadata,
        }));
        
        allResults = allResults.concat(results);
        
        if (results.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }
      } catch (error) {
        console.error(`Error in scroll operation: ${(error as Error).message}`);
        hasMore = false;
      }
    }
    
    return allResults;
  }

  async getChunksByProductName(productName: string): Promise<SearchResult[]> {
    await this.cloudService.ensureCollection();
    
    // Create filter for exact product name match
    const filter = {
      must: [
        {
          key: "metadata.productName",
          match: { value: productName }
        }
      ]
    };
    
    let allResults: SearchResult[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;
    
    while (hasMore) {
      try {
        const response = await this.cloudService.qdrantClient.scroll(this.cloudService.getKnowledgeBase(), {
          filter,
          limit,
          offset,
          with_payload: true,
        });
        
        const results = (response.points || []).map((point: any) => ({
          chunkId: point.id,
          documentId: point.payload.documentId,
          content: point.payload.content,
          filename: point.payload.filename,
          score: 1,
          metadata: point.payload.metadata,
        }));
        
        allResults = allResults.concat(results);
        
        if (results.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }
      } catch (error) {
        console.error(`Error in scroll operation: ${(error as Error).message}`);
        hasMore = false;
      }
    }
    
    return allResults;
  }

  /**
   * Test the vector store with a sample query
   * @param {string} query Sample query
   * @returns {Promise<Object>} Test results
   */
  async testSearch(query = "What is the main topic of the documents?"): Promise<any> {
    try {
      console.log(`Testing vector store with query: "${query}"`);
      
      // First check if collection exists and has points
      let pointCount = 0;
      try {
        pointCount = await this.cloudService.getPointCount();
      } catch (error) {
        return {
          success: false,
          message: `Collection check failed: ${(error as Error).message}`,
          query
        };
      }
      
      if (pointCount === 0) {
        return {
          success: false,
          message: `Collection is empty, no points to search`,
          query
        };
      }
      
      // For testing, we'll create a dummy vector (in real use, this would come from embeddings)
      const dummyVector = new Array(1536).fill(0).map(() => Math.random());
      
      // Try to search
      const results = await this.searchSimilar(dummyVector, 5);
      
      return {
        success: true,
        query,
        results: results.map(r => ({
          score: r.score,
          content: r.content.substring(0, 100) + (r.content.length > 100 ? '...' : ''),
          metadata: r.metadata
        })),
        pointCount,
        collectionName: this.cloudService.getKnowledgeBase(),
        stats: this.cloudService.getStats()
      };
    } catch (error) {
      console.error(`Vector store test failed: ${(error as Error).message}`);
      return {
        success: false,
        message: (error as Error).message,
        query
      };
    }
  }

  /**
   * Get system statistics
   * @returns {Object} System statistics
   */
  getStats() {
    return this.cloudService.getStats();
  }
}

export const qdrantService = new QdrantService();