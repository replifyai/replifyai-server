import { createEmbedding, generateChatResponse } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";

export interface RAGResponse {
  response: string;
  sources: Array<{
    documentId: number;
    filename: string;
    content: string;
    score: number;
    metadata?: any;
  }>;
}

export class RAGService {
  async queryDocuments(query: string, options: {
    retrievalCount?: number;
    similarityThreshold?: number;
  } = {}): Promise<RAGResponse> {
    const { retrievalCount = 20, similarityThreshold = 0.75 } = options;

    try {
      // Create embedding for the query
      const queryEmbedding = await createEmbedding(query);

      // Search for similar chunks
      const searchResults = await qdrantService.searchSimilar(
        queryEmbedding,
        retrievalCount,
        similarityThreshold
      );

      if (searchResults.length === 0) {
        return {
          response: "I don't have enough information in the uploaded documents to answer this question. Please try uploading relevant documents first.",
          sources: [],
        };
      }

      // Prepare context from search results
      const contextChunks = searchResults.map(result => 
        `[From: ${result.filename}]\n${result.content}`
      );

      // Generate response using OpenAI
      const response = await generateChatResponse(query, contextChunks);

      // Prepare sources information
      const sources = searchResults.map(result => ({
        documentId: result.documentId,
        filename: result.filename,
        content: result.content.substring(0, 200) + "...", // Truncate for display
        score: result.score,
        metadata: result.metadata,
      }));

      // Store the conversation
      await storage.createMessage({
        message: query,
        response,
        sources: sources,
      });

      return {
        response,
        sources,
      };

    } catch (error: any) {
      console.error("RAG query failed:", error);
      throw new Error(`Failed to process query: ${error.message}`);
    }
  }

  async getSystemStats(): Promise<{
    documentCount: number;
    chunkCount: number;
    indexedDocuments: number;
  }> {
    const documents = await storage.getAllDocuments();
    const indexedDocuments = documents.filter(doc => doc.status === "indexed");
    const totalChunks = indexedDocuments.reduce((sum, doc) => sum + (doc.chunkCount || 0), 0);

    return {
      documentCount: documents.length,
      chunkCount: totalChunks,
      indexedDocuments: indexedDocuments.length,
    };
  }

  async getQdrantStatus(): Promise<any> {
    try {
      return await qdrantService.getCollectionInfo();
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
}

export const ragService = new RAGService();
