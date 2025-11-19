import { Document } from "../../../shared/schema";

export interface SearchResult {
  chunkId: string | number;
  documentId: number;
  content: string;
  filename: string;
  score: number;
  metadata?: any;
}

export interface VectorStoreProvider {
  name: string;
  ensureCollection(): Promise<void>;
  addDocument(document: Document, fileBuffer: Buffer, chunks: any[]): Promise<void>;
  searchSimilar(query: string, limit?: number, threshold?: number, productName?: string): Promise<SearchResult[]>;
  deleteByDocumentId(documentId: string): Promise<void>;
  getCollectionInfo(): Promise<any>;
}

