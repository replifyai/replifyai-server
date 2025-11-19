import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { env } from "../../../env.js";
import { VectorStoreProvider, SearchResult } from "./types.js";
import { Document } from "../../../shared/schema.js";
import { storage } from "../../../storage.js";
import fs from "fs";
import path from "path";
import os from "os";

export class GoogleRAGService implements VectorStoreProvider {
  name = "google";
  private genAI: GoogleGenerativeAI;
  private fileManager: GoogleAIFileManager;
  // Based on 404 errors, 'models/gemini-1.5-flash' isn't found. 
  // Usually just 'gemini-1.5-flash' works, but let's try the explicit stable version.
  private modelName = "gemini-1.5-flash-001"; 

  constructor() {
    this.genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
    this.fileManager = new GoogleAIFileManager(env.GOOGLE_API_KEY);
  }

  async ensureCollection(): Promise<void> {
    // No explicit collection management needed for Google File API
    console.log("Google RAG Service initialized");
  }

  async addDocument(document: Document, fileBuffer: Buffer, chunks: any[]): Promise<void> {
    console.log(`Uploading document ${document.originalName} to Google AI...`);
    
    // Create a temporary file
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `${document.id}_${document.originalName}`);
    
    try {
      fs.writeFileSync(tempFilePath, fileBuffer);

      const uploadResult = await this.fileManager.uploadFile(tempFilePath, {
        mimeType: this.getMimeType(document.fileType),
        displayName: document.originalName,
      });

      console.log(`Uploaded file ${uploadResult.file.displayName} as: ${uploadResult.file.uri}`);

      // Wait for file to be active
      let file = await this.fileManager.getFile(uploadResult.file.name);
      while (file.state === FileState.PROCESSING) {
        console.log("Waiting for file processing...");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        file = await this.fileManager.getFile(uploadResult.file.name);
      }

      if (file.state === FileState.FAILED) {
        throw new Error("File processing failed");
      }

      console.log(`File ${file.displayName} is ready.`);

      // Update document metadata with URI
      // We need to fetch the latest document to get existing metadata
      const latestDoc = await storage.getDocument(document.id);
      const metadata = latestDoc?.metadata || {};
      
      await storage.updateDocumentMetadata(document.id, {
        ...metadata,
        googleFileUri: file.uri,
        googleFileName: file.name
      });

    } catch (error) {
      console.error("Error uploading to Google:", error);
      throw error;
    } finally {
      // Cleanup temp file
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }

  async searchSimilar(query: string, limit: number = 10, threshold: number = 0.5, productName?: string): Promise<SearchResult[]> {
    console.log(`Searching with Google RAG for: ${query}`);

    // 1. Get all indexed documents
    const documents = await storage.getAllDocuments();
    const indexedDocs = documents.filter(doc => doc.status === "indexed" && (doc.metadata as any)?.googleFileUri);

    // Filter by product name if provided
    const relevantDocs = productName 
      ? indexedDocs.filter(doc => {
          const meta = doc.metadata as any;
          // Simple check if product name matches filename or metadata
          return (meta.productName && meta.productName.includes(productName)) || 
                 doc.originalName.includes(productName);
        })
      : indexedDocs;

    if (relevantDocs.length === 0) {
      console.log("No relevant documents found for Google RAG search");
      return [];
    }

    // 2. Prepare file parts for the model
    // Note: There's a limit to how many files/tokens we can pass. 
    // For now, we pass all relevant ones assuming they fit in context (1M/2M tokens).
    const fileParts = relevantDocs.map(doc => ({
      fileData: {
        mimeType: this.getMimeType(doc.fileType),
        fileUri: (doc.metadata as any).googleFileUri
      }
    }));

    // 3. Generate content to extract quotes
    // Use the specific model name that was set in the class property
    const model = this.genAI.getGenerativeModel({ model: this.modelName });

    const prompt = `
      You are a helpful assistant. Your task is to find relevant information in the provided files for the user's query.
      
      QUERY: "${query}"
      
      Please extract the most relevant passages (chunks) from the files that answer the query.
      Return the result as a JSON array of objects. Each object should have:
      - "content": The exact text of the passage.
      - "filename": The name of the file it came from (if you can identify it, otherwise use "Unknown").
      - "relevance": A score from 0 to 1 indicating relevance.
      
      Limit to ${limit} most relevant passages.
      
      JSON Output Format:
      [
        { "content": "...", "filename": "...", "relevance": 0.9 }
      ]
    `;

    try {
      const result = await model.generateContent([
        ...fileParts,
        { text: prompt }
      ]);

      const responseText = result.response.text();
      // Clean potential markdown code blocks
      const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
      
      let parsedResults;
      try {
        parsedResults = JSON.parse(cleanJson);
      } catch (e) {
        // Fallback: try to find array in text if full text isn't JSON
        const jsonMatch = cleanJson.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsedResults = JSON.parse(jsonMatch[0]);
        } else {
            console.warn("Could not parse JSON from Google RAG response:", responseText);
            return [];
        }
      }

      if (!Array.isArray(parsedResults)) {
          return [];
      }

      // Map to SearchResult
      return parsedResults.map((item: any, index: number) => ({
        chunkId: `google_${Date.now()}_${index}`,
        documentId: 0, // We might not know the exact document ID easily unless we map filenames back
        content: item.content,
        filename: item.filename || "google-doc",
        score: item.relevance,
        metadata: { source: "google-rag" }
      }));

    } catch (error) {
      console.error("Error in Google RAG search:", error);
      return [];
    }
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    // Find the document to get the Google File Name
    // Since we might not have the document object here, we rely on storage
    // But documentId is string here, storage expects number usually? 
    // QdrantService uses string for documentId in deleteByDocumentId?
    // Let's check QdrantService. It takes productName actually in one method, and documentId in another.
    
    // Assuming documentId is the ID from our DB.
    const id = parseInt(documentId);
    if (isNaN(id)) return;

    const doc = await storage.getDocument(id);
    if (doc && (doc.metadata as any)?.googleFileName) {
      try {
        await this.fileManager.deleteFile((doc.metadata as any).googleFileName);
        console.log(`Deleted Google file: ${(doc.metadata as any).googleFileName}`);
      } catch (error) {
        console.warn(`Failed to delete Google file: ${error}`);
      }
    }
  }

  async getCollectionInfo(): Promise<any> {
    return {
      name: "google-file-storage",
      status: "active"
    };
  }

  private getMimeType(fileType: string): string {
    const type = fileType.toLowerCase();
    if (type === 'pdf') return 'application/pdf';
    if (type === 'md' || type === 'markdown') return 'text/plain'; // Markdown often treated as text
    if (type === 'txt') return 'text/plain';
    if (type === 'csv') return 'text/csv';
    return 'application/pdf'; // Default
  }
}

export const googleRAGService = new GoogleRAGService();
