import fs from 'fs';
import path from 'path';
import { createEmbedding, generateChatResponse, cleanAndFormatText } from './openai.js';

export interface DocumentMetadata {
  title: string;
  type: 'pdf' | 'docx' | 'txt' | 'unknown';
  pageCount?: number;
  summary?: string;
  extractedAt: Date;
}

export interface ProcessedDocument {
  metadata: DocumentMetadata;
  chunks: string[];
  embeddings: number[][];
}

export class UniversalDocumentProcessor {
  private readonly chunkSize = 1000;
  private readonly chunkOverlap = 200;
  private pdfLibInitialized = false;

  constructor() {
    // Remove constructor and initialization during startup
    // PDF parse will be loaded lazily when needed
  }

  private async initializePdfLib() {
    if (this.pdfLibInitialized) return;
    
    try {
      // pdfjsLib = await import('pdfjs-dist');
      
      // Set worker path for Node.js
      if (typeof window === 'undefined') {
        // Node.js environment
        // pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/build/pdf.worker.js');
      }
      
      this.pdfLibInitialized = true;
    } catch (error) {
      console.error('Failed to initialize PDF.js:', error);
      throw new Error('PDF processing is not available');
    }
  }

  /**
   * Process a document from file path
   */
  async processDocument(filePath: string): Promise<ProcessedDocument> {
    try {
      const fileExtension = path.extname(filePath).toLowerCase();
      const fileName = path.basename(filePath, fileExtension);
      const stats = fs.statSync(filePath);
      
      let content = '';
      let pages: number | undefined;

      switch (fileExtension) {
        case '.pdf':
          const result = await this.extractTextFromPDF(filePath);
          content = result.text;
          pages = result.pages;
          break;
        case '.txt':
          content = fs.readFileSync(filePath, 'utf-8');
          break;
        default:
          throw new Error(`Unsupported file type: ${fileExtension}`);
      }

      // Clean and format the extracted text using AI (especially useful for PDFs)
      console.log(`Original text length: ${content.length} characters`);
      if (content.length > 0) {
        console.log('Cleaning text with AI...');
        content = await cleanAndFormatText(content);
        console.log(`Cleaned text length: ${content.length} characters`);
      }

      const summary = await this.generateSummary(content);
      const embedding = await createEmbedding(content);

      return {
        metadata: {
          title: fileName,
          type: fileExtension.substring(1) as DocumentMetadata['type'],
          pageCount: pages,
          summary,
          extractedAt: new Date()
        },
        chunks: await this.splitTextIntoChunks(content),
        embeddings: [embedding]
      };
    } catch (error) {
      console.error('Error processing document:', error);
      throw error;
    }
  }

  /**
   * Process a document from buffer (for file uploads)
   */
  async processDocumentFromBuffer(
    fileBuffer: Buffer, 
    fileName: string, 
    fileExtension?: string
  ): Promise<ProcessedDocument> {
    try {
      const ext = fileExtension || path.extname(fileName).toLowerCase();
      const baseName = path.basename(fileName, ext);
      
      let content = '';
      let pages: number | undefined;

      switch (ext) {
        case '.pdf':
          const result = await this.extractTextFromPDFBuffer(fileBuffer);
          content = result.text;
          pages = result.pages;
          break;
        case '.txt':
          content = fileBuffer.toString('utf-8');
          break;
        default:
          throw new Error(`Unsupported file type: ${ext}`);
      }

      // Clean and format the extracted text using AI (especially useful for PDFs)
      console.log(`Original text length: ${content.length} characters`);
      if (content.length > 0) {
        console.log('Cleaning text with AI...');
        content = await cleanAndFormatText(content);
        console.log(`Cleaned text length: ${content.length} characters`);
      }

      const summary = await this.generateSummary(content);
      const embedding = await createEmbedding(content);

      return {
        metadata: {
          title: baseName,
          type: ext.substring(1) as DocumentMetadata['type'],
          pageCount: pages,
          summary,
          extractedAt: new Date()
        },
        chunks: await this.splitTextIntoChunks(content),
        embeddings: [embedding]
      };
    } catch (error) {
      console.error('Error processing document from buffer:', error);
      throw error;
    }
  }

  private async extractTextFromPDF(filePath: string): Promise<{ text: string; pages: number }> {
    try {
      const dataBuffer = fs.readFileSync(filePath);
      return await this.extractTextFromPDFBuffer(dataBuffer);
    } catch (error) {
      console.error('Error extracting text from PDF file:', error);
      throw new Error(`Failed to extract text from PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async extractTextFromPDFBuffer(dataBuffer: Buffer): Promise<{ text: string; pages: number }> {
    try {
      // Lazy load pdf-parse only when needed
      const pdfParse = (await import('pdf-parse')).default;
      
      const data = await pdfParse(dataBuffer);
      return {
        text: data.text || '',
        pages: data.numpages || 0
      };
    } catch (error) {
      console.error('Error extracting text from PDF buffer:', error);
      throw new Error(`Failed to extract text from PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Split text into manageable chunks and clean them with AI
   */
  private async splitTextIntoChunks(text: string): Promise<string[]> {
    const chunks: string[] = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    let currentChunk = '';
    
    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;
      
      const potentialChunk = currentChunk + (currentChunk ? '. ' : '') + trimmedSentence;
      
      if (potentialChunk.length <= this.chunkSize) {
        currentChunk = potentialChunk;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk + '.');
        }
        currentChunk = trimmedSentence;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk + '.');
    }
    
    const rawChunks = chunks.filter(chunk => chunk.trim().length > 0);
    
    // Clean each chunk with AI if it appears to have noise (scattered characters)
    const cleanedChunks: string[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const chunk = rawChunks[i];
      
      // Check if chunk has scattered characters (multiple single character words)
      const words = chunk.split(/\s+/);
      const singleCharWords = words.filter(word => word.length === 1 && /[a-zA-Z]/.test(word));
      const hasScatteredChars = singleCharWords.length > words.length * 0.3; // More than 30% single char words
      
      if (hasScatteredChars && chunk.length > 50) {
        console.log(`Cleaning noisy chunk ${i + 1}/${rawChunks.length}...`);
        try {
          const cleanedChunk = await cleanAndFormatText(chunk);
          cleanedChunks.push(cleanedChunk);
        } catch (error) {
          console.error(`Failed to clean chunk ${i + 1}:`, error);
          cleanedChunks.push(chunk); // Use original if cleaning fails
        }
      } else {
        cleanedChunks.push(chunk);
      }
    }
    
    return cleanedChunks;
  }

  /**
   * Generate document summary using OpenAI
   */
  private async generateSummary(text: string): Promise<string> {
    try {
      const truncatedText = text.substring(0, 3000); // Limit text for summary
      
      const prompt = `Please provide a concise summary of the following document in 2-3 sentences:`;
      
      const response = await generateChatResponse(prompt, [truncatedText]);
      
      return response || 'Summary not available';
    } catch (error) {
      console.error('Error generating summary:', error);
      return 'Summary generation failed';
    }
  }

  /**
   * Search for relevant chunks based on query
   */
  async searchSimilarChunks(
    query: string, 
    processedDoc: ProcessedDocument, 
    topK: number = 5
  ): Promise<Array<{ chunk: string; similarity: number; index: number }>> {
    try {
      const queryEmbedding = await createEmbedding(query);
      
      const similarities = processedDoc.embeddings.map((embedding, index) => ({
        chunk: processedDoc.chunks[index],
        similarity: this.cosineSimilarity(queryEmbedding, embedding),
        index
      }));
      
      return similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);
    } catch (error) {
      console.error('Error searching similar chunks:', error);
      throw new Error('Failed to search similar chunks');
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

// Export singleton instance
export const universalDocumentProcessor = new UniversalDocumentProcessor(); 