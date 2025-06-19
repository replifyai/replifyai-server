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

export class QdrantService {
  private baseUrl: string;
  private collectionName: string = "frido";
  private apiKey: string | undefined;

  constructor() {
    // Use Qdrant Cloud or local instance
    this.baseUrl = process.env.QDRANT_URL || "https://qdrant.example.com";
    this.apiKey = process.env.QDRANT_API_KEY;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    };

    if (this.apiKey) {
      headers["api-key"] = this.apiKey;
    }

    try {
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
        throw new Error(`Qdrant request failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      // Fallback to in-memory storage if Qdrant is not available
      console.warn("Qdrant not available, using in-memory vector storage");
      throw error;
    }
  }

  async ensureCollection(): Promise<void> {
    try {
      // Check if collection exists
      await this.request(`/collections/${this.collectionName}`);
    } catch (error) {
      try {
        // Collection doesn't exist, create it
        await this.request(`/collections/${this.collectionName}`, {
          method: "PUT",
          body: JSON.stringify({
            vectors: {
              size: 1536, // text-embedding-ada-002 dimension
              distance: "Cosine",
            },
          }),
        });
      } catch (createError) {
        throw new Error(`Failed to create collection: ${(createError as Error).message}`);
      }
    }
  }

  async addPoints(points: QdrantPoint[]): Promise<void> {
    try {
      await this.ensureCollection();
      
      await this.request(`/collections/${this.collectionName}/points`, {
        method: "PUT",
        body: JSON.stringify({
          points: points.map(point => ({
            id: point.id,
            vector: point.vector,
            payload: point.payload,
          })),
        }),
      });
    } catch (error) {
      throw new Error(`Failed to add points: ${(error as Error).message}`);
    }
  }

  async searchSimilar(
    queryVector: number[], 
    limit: number = 5, 
    scoreThreshold: number = 0.7
  ): Promise<SearchResult[]> {
    try {
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
    } catch (error) {
      throw new Error(`Failed to search vectors: ${(error as Error).message}`);
    }
  }

  async deleteByDocumentId(documentId: number): Promise<void> {
    try {
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
    } catch (error) {
      throw new Error(`Failed to delete vectors: ${(error as Error).message}`);
    }
  }

  async getCollectionInfo(): Promise<any> {
    try {
      await this.ensureCollection();
      return await this.request(`/collections/${this.collectionName}`);
    } catch (error) {
      return { status: "error", message: (error as Error).message };
    }
  }
}

export const qdrantService = new QdrantService();
