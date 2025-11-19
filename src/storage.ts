import { documents, documentChunks, chatMessages, settings, contextMissingQueries, type Document, type InsertDocument, type DocumentChunk, type InsertChunk, type ChatMessage, type InsertMessage, type Setting, type InsertSetting, type ContextMissingQuery, type InsertContextMissingQuery } from "../shared/schema.js";

export interface IStorage {
  // Document operations
  createDocument(document: InsertDocument): Promise<Document>;
  getDocument(id: number): Promise<Document | undefined>;
  getAllDocuments(): Promise<Document[]>;
  updateDocumentStatus(id: number, status: string, processedAt?: Date): Promise<void>;
  updateDocumentChunkCount(id: number, chunkCount: number): Promise<void>;
  updateDocumentMetadata(id: number, metadata: Record<string, any>): Promise<void>;
  deleteDocument(id: number): Promise<void>;

  // Chunk operations
  createChunk(chunk: InsertChunk): Promise<DocumentChunk>;
  getChunksByDocument(documentId: number): Promise<DocumentChunk[]>;
  deleteChunksByDocument(documentId: number): Promise<void>;

  // Chat operations
  createMessage(message: InsertMessage): Promise<ChatMessage>;
  getAllMessages(): Promise<ChatMessage[]>;

  // Context missing query operations
  createContextMissingQuery(query: InsertContextMissingQuery): Promise<ContextMissingQuery>;
  getUnresolvedContextMissingQueries(): Promise<ContextMissingQuery[]>;
  resolveContextMissingQuery(queryId: number, resolutionNotes?: string): Promise<void>;
  getContextMissingAnalytics(): Promise<{
    totalQueries: number;
    resolvedQueries: number;
    byCategory: Record<string, number>;
    byPriority: Record<string, number>;
    recentTrends: any[];
  }>;

  // Settings operations
  getSetting(key: string): Promise<Setting | undefined>;
  setSetting(setting: InsertSetting): Promise<Setting>;
}

export class MemStorage implements IStorage {
  private documents: Map<number, Document>;
  private chunks: Map<number, DocumentChunk>;
  private messages: Map<number, ChatMessage>;
  private contextMissingQueries: Map<number, ContextMissingQuery>;
  private settingsMap: Map<string, Setting>;
  private currentDocumentId: number;
  private currentChunkId: number;
  private currentMessageId: number;
  private currentContextMissingId: number;
  private currentSettingId: number;

  constructor() {
    this.documents = new Map();
    this.chunks = new Map();
    this.messages = new Map();
    this.contextMissingQueries = new Map();
    this.settingsMap = new Map();
    this.currentDocumentId = 1;
    this.currentChunkId = 1;
    this.currentMessageId = 1;
    this.currentContextMissingId = 1;
    this.currentSettingId = 1;
  }

  async createDocument(insertDocument: InsertDocument): Promise<Document> {
    const id = this.currentDocumentId++;
    const document: Document = {
      ...insertDocument,
      id,
      uploadedAt: new Date(),
      processedAt: null,
      chunkCount: 0,
      status: insertDocument.status || "uploading",
      metadata: insertDocument.metadata || null,
    };
    this.documents.set(id, document);
    return document;
  }

  async getDocument(id: number): Promise<Document | undefined> {
    return this.documents.get(id);
  }

  async getAllDocuments(): Promise<Document[]> {
    return Array.from(this.documents.values()).sort((a, b) => 
      b.uploadedAt.getTime() - a.uploadedAt.getTime()
    );
  }

  async updateDocumentStatus(id: number, status: string, processedAt?: Date): Promise<void> {
    const document = this.documents.get(id);
    if (document) {
      document.status = status;
      if (processedAt) {
        document.processedAt = processedAt;
      }
      this.documents.set(id, document);
    }
  }

  async updateDocumentChunkCount(id: number, chunkCount: number): Promise<void> {
    const document = this.documents.get(id);
    if (document) {
      document.chunkCount = chunkCount;
      this.documents.set(id, document);
    }
  }

  async updateDocumentMetadata(id: number, metadata: Record<string, any>): Promise<void> {
    const document = this.documents.get(id);
    if (document) {
      const currentMetadata = (document.metadata as Record<string, any>) || {};
      document.metadata = {
        ...currentMetadata,
        ...metadata,
      };
      this.documents.set(id, document);
    }
  }

  async deleteDocument(id: number): Promise<void> {
    this.documents.delete(id);
    // Delete associated chunks
    const chunksToDelete = Array.from(this.chunks.values()).filter(chunk => chunk.documentId === id);
    chunksToDelete.forEach(chunk => this.chunks.delete(chunk.id));
  }

  async createChunk(insertChunk: InsertChunk): Promise<DocumentChunk> {
    const id = this.currentChunkId++;
    const chunk: DocumentChunk = {
      ...insertChunk,
      id,
      createdAt: new Date(),
      embedding: insertChunk.embedding || null,
      metadata: insertChunk.metadata || null,
    };
    this.chunks.set(id, chunk);
    return chunk;
  }

  async getChunksByDocument(documentId: number): Promise<DocumentChunk[]> {
    return Array.from(this.chunks.values())
      .filter(chunk => chunk.documentId === documentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async deleteChunksByDocument(documentId: number): Promise<void> {
    const chunksToDelete = Array.from(this.chunks.values()).filter(chunk => chunk.documentId === documentId);
    chunksToDelete.forEach(chunk => this.chunks.delete(chunk.id));
  }

  async createMessage(insertMessage: InsertMessage): Promise<ChatMessage> {
    const id = this.currentMessageId++;
    const message: ChatMessage = {
      ...insertMessage,
      id,
      createdAt: new Date(),
      sources: insertMessage.sources || null,
      isContextMissing: insertMessage.isContextMissing || false,
      tags: insertMessage.tags || null,
    };
    this.messages.set(id, message);
    return message;
  }

  async getAllMessages(): Promise<ChatMessage[]> {
    return Array.from(this.messages.values()).sort((a, b) => 
      a.createdAt.getTime() - b.createdAt.getTime()
    );
  }

  async getSetting(key: string): Promise<Setting | undefined> {
    return this.settingsMap.get(key);
  }

  async setSetting(insertSetting: InsertSetting): Promise<Setting> {
    const existing = this.settingsMap.get(insertSetting.key);
    if (existing) {
      existing.value = insertSetting.value;
      existing.updatedAt = new Date();
      this.settingsMap.set(insertSetting.key, existing);
      return existing;
    } else {
      const id = this.currentSettingId++;
      const setting: Setting = {
        ...insertSetting,
        id,
        updatedAt: new Date(),
      };
      this.settingsMap.set(insertSetting.key, setting);
      return setting;
    }
  }

  async createContextMissingQuery(insertQuery: InsertContextMissingQuery): Promise<ContextMissingQuery> {
    const id = this.currentContextMissingId++;
    const query: ContextMissingQuery = {
      ...insertQuery,
      id,
      createdAt: new Date(),
      resolvedAt: null,
      detectedPatterns: insertQuery.detectedPatterns || null,
      suggestedTopics: insertQuery.suggestedTopics || null,
      category: insertQuery.category || null,
      priority: insertQuery.priority || "medium",
      resolved: insertQuery.resolved || false,
      resolutionNotes: insertQuery.resolutionNotes || null,
    };
    this.contextMissingQueries.set(id, query);
    return query;
  }

  async getUnresolvedContextMissingQueries(): Promise<ContextMissingQuery[]> {
    return Array.from(this.contextMissingQueries.values())
      .filter(query => !query.resolved)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async resolveContextMissingQuery(queryId: number, resolutionNotes?: string): Promise<void> {
    const query = this.contextMissingQueries.get(queryId);
    if (query) {
      query.resolved = true;
      query.resolvedAt = new Date();
      if (resolutionNotes) {
        query.resolutionNotes = resolutionNotes;
      }
      this.contextMissingQueries.set(queryId, query);
    }
  }

  async getContextMissingAnalytics(): Promise<{
    totalQueries: number;
    resolvedQueries: number;
    byCategory: Record<string, number>;
    byPriority: Record<string, number>;
    recentTrends: any[];
  }> {
    const queries = Array.from(this.contextMissingQueries.values());
    const resolvedQueries = queries.filter(q => q.resolved);
    
    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    
    queries.forEach(query => {
      if (query.category) {
        byCategory[query.category] = (byCategory[query.category] || 0) + 1;
      }
      if (query.priority) {
        byPriority[query.priority] = (byPriority[query.priority] || 0) + 1;
      }
    });

    // Recent trends (last 30 days by day)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentQueries = queries.filter(q => q.createdAt >= thirtyDaysAgo);
    const trendsByDate: Record<string, number> = {};
    
    recentQueries.forEach(query => {
      const dateKey = query.createdAt.toISOString().split('T')[0];
      trendsByDate[dateKey] = (trendsByDate[dateKey] || 0) + 1;
    });
    
    const recentTrends = Object.entries(trendsByDate)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      totalQueries: queries.length,
      resolvedQueries: resolvedQueries.length,
      byCategory,
      byPriority,
      recentTrends,
    };
  }
}

export const storage = new MemStorage();
