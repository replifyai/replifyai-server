import { createEmbedding, extractDocumentMetadata } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";
import type { Document } from "../../shared/schema.js";
import mammoth from "mammoth";
import pdf2json from "pdf2json";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface ProcessedChunk {
  content: string;
  chunkIndex: number;
  metadata?: any;
  qualityScore?: number;
}

export interface ChunkingStrategy {
  name: string;
  minChunkSize: number;
  maxChunkSize: number;
  overlapSize: number;
  preserveStructure: boolean;
  qualityThreshold?: number;
}

export interface AIChunkingResult {
  chunks: Array<{
    content: string;
    title: string;
    summary: string;
    keyTopics: string[];
    importance: number;
    chunkType: 'introduction' | 'specification' | 'features' | 'pricing' | 'policies' | 'technical' | 'general';
  }>;
  documentSummary: string;
  documentType: string;
}

export class DocumentProcessor {
  private defaultStrategy: ChunkingStrategy = {
    name: "ai-powered",
    minChunkSize: 200,
    maxChunkSize: 1200,
    overlapSize: 100,
    preserveStructure: true,
    qualityThreshold: 0.8
  };

  private productDocStrategy: ChunkingStrategy = {
    name: "ai-product-focused",
    minChunkSize: 150,
    maxChunkSize: 1000,
    overlapSize: 80,
    preserveStructure: true,
    qualityThreshold: 0.9
  };

  async processDocument(document: Document, fileBuffer: Buffer, sourceUrl?: string): Promise<void> {
    try {
      // Update status to processing
      await storage.updateDocumentStatus(document.id, "processing");

      // Extract text with enhanced extraction
      const rawText = await this.extractText(fileBuffer, document.fileType);
      
      // Clean and normalize the extracted text
      const text = this.cleanAndNormalizeText(rawText);
      
      console.log(`Extracted text length: ${text.length} characters (cleaned from ${rawText.length})`);
      
      // Validate text quality
      if (!this.validateTextQuality(text)) {
        throw new Error("Extracted text quality is too poor for processing");
      }
      
      // Extract document metadata
      const docMetadata = await extractDocumentMetadata(text, document.originalName);

      // Determine chunking strategy
      const strategy = this.determineChunkingStrategy(document.originalName, text);
      console.log(`Using strategy: ${strategy.name}`);

      // Use AI-powered intelligent chunking
      const aiChunkingResult = await this.createAIChunks(text, document.originalName, strategy);
      console.log("🚀 ~ DocumentProcessor ~ processDocument ~ aiChunkingResult:", JSON.stringify(aiChunkingResult, null, 2));
      
      // Convert AI chunks to ProcessedChunks
      const processedChunks = aiChunkingResult.chunks.map((aiChunk, index) => ({
        content: aiChunk.content,
        chunkIndex: index,
        qualityScore: Math.min(aiChunk.importance / 10, 1), // Convert importance to quality score
        metadata: {
          filename: document.originalName,
          title: aiChunk.title,
          summary: aiChunk.summary,
          keyTopics: aiChunk.keyTopics,
          importance: aiChunk.importance,
          chunkType: aiChunk.chunkType,
          chunkLength: aiChunk.content.length,
          strategy: strategy.name,
          docMetadata,
          documentSummary: aiChunkingResult.documentSummary,
          documentType: aiChunkingResult.documentType,
          sourceUrl: sourceUrl || (document.metadata as any)?.sourceUrl, // Include source URL if available
          uploadType: (document.metadata as any)?.uploadType || 'file'
        }
      }));
      console.log("🚀 ~ DocumentProcessor ~ processedChunks ~ processedChunks:", JSON.stringify(processedChunks, null, 2));

      console.log(`Created ${processedChunks.length} AI-powered chunks`);

      // Process each chunk
      const vectorChunks = [];
      for (let i = 0; i < processedChunks.length; i++) {
        const chunk = processedChunks[i];
        
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

        vectorChunks.push({
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
      await qdrantService.addPoints(vectorChunks);

      // Update document status
      await storage.updateDocumentStatus(document.id, "indexed", new Date());
      await storage.updateDocumentChunkCount(document.id, processedChunks.length);

    } catch (error) {
      console.error("Document processing failed:", error);
      await storage.updateDocumentStatus(document.id, "error");
      throw error;
    }
  }

  private async createAIChunks(
    text: string, 
    filename: string, 
    strategy: ChunkingStrategy
  ): Promise<AIChunkingResult> {
    try {
      const prompt = this.buildAIChunkingPrompt(text, filename, strategy);
      
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert document analyzer and chunking specialist. Your task is to intelligently break down documents into semantically meaningful chunks that preserve context and are optimized for retrieval-augmented generation (RAG) systems.

Key principles:
1. Preserve semantic boundaries - don't break related information
2. Create self-contained chunks that make sense independently
3. Maintain logical flow and context
4. Identify and properly categorize different types of content
5. Ensure chunks are appropriately sized for embedding and retrieval
6. Extract key topics and provide meaningful titles/summaries

Always respond with valid JSON only.`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 4000
      });

      const result = response.choices[0]?.message?.content;
      if (!result) {
        throw new Error("No response from OpenAI");
      }

      // Parse the JSON response
      const aiResult: AIChunkingResult = JSON.parse(result);
      
      // Validate and clean the result
      return this.validateAndCleanAIResult(aiResult, strategy);
      
    } catch (error) {
      console.error("AI chunking failed:", error);
      // Fallback to simple chunking
      return this.createFallbackChunks(text, filename, strategy);
    }
  }

  private buildAIChunkingPrompt(text: string, filename: string, strategy: ChunkingStrategy): string {
    const isProductDoc = this.isProductDocument(text);
    
    return `
Analyze the following document and create intelligent chunks for a RAG system.

Document: "${filename}"
Content Length: ${text.length} characters
Strategy: ${strategy.name}
Max Chunk Size: ${strategy.maxChunkSize} characters
Min Chunk Size: ${strategy.minChunkSize} characters

Document Content:
"""
${text.length > 8000 ? text.substring(0, 8000) + '...[truncated]' : text}
"""

Instructions:
1. Analyze the document type and structure
2. Create 3-8 semantically meaningful chunks
3. Each chunk should be ${strategy.minChunkSize}-${strategy.maxChunkSize} characters
4. Ensure chunks are self-contained and contextually complete
5. Identify key topics, features, specifications, etc.
6. Provide meaningful titles and summaries for each chunk
7. Rate importance (1-10) based on information value

${isProductDoc ? `
This appears to be a product document. Pay special attention to:
- Product specifications and features
- Pricing and policy information
- Technical details and dimensions
- Use cases and target audience
- Benefits and advantages
` : ''}

Respond with JSON in this exact format:
{
  "documentType": "product" | "technical" | "general" | "manual",
  "documentSummary": "Brief summary of the entire document",
  "chunks": [
    {
      "content": "The actual chunk content (${strategy.minChunkSize}-${strategy.maxChunkSize} chars)",
      "title": "Descriptive title for this chunk",
      "summary": "Brief summary of what this chunk contains",
      "keyTopics": ["topic1", "topic2", "topic3"],
      "importance": 8,
      "chunkType": "introduction" | "specification" | "features" | "pricing" | "policies" | "technical" | "general"
    }
  ]
}`;
  }

  private validateAndCleanAIResult(result: AIChunkingResult, strategy: ChunkingStrategy): AIChunkingResult {
    // Ensure we have valid chunks
    if (!result.chunks || result.chunks.length === 0) {
      throw new Error("No chunks returned from AI");
    }

    // Filter and clean chunks
    const validChunks = result.chunks
      .filter(chunk => {
        const isValidLength = chunk.content.length >= strategy.minChunkSize / 2 && 
                             chunk.content.length <= strategy.maxChunkSize * 1.5;
        const hasContent = chunk.content.trim().length > 50;
        return isValidLength && hasContent;
      })
      .map(chunk => ({
        ...chunk,
        content: chunk.content.trim(),
        title: chunk.title || 'Untitled Section',
        summary: chunk.summary || 'No summary available',
        keyTopics: chunk.keyTopics || [],
        importance: Math.max(1, Math.min(10, chunk.importance || 5)),
        chunkType: chunk.chunkType || 'general' as const
      }));

    if (validChunks.length === 0) {
      throw new Error("No valid chunks after filtering");
    }

    return {
      ...result,
      chunks: validChunks,
      documentSummary: result.documentSummary || 'Document summary not available',
      documentType: result.documentType || 'general'
    };
  }

  private createFallbackChunks(text: string, filename: string, strategy: ChunkingStrategy): AIChunkingResult {
    console.log("Using fallback chunking method");
    
    // Simple but effective fallback
    const chunks = [];
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 20);
    
    let currentChunk = '';
    let chunkIndex = 0;
    
    for (const sentence of sentences) {
      const potentialChunk = currentChunk + (currentChunk ? ' ' : '') + sentence;
      
      if (potentialChunk.length > strategy.maxChunkSize && currentChunk.length > strategy.minChunkSize) {
        chunks.push({
          content: currentChunk.trim(),
          title: `Section ${chunkIndex + 1}`,
          summary: `Content from section ${chunkIndex + 1}`,
          keyTopics: this.extractSimpleTopics(currentChunk),
          importance: 5,
          chunkType: 'general' as const
        });
        
        currentChunk = sentence;
        chunkIndex++;
      } else {
        currentChunk = potentialChunk;
      }
    }
    
    // Add final chunk
    if (currentChunk.trim() && currentChunk.length > strategy.minChunkSize / 2) {
      chunks.push({
        content: currentChunk.trim(),
        title: `Section ${chunkIndex + 1}`,
        summary: `Content from section ${chunkIndex + 1}`,
        keyTopics: this.extractSimpleTopics(currentChunk),
        importance: 5,
        chunkType: 'general' as const
      });
    }

    return {
      documentType: 'general',
      documentSummary: 'Document processed with fallback method',
      chunks
    };
  }

  private extractSimpleTopics(text: string): string[] {
    // Simple topic extraction for fallback
    const words = text.toLowerCase().split(/\s+/);
    const importantWords = words.filter(word => 
      word.length > 4 && 
      !/^(the|and|for|with|that|this|from|they|have|been|were|would|could|should|will|can|may|might)$/.test(word)
    );
    
    // Get most frequent words as topics
    const wordCount = importantWords.reduce((acc, word) => {
      acc[word] = (acc[word] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    return Object.entries(wordCount)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([word]) => word);
  }

  private isProductDocument(text: string): boolean {
    const productIndicators = [
      'product name', 'product specification', 'mrp', 'price', 'sku',
      'features', 'benefits', 'material', 'dimensions', 'weight',
      'return policy', 'exchange policy', 'warranty', 'hsn',
      'technical specification', 'color', 'size', 'model',
      'use case', 'target audience', 'suitable for'
    ];
    
    const lowerText = text.toLowerCase();
    const matchCount = productIndicators.filter(indicator => 
      lowerText.includes(indicator)
    ).length;
    
    return matchCount >= 3;
  }

  private determineChunkingStrategy(filename: string, text: string): ChunkingStrategy {
    return this.isProductDocument(text) ? this.productDocStrategy : this.defaultStrategy;
  }

  // Keep the enhanced text extraction and cleaning methods
  private async extractText(buffer: Buffer, fileType: string): Promise<string> {
    switch (fileType.toLowerCase()) {
      case 'txt':
        return buffer.toString('utf-8');
      
      case 'pdf':
        try {
          return await this.extractPdfTextEnhanced(buffer);
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

  private async extractPdfTextEnhanced(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const pdfParser = new pdf2json();
      
      pdfParser.on("pdfParser_dataError", (errData: any) => {
        reject(new Error(`PDF parsing error: ${errData.parserError}`));
      });
      
      pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
        try {
          let text = '';
          let pageTexts: string[] = [];
          
          if (pdfData.Pages) {
            for (const page of pdfData.Pages) {
              let pageText = '';
              const textItems: Array<{x: number, y: number, text: string}> = [];
              
              if (page.Texts) {
                for (const textItem of page.Texts) {
                  if (textItem.R) {
                    for (const run of textItem.R) {
                      if (run.T) {
                        const decodedText = decodeURIComponent(run.T);
                        textItems.push({
                          x: textItem.x || 0,
                          y: textItem.y || 0,
                          text: decodedText
                        });
                      }
                    }
                  }
                }
                
                textItems.sort((a, b) => {
                  if (Math.abs(a.y - b.y) < 0.5) {
                    return a.x - b.x;
                  }
                  return a.y - b.y;
                });
                
                let currentY = -1;
                for (const item of textItems) {
                  if (currentY >= 0 && Math.abs(item.y - currentY) > 0.5) {
                    pageText += '\n';
                  } else if (pageText && !pageText.endsWith(' ') && !item.text.startsWith(' ')) {
                    pageText += ' ';
                  }
                  pageText += item.text;
                  currentY = item.y;
                }
              }
              
              pageTexts.push(pageText);
            }
          }
          
          text = pageTexts.join('\n\n');
          
          if (text.length < 50) {
            reject(new Error('PDF text extraction failed - document appears to be empty or corrupted'));
          } else {
            resolve(text);
          }
        } catch (parseError) {
          reject(new Error(`Failed to parse PDF content: ${(parseError as Error).message}`));
        }
      });
      
      pdfParser.parseBuffer(buffer);
    });
  }

  private cleanAndNormalizeText(text: string): string {
    let cleanedText = text;
    
    // Fix spaced-out characters (like "B a r e f o o t" -> "Barefoot")
    cleanedText = cleanedText.replace(/\b([A-Za-z])\s+(?=[A-Za-z]\s+[A-Za-z])/g, (match, letter) => {
      const words = match.split(/\s+/);
      if (words.length >= 3 && words.every(w => w.length === 1)) {
        return words.join('');
      }
      return match;
    });
    
    // More aggressive spaced character fixing
    cleanedText = cleanedText.replace(/\b([A-Za-z])\s+([A-Za-z])\s+([A-Za-z])/g, (match) => {
      const letters = match.replace(/\s+/g, '');
      if (letters.length <= 15) {
        return letters;
      }
      return match;
    });
    
    // Clean up excessive whitespace and fix common OCR errors
    cleanedText = cleanedText
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/([.!?])\s*([A-Z])/g, '$1 $2')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
    
    return cleanedText;
  }

  private validateTextQuality(text: string): boolean {
    if (text.length < 100) return false;
    
    const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
    const letterRatio = letterCount / text.length;
    
    if (letterRatio < 0.6) return false;
    
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const reasonableWords = words.filter(w => 
      w.length >= 2 && /[a-zA-Z]/.test(w)
    ).length;
    
    const wordQualityRatio = reasonableWords / words.length;
    return wordQualityRatio > 0.7;
  }

  async deleteDocumentFromVector(documentId: number): Promise<void> {
    await qdrantService.deleteByDocumentId(documentId);
  }
}

export const documentProcessor = new DocumentProcessor();