import { createEmbedding, extractDocumentMetadata } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";
import type { Document } from "@shared/schema";
import mammoth from "mammoth";
import pdf2json from "pdf2json";

export interface ProcessedChunk {
  content: string;
  chunkIndex: number;
  metadata?: any;
}

export class DocumentProcessor {
  private chunkSize = 512;
  private chunkOverlap = 50;

  async processDocument(document: Document, fileBuffer: Buffer): Promise<void> {
    try {
      // Update status to processing
      await storage.updateDocumentStatus(document.id, "processing");

      // Extract text based on file type
      const text = await this.extractText(fileBuffer, document.fileType);
      
      // Extract document metadata
      const docMetadata = await extractDocumentMetadata(text, document.originalName);

      // Create intelligent chunks
      const chunks = await this.createIntelligentChunks(text, document.originalName);

      // Process each chunk
      const processedChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Create embedding
        const embedding = await createEmbedding(chunk.content);
        
        // Store chunk in database
        const savedChunk = await storage.createChunk({
          documentId: document.id,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          embedding,
          metadata: chunk.metadata,
        });

        processedChunks.push({
          id: savedChunk.id,
          vector: embedding,
          payload: {
            documentId: document.id,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            filename: document.originalName,
            metadata: chunk.metadata,
          },
        });
      }

      // Add to vector database
      await qdrantService.addPoints(processedChunks);

      // Update document status
      await storage.updateDocumentStatus(document.id, "indexed", new Date());
      await storage.updateDocumentChunkCount(document.id, chunks.length);

    } catch (error) {
      console.error("Document processing failed:", error);
      await storage.updateDocumentStatus(document.id, "error");
      throw error;
    }
  }

  private async extractText(buffer: Buffer, fileType: string): Promise<string> {
    switch (fileType.toLowerCase()) {
      case 'txt':
        return buffer.toString('utf-8');
      
      case 'pdf':
        try {
          return new Promise((resolve, reject) => {
            const pdfParser = new pdf2json();
            
            pdfParser.on("pdfParser_dataError", (errData: any) => {
              reject(new Error(`PDF parsing error: ${errData.parserError}`));
            });
            
            pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
              try {
                let text = '';
                if (pdfData.Pages) {
                  for (const page of pdfData.Pages) {
                    if (page.Texts) {
                      for (const textItem of page.Texts) {
                        if (textItem.R) {
                          for (const run of textItem.R) {
                            if (run.T) {
                              text += decodeURIComponent(run.T) + ' ';
                            }
                          }
                        }
                      }
                    }
                    text += '\n';
                  }
                }
                
                const cleanText = text
                  .replace(/\s+/g, ' ')
                  .trim();
                
                if (cleanText.length < 50) {
                  reject(new Error('PDF text extraction failed - document appears to be empty or corrupted'));
                } else {
                  resolve(cleanText);
                }
              } catch (parseError) {
                reject(new Error(`Failed to parse PDF content: ${(parseError as Error).message}`));
              }
            });
            
            pdfParser.parseBuffer(buffer);
          });
        } catch (error) {
          throw new Error(`Failed to extract PDF text: ${(error as Error).message}`);
        }
      
      case 'docx':
        try {
          const result = await mammoth.extractRawText({ buffer });
          return result.value;
        } catch (error) {
          throw new Error(`Failed to extract DOCX text: ${(error as Error).message}`);
        }
      
      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }
  }

  private async createIntelligentChunks(text: string, filename: string): Promise<ProcessedChunk[]> {
    const chunks: ProcessedChunk[] = [];
    
    // Split text into sentences for better chunking
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    let currentChunk = "";
    let chunkIndex = 0;
    let sentenceIndex = 0;

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;

      // Check if adding this sentence would exceed chunk size
      const potentialChunk = currentChunk + (currentChunk ? '. ' : '') + trimmedSentence;
      
      if (potentialChunk.length > this.chunkSize && currentChunk.length > 0) {
        // Create chunk from current content
        chunks.push({
          content: currentChunk.trim(),
          chunkIndex,
          metadata: {
            filename,
            sentenceStart: sentenceIndex - currentChunk.split('.').length + 1,
            sentenceEnd: sentenceIndex,
            chunkLength: currentChunk.length,
          },
        });

        // Start new chunk with overlap
        const words = currentChunk.split(' ');
        const overlapWords = words.slice(-this.chunkOverlap);
        currentChunk = overlapWords.join(' ') + '. ' + trimmedSentence;
        chunkIndex++;
      } else {
        currentChunk = potentialChunk;
      }
      
      sentenceIndex++;
    }

    // Add final chunk if there's remaining content
    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        chunkIndex,
        metadata: {
          filename,
          sentenceStart: sentenceIndex - currentChunk.split('.').length + 1,
          sentenceEnd: sentenceIndex,
          chunkLength: currentChunk.length,
        },
      });
    }

    return chunks;
  }

  async deleteDocumentFromVector(documentId: number): Promise<void> {
    await qdrantService.deleteByDocumentId(documentId);
  }
}

export const documentProcessor = new DocumentProcessor();
