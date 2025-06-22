import { documents, documentChunks, chatMessages, settings, type Document, type InsertDocument, type DocumentChunk, type InsertChunk, type ChatMessage, type InsertMessage, type Setting, type InsertSetting } from "../shared/schema.js";

export interface IStorage {
  // Document operations
  createDocument(document: InsertDocument): Promise<Document>;
  getDocument(id: number): Promise<Document | undefined>;
  getAllDocuments(): Promise<Document[]>;
  updateDocumentStatus(id: number, status: string, processedAt?: Date): Promise<void>;
  updateDocumentChunkCount(id: number, chunkCount: number): Promise<void>;
  deleteDocument(id: number): Promise<void>;

  // Chunk operations
  createChunk(chunk: InsertChunk): Promise<DocumentChunk>;
  getChunksByDocument(documentId: number): Promise<DocumentChunk[]>;
  deleteChunksByDocument(documentId: number): Promise<void>;

  // Chat operations
  createMessage(message: InsertMessage): Promise<ChatMessage>;
  getAllMessages(): Promise<ChatMessage[]>;

  // Settings operations
  getSetting(key: string): Promise<Setting | undefined>;
  setSetting(setting: InsertSetting): Promise<Setting>;
}

export class MemStorage implements IStorage {
  private documents: Map<number, Document>;
  private chunks: Map<number, DocumentChunk>;
  private messages: Map<number, ChatMessage>;
  private settingsMap: Map<string, Setting>;
  private currentDocumentId: number;
  private currentChunkId: number;
  private currentMessageId: number;
  private currentSettingId: number;

  constructor() {
    this.documents = new Map();
    this.chunks = new Map();
    this.messages = new Map();
    this.settingsMap = new Map();
    this.currentDocumentId = 1;
    this.currentChunkId = 1;
    this.currentMessageId = 1;
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
}

export const storage = new MemStorage();
