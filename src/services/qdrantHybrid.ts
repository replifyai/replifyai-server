import { env } from "../env.js";

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
  private baseUrl: string;
  private collectionName: string = process.env.QDRANT_COLLECTION_NAME || "documents";
  private apiKey: string | undefined;

  constructor() {
    this.baseUrl = process.env.QDRANT_URL || "";
    this.apiKey = process.env.QDRANT_API_KEY;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (this.apiKey) {
      headers["api-key"] = this.apiKey;
    }

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), env.API_TIMEOUT);

    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorDetails = '';
      try {
        const errorBody = await response.text();
        errorDetails = errorBody ? ` - ${errorBody}` : '';
      } catch (e) {
        // If we can't read the response body, that's ok
      }
      throw new Error(`Qdrant request failed: ${response.status} ${response.statusText}${errorDetails}`);
    }

    return response.json();
  }

  async ensureCollection(): Promise<void> {
    try {
      console.log(`Checking if collection '${this.collectionName}' exists...`);
      // await this.request(`/collections/${this.collectionName}`);
      console.log(`Collection '${this.collectionName}' exists.`);
      
      // Check if keyTopics index exists, if not create it
      try {
        await this.request(`/collections/${this.collectionName}/index/metadata.keyTopics`);
        console.log(`Index for metadata.keyTopics already exists.`);
      } catch (indexError) {
        console.log(`Creating index for metadata.keyTopics...`);
        await this.request(`/collections/${this.collectionName}/index`, {
          method: "PUT",
          body: JSON.stringify({
            field_name: "metadata.keyTopics",
            field_schema: "keyword"
          }),
        });
        console.log(`Index for metadata.keyTopics created successfully.`);
      }
      
      // Check if product_name index exists, if not create it
      try {
        await this.request(`/collections/${this.collectionName}/index/metadata.docMetadata.key_entities.product_name`);
        console.log(`Index for metadata.docMetadata.key_entities.product_name already exists.`);
      } catch (indexError) {
        console.log(`Creating index for metadata.docMetadata.key_entities.product_name...`);
        await this.request(`/collections/${this.collectionName}/index`, {
          method: "PUT",
          body: JSON.stringify({
            field_name: "metadata.docMetadata.key_entities.product_name",
            field_schema: "keyword"
          }),
        });
        console.log(`Index for metadata.docMetadata.key_entities.product_name created successfully.`);
      }
      try {
        await this.request(`/collections/${this.collectionName}/index/metadata.productName`);
        console.log(`Index for metadata.productName already exists.`);
      } catch (indexError) {
        console.log(`Creating index for metadata.productName...`);
        await this.request(`/collections/${this.collectionName}/index`, {
          method: "PUT",
          body: JSON.stringify({
            field_name: "metadata.productName",
            field_schema: "keyword"
          }),
        });
        console.log(`Index for metadata.productName created successfully.`);
      }
    } catch (error) {
      console.log(`Collection '${this.collectionName}' does not exist. Creating...`);
      await this.request(`/collections/${this.collectionName}`, {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            size: 1536,
            distance: "Cosine",
          },
        }),
      });
      console.log(`Collection '${this.collectionName}' created successfully.`);
      
      // Create index for metadata.keyTopics after collection creation
      console.log(`Creating index for metadata.keyTopics...`);
      await this.request(`/collections/${this.collectionName}/index`, {
        method: "PUT",
        body: JSON.stringify({
          field_name: "metadata.keyTopics",
          field_schema: "keyword"
        }),
      });
      console.log(`Index for metadata.keyTopics created successfully.`);
      
      // Create index for metadata.docMetadata.key_entities.product_name after collection creation
      console.log(`Creating index for metadata.docMetadata.key_entities.product_name...`);
      await this.request(`/collections/${this.collectionName}/index`, {
        method: "PUT",
        body: JSON.stringify({
          field_name: "metadata.docMetadata.key_entities.product_name",
          field_schema: "keyword"
        }),
      });
      console.log(`Index for metadata.docMetadata.key_entities.product_name created successfully.`);
    }
  }

  async addPoints(points: QdrantPoint[]): Promise<void> {
    await this.ensureCollection();
    
    // Validate collection configuration
    try {
      const collectionInfo = await this.request(`/collections/${this.collectionName}`);
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
        id: points[0].id,
        vectorLength: points[0].vector?.length,
        payload: points[0].payload
      } : null
    });
    
    await this.request(`/collections/${this.collectionName}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({
        points: points.map(point => ({
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        })),
      }),
    });
  }

  async searchSimilar(
    queryVector: number[], 
    limit: number = 10, 
    scoreThreshold: number = 0.7,
    productName?: string
  ): Promise<SearchResult[]> {
    console.log("🚀 ~ QdrantCloudService ~ productName:", productName);
    // await this.ensureCollection();
    
    const searchBody: any = {
      vector: queryVector,
      limit:10,
      score_threshold: scoreThreshold,
      with_payload: true,
    };
    
    // Only add filter if productName is provided and not empty
    if (productName && productName.trim() !== '') {
      searchBody.filter = {
        must: [
          { key: "metadata.productName", match: { value: productName } }
        ]
      };
    }
    
    const response = await this.request(`/collections/${this.collectionName}/points/search`, {
      method: "POST",
      body: JSON.stringify(searchBody),
    });

    console.log("🚀 ~ QdrantCloudService ~ returnresponse.result.map ~ response:", JSON.stringify(response, null, 2));
    return response.result.map((result: any) => ({
      chunkId: result.id,
      documentId: result.payload.documentId,
      content: result.payload.content,
      filename: result.payload.filename,
      score: result.score,
      metadata: result.payload.metadata,
    }));
  }

  async deleteByDocumentId(documentId: number): Promise<void> {
    await this.ensureCollection();

    await this.request(`/collections/${this.collectionName}/points/delete`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          must: [
            {
              key: "documentId",
              match: { value: documentId },
            },
          ],
        },
      }),
    });
  }

  async getCollectionInfo(): Promise<any> {
    await this.ensureCollection();
    return await this.request(`/collections/${this.collectionName}`);
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
    limit: number = 10, 
    scoreThreshold: number = 0.7,
    productName?: string
  ): Promise<SearchResult[]> {
    return await this.cloudService.searchSimilar(queryVector, limit, scoreThreshold, productName);
  }

  async deleteByDocumentId(documentId: number): Promise<void> {
    await this.cloudService.deleteByDocumentId(documentId);
  }

  async getCollectionInfo(): Promise<any> {
    const result = await this.cloudService.getCollectionInfo();
    return {
      ...result,
      backend: "qdrant-cloud"
    };
  }

  async getChunksByProductsOrTopics(products: string[],topics: string[]): Promise<SearchResult[]> {
    await this.cloudService.ensureCollection();
    
    // Create filter for product names - find chunks where product_name matches any of the provided products
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
      const response = await this.cloudService["request"](`/collections/${this.cloudService["collectionName"]}/points/scroll`, {
        method: "POST",
        body: JSON.stringify({
          filter,
          limit,
          offset,
          with_payload: true,
        }),
      });
      
      const results = (response.result?.points || []).map((point: any) => ({
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
      const response = await this.cloudService["request"](`/collections/${this.cloudService["collectionName"]}/points/scroll`, {
        method: "POST",
        body: JSON.stringify({
          filter,
          limit,
          offset,
          with_payload: true,
        }),
      });
      
      const results = (response.result?.points || []).map((point: any) => ({
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
    }
    
    return allResults;
  }
}

export const qdrantService = new QdrantService();