import { env } from "../env";

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
      await this.request(`/collections/${this.collectionName}`);
      console.log(`Collection '${this.collectionName}' exists.`);
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
    limit: number = 5, 
    scoreThreshold: number = 0.7
  ): Promise<SearchResult[]> {
    await this.ensureCollection();

    const response = await this.request(`/collections/${this.collectionName}/points/search`, {
      method: "POST",
      body: JSON.stringify({
        vector: queryVector,
        limit,
        score_threshold: scoreThreshold,
        with_payload: true,
      }),
    });

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
    limit: number = 5, 
    scoreThreshold: number = 0.7
  ): Promise<SearchResult[]> {
    return await this.cloudService.searchSimilar(queryVector, limit, scoreThreshold);
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
}

export const qdrantService = new QdrantService();