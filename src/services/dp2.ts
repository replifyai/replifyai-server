//@ts-nocheck
import { createEmbedding, extractDocumentMetadata } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";
import type { Document } from "../../shared/schema.js";
import mammoth from "mammoth";
import pdf2json from "pdf2json";
import OpenAI from "openai";
import fs from "fs";


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
      // if (!this.validateTextQuality(text)) {
      //   throw new Error("Extracted text quality is too poor for processing");
      // }
      
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
          productName: document.originalName,
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
            uploadTimestamp: Date.now(),
          },
        });
      }

      // Add to vector database
      // await qdrantService.addPoints(vectorChunks);
      fs.writeFileSync('vectorChunks.json', JSON.stringify(vectorChunks, null, 2));
      // Also store the vector chunks in a file for debugging (optional)
      console.log(`Processed ${vectorChunks.length} chunks with enhanced extraction`);
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
      
      console.log("Attempting AI chunking for document:", filename);
      
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert document analyzer and chunking specialist. Your task is to intelligently break down documents into semantically meaningful chunks that preserve context and are optimized for retrieval-augmented generation (RAG) systems.

CRITICAL REQUIREMENTS:
1. Capture ALL information - do not miss any pricing, measurements, specifications
2. Preserve semantic boundaries - don't break related information
3. Create self-contained chunks that make sense independently
4. Maintain logical flow and context
5. Identify and properly categorize different types of content
6. Ensure chunks are appropriately sized for embedding and retrieval
7. Extract key topics and provide meaningful titles/summaries
8. Pay special attention to numerical data, prices, and technical specifications

Always respond with valid JSON only. No information should be lost during chunking.`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.05,
        max_tokens: 6000
      });

      const result = response.choices[0]?.message?.content;
      if (!result) {
        throw new Error("No response from OpenAI");
      }

      console.log("Raw AI response received, length:", result.length);

      // Clean the JSON response (remove any markdown formatting)
      let cleanedResult = result.trim();
      if (cleanedResult.startsWith('```json')) {
        cleanedResult = cleanedResult.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResult.startsWith('```')) {
        cleanedResult = cleanedResult.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      // Parse the JSON response
      let aiResult: AIChunkingResult;
      try {
        aiResult = JSON.parse(cleanedResult);
        console.log("Successfully parsed AI response");
      } catch (parseError) {
        console.error("JSON parsing failed:", parseError);
        console.error("Raw response:", result);
        throw new Error(`Failed to parse AI response as JSON: ${(parseError as Error).message}`);
      }
      
      // Validate and clean the result
      const validatedResult = this.validateAndCleanAIResult(aiResult, strategy, text);
      console.log("AI chunking completed successfully with", validatedResult.chunks.length, "chunks");
      return validatedResult;
      
    } catch (error) {
      console.error("AI chunking failed for", filename, ":", error);
      console.log("Falling back to enhanced simple chunking");
      // Fallback to enhanced simple chunking
      return this.createEnhancedFallbackChunks(text, filename, strategy);
    }
  }

  private buildAIChunkingPrompt(text: string, filename: string, strategy: ChunkingStrategy): string {
    const isProductDoc = this.isProductDocument(text);
    
    // Extract key information patterns to ensure they're captured
    const keyInfoPatterns = this.extractKeyInformation(text);
    
    return `
Analyze the following document and create comprehensive, intelligent chunks for a RAG system.

Document: "${filename}"
Content Length: ${text.length} characters
Strategy: ${strategy.name}
Max Chunk Size: ${strategy.maxChunkSize} characters
Min Chunk Size: ${strategy.minChunkSize} characters

CRITICAL: You must capture ALL important information from the document. Do not miss any key details like pricing, specifications, measurements, policies, or technical details.

Key Information Detected:
${keyInfoPatterns.length > 0 ? keyInfoPatterns.map(info => `- ${info}`).join('\n') : '- No specific patterns detected'}

Document Content:
"""
${text}
"""

Instructions:
1. THOROUGHLY analyze the entire document - do not miss any information
2. Create 4-10 comprehensive chunks that capture ALL content
3. Each chunk should be ${strategy.minChunkSize}-${strategy.maxChunkSize} characters
4. Ensure NO information is lost - every important detail must be in a chunk
5. Pay special attention to numbers, prices, measurements, specifications
6. Group related information together logically
7. Provide meaningful titles and summaries for each chunk
8. Rate importance (1-10) based on information value

${isProductDoc ? `
This is a PRODUCT document. You MUST capture:
- ALL pricing information (MRP, discounts, offers, etc.)
- Complete product specifications and features
- Exact measurements and technical details
- Material and care instructions
- Warranty, return, and exchange policies
- Use cases and target audience
- Benefits and unique selling points
- Color variants and model information
- Any certifications or standards mentioned
` : `
For this document, ensure you capture:
- All numerical data and measurements
- Key processes and procedures
- Important policies and guidelines
- Technical specifications
- Any structured information (tables, lists)
`}

QUALITY CHECK: After creating chunks, verify that:
- All pricing/cost information is included
- All measurements and specifications are captured
- No important details are missing
- Content is logically grouped

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

  private validateAndCleanAIResult(result: AIChunkingResult, strategy: ChunkingStrategy, originalText: string): AIChunkingResult {
    // Ensure we have valid chunks
    if (!result.chunks || result.chunks.length === 0) {
      throw new Error("No chunks returned from AI");
    }

    // Extract key information from original text for validation
    const keyInfo = this.extractKeyInformation(originalText);
    
    // Filter and clean chunks
    const validChunks = result.chunks
      .filter(chunk => {
        const isValidLength = chunk.content.length >= strategy.minChunkSize / 3 && 
                             chunk.content.length <= strategy.maxChunkSize * 2;
        const hasContent = chunk.content.trim().length > 30;
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

    // Validate that critical information is captured
    const allChunkContent = validChunks.map(c => c.content).join(' ').toLowerCase();
    const missingCriticalInfo = this.findMissingCriticalInfo(originalText, allChunkContent, keyInfo);
    
    if (missingCriticalInfo.length > 0) {
      console.warn('Missing critical information detected:', missingCriticalInfo);
      
      // Try to add a supplementary chunk with missing info
      const missingInfoChunk = this.createSupplementaryChunk(originalText, missingCriticalInfo);
      if (missingInfoChunk) {
        validChunks.push(missingInfoChunk);
      }
    }

    return {
      ...result,
      chunks: validChunks,
      documentSummary: result.documentSummary || 'Document summary not available',
      documentType: result.documentType || 'general'
    };
  }

  private createFallbackChunks(text: string, filename: string, strategy: ChunkingStrategy): AIChunkingResult {
    console.log("Using basic fallback chunking method");
    
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

  private createEnhancedFallbackChunks(text: string, filename: string, strategy: ChunkingStrategy): AIChunkingResult {
    console.log("Using enhanced fallback chunking method");
    
    // Generate a proper document summary
    const documentSummary = this.generateDocumentSummary(text, filename);
    const documentType = this.determineDocumentType(text);
    
    // Extract key information for better chunking
    const keyInfo = this.extractKeyInformation(text);
    
    // Create chunks with better logic
    const chunks = [];
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 20);
    
    let currentChunk = '';
    let chunkIndex = 0;
    
    for (const sentence of sentences) {
      const potentialChunk = currentChunk + (currentChunk ? ' ' : '') + sentence;
      
      if (potentialChunk.length > strategy.maxChunkSize && currentChunk.length > strategy.minChunkSize) {
        const chunkTitle = this.generateChunkTitle(currentChunk, chunkIndex + 1);
        const chunkSummary = this.generateChunkSummary(currentChunk);
        const chunkType = this.determineChunkType(currentChunk);
        
        chunks.push({
          content: currentChunk.trim(),
          title: chunkTitle,
          summary: chunkSummary,
          keyTopics: this.extractSimpleTopics(currentChunk),
          importance: this.calculateChunkImportance(currentChunk, keyInfo),
          chunkType: chunkType
        });
        
        currentChunk = sentence;
        chunkIndex++;
      } else {
        currentChunk = potentialChunk;
      }
    }
    
    // Add final chunk
    if (currentChunk.trim() && currentChunk.length > strategy.minChunkSize / 2) {
      const chunkTitle = this.generateChunkTitle(currentChunk, chunkIndex + 1);
      const chunkSummary = this.generateChunkSummary(currentChunk);
      const chunkType = this.determineChunkType(currentChunk);
      
      chunks.push({
        content: currentChunk.trim(),
        title: chunkTitle,
        summary: chunkSummary,
        keyTopics: this.extractSimpleTopics(currentChunk),
        importance: this.calculateChunkImportance(currentChunk, keyInfo),
        chunkType: chunkType
      });
    }

    return {
      documentType,
      documentSummary,
      chunks
    };
  }

  private extractKeyInformation(text: string): string[] {
    const keyInfo: string[] = [];
    const lowerText = text.toLowerCase();
    
    // Pricing patterns - much more specific to avoid false matches
    const pricePatterns = [
      // Pattern 1: "price: 1899" or "cost: Rs 1899"
      /(?:price|cost|mrp|rate|amount|fee|charge)[\s:]+(?:rs\.?|₹|inr|usd|\$)?\s*(\d{3,6}(?:,\d{3})*(?:\.\d{2})?)/gi,
      // Pattern 2: "₹1899" or "Rs 1899" or "Rs. 1899"
      /(?:₹|rs\.?\s+)(\d{3,6}(?:,\d{3})*(?:\.\d{2})?)/gi,
      // Pattern 3: "1899 rupees" or "1899 only" 
      /(\d{3,6}(?:,\d{3})*(?:\.\d{2})?)\s*(?:rupees?|dollars?|only)/gi,
      // Pattern 4: In pricing sections, look for standalone numbers
      /(?:pricing|price|cost)[\s\S]{0,100}?(\d{3,6})/gi,
      // Pattern 5: Product name followed by dash and number (like "Cushion - 1899")
      /(?:cushion|product)[\s\-]+(\d{3,6})/gi
    ];
    
    for (const pattern of pricePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          // Extract the actual number from the match
          const numberMatch = match.match(/\d{3,6}(?:,\d{3})*/);
          if (numberMatch) {
            keyInfo.push(`Pricing found: ${numberMatch[0]}`);
          } else {
            keyInfo.push(`Pricing found: ${match.trim()}`);
          }
        });
      }
    }
    
    // Measurement patterns
    const measurementPatterns = [
      /(\d+(?:\.\d+)?)\s*(?:cm|mm|inch|inches|centimeters|millimeters|feet|ft)/gi,
      /(\d+(?:\.\d+)?)\s*(?:kg|grams?|g|pounds?|lbs?|oz)/gi,
      /dimensions?[\s:]*(\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)*)/gi,
      /size[\s:]*(\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)*)/gi,
      /weight[\s:]*(\d+(?:\.\d+)?)/gi
    ];
    
    for (const pattern of measurementPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          keyInfo.push(`Measurement found: ${match.trim()}`);
        });
      }
    }
    
    // Model/SKU patterns
    const modelPatterns = [
      /(?:model|sku|product\s+code|item\s+code)[\s:]*([A-Z0-9-]+)/gi,
      /\b([A-Z]{2,}-[A-Z0-9-]{3,})\b/g
    ];
    
    for (const pattern of modelPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          keyInfo.push(`Model/SKU found: ${match.trim()}`);
        });
      }
    }
    
    // Warranty/Policy patterns
    const policyPatterns = [
      /(?:warranty|guarantee)[\s:]*(\d+\s*(?:year|month|day)s?)/gi,
      /(?:return|exchange|refund)\s+policy/gi,
      /\b(\d+)\s*(?:year|month|day)s?\s+(?:warranty|guarantee)/gi
    ];
    
    for (const pattern of policyPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          keyInfo.push(`Policy found: ${match.trim()}`);
        });
      }
    }
    
    // Color/Variant patterns
    const colorPatterns = [
      /(?:color|colour|variant)s?[\s:]*([a-z\s,]+)/gi,
      /(?:available\s+in)[\s:]*([a-z\s,]+)/gi
    ];
    
    for (const pattern of colorPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          if (match.length < 100) { // Avoid capturing too much
            keyInfo.push(`Variant found: ${match.trim()}`);
          }
        });
      }
    }
    
    // Technical specifications
    const techPatterns = [
      /(?:material|fabric|made\s+(?:of|from))[\s:]*([a-z\s,]+)/gi,
      /(?:power|voltage|frequency)[\s:]*(\d+(?:\.\d+)?)\s*(?:w|watts?|v|volts?|hz|hertz)/gi,
      /(?:capacity|volume)[\s:]*(\d+(?:\.\d+)?)\s*(?:l|liters?|ml|gallons?)/gi
    ];
    
    for (const pattern of techPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          if (match.length < 100) { // Avoid capturing too much
            keyInfo.push(`Technical spec found: ${match.trim()}`);
          }
        });
      }
    }
    
    return [...new Set(keyInfo)]; // Remove duplicates
  }

  private findMissingCriticalInfo(originalText: string, chunkContent: string, keyInfo: string[]): string[] {
    const missing: string[] = [];
    
    // Check if pricing information is missing
    const pricingInfo = keyInfo.filter(info => info.includes('Pricing found'));
    if (pricingInfo.length > 0) {
      const hasPricing = pricingInfo.some(info => {
        const priceMatch = info.match(/\d+/);
        return priceMatch && chunkContent.includes(priceMatch[0]);
      });
      
      if (!hasPricing) {
        missing.push('pricing information');
      }
    }
    
    // Check for specific important numbers that might be missing
    const importantNumbers = originalText.match(/\b\d{3,5}\b/g) || [];
    const missingNumbers = importantNumbers.filter(num => 
      !chunkContent.includes(num) && 
      parseInt(num) > 99 // Focus on significant numbers
    );
    
    if (missingNumbers.length > 0) {
      missing.push(`important numbers: ${missingNumbers.slice(0, 3).join(', ')}`);
    }
    
    // Check for measurement information
    const measurementInfo = keyInfo.filter(info => info.includes('Measurement found'));
    if (measurementInfo.length > 0) {
      const hasMeasurements = measurementInfo.some(info => {
        const measurement = info.replace('Measurement found: ', '');
        return chunkContent.includes(measurement.toLowerCase());
      });
      
      if (!hasMeasurements) {
        missing.push('measurement specifications');
      }
    }
    
    // Check for model/SKU information
    const modelInfo = keyInfo.filter(info => info.includes('Model/SKU found'));
    if (modelInfo.length > 0) {
      const hasModel = modelInfo.some(info => {
        const model = info.replace('Model/SKU found: ', '');
        return chunkContent.includes(model.toLowerCase());
      });
      
      if (!hasModel) {
        missing.push('model/SKU information');
      }
    }
    
    return missing;
  }

  private createSupplementaryChunk(originalText: string, missingInfo: string[]): any | null {
    if (missingInfo.length === 0) return null;
    
    // Extract relevant sections that contain the missing information
    const relevantSections: string[] = [];
    
    // Look for pricing sections
    if (missingInfo.some(info => info.includes('pricing'))) {
      const pricingSections = this.extractSectionsWithPattern(originalText, [
        /pricing[\s\S]{0,200}/gi,
        /price[\s\S]{0,100}/gi,
        /\b\d{3,5}\b[\s\S]{0,50}/g,
        /₹[\s\S]{0,50}/g,
        /rs\.?[\s\S]{0,50}/gi
      ]);
      relevantSections.push(...pricingSections);
    }
    
    // Look for measurement sections
    if (missingInfo.some(info => info.includes('measurement'))) {
      const measurementSections = this.extractSectionsWithPattern(originalText, [
        /dimensions?[\s\S]{0,200}/gi,
        /size[\s\S]{0,100}/gi,
        /weight[\s\S]{0,100}/gi,
        /\d+\s*(?:cm|mm|kg|g|inch)[\s\S]{0,100}/gi
      ]);
      relevantSections.push(...measurementSections);
    }
    
    // Look for important numbers
    if (missingInfo.some(info => info.includes('numbers'))) {
      const numberSections = this.extractSectionsWithPattern(originalText, [
        /\b\d{3,5}\b[\s\S]{0,100}/g
      ]);
      relevantSections.push(...numberSections);
    }
    
    if (relevantSections.length === 0) return null;
    
    const supplementaryContent = [...new Set(relevantSections)]
      .join(' ')
      .trim()
      .substring(0, 800); // Limit length
    
    if (supplementaryContent.length < 50) return null;
    
    return {
      content: supplementaryContent,
      title: 'Additional Important Information',
      summary: `Contains missing critical information: ${missingInfo.join(', ')}`,
      keyTopics: ['supplementary', 'critical-info'],
      importance: 9,
      chunkType: 'technical' as const
    };
  }

  private extractSectionsWithPattern(text: string, patterns: RegExp[]): string[] {
    const sections: string[] = [];
    
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        sections.push(...matches.map(match => match.trim()));
      }
    }
    
    return sections.filter(section => section.length > 20);
  }

  private generateDocumentSummary(text: string, filename: string): string {
    // Extract first few sentences for a basic summary
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
    const firstSentences = sentences.slice(0, 3).join('.').trim();
    
    // Identify document type and key information
    const isProduct = this.isProductDocument(text);
    const keyInfo = this.extractKeyInformation(text);
    
    if (isProduct) {
      const productName = this.extractProductName(text, filename);
      const features = keyInfo.filter(info => info.includes('feature')).length;
      const hasPricing = keyInfo.some(info => info.includes('Pricing'));
      
      let summary = `Product documentation for ${productName}. `;
      if (hasPricing) summary += "Includes pricing information. ";
      if (features > 0) summary += `Contains ${features} feature details. `;
      summary += firstSentences.length > 50 ? firstSentences.substring(0, 150) + "..." : firstSentences;
      
      return summary;
    } else {
      return `Document "${filename}" containing ${Math.ceil(text.length / 1000)}k characters. ${firstSentences.substring(0, 200)}${firstSentences.length > 200 ? '...' : ''}`;
    }
  }

  private determineDocumentType(text: string): string {
    if (this.isProductDocument(text)) return 'product';
    
    const lowerText = text.toLowerCase();
    if (lowerText.includes('manual') || lowerText.includes('instruction')) return 'manual';
    if (lowerText.includes('technical') || lowerText.includes('specification')) return 'technical';
    
    return 'general';
  }

  private extractProductName(text: string, filename: string): string {
    // Try to extract product name from text
    const productMatches = text.match(/(?:product\s+name|product)[\s:]*([A-Za-z0-9\s-]+)/i);
    if (productMatches && productMatches[1]) {
      return productMatches[1].trim().substring(0, 50);
    }
    
    // Extract from filename
    const nameFromFile = filename.replace(/\.(pdf|docx?|txt)$/i, '').replace(/[-_]/g, ' ');
    return nameFromFile.substring(0, 50);
  }

  private generateChunkTitle(content: string, index: number): string {
    const lowerContent = content.toLowerCase();
    
    // Check for specific content types
    if (lowerContent.includes('price') || lowerContent.includes('cost') || lowerContent.includes('₹')) {
      return 'Pricing Information';
    }
    if (lowerContent.includes('dimension') || lowerContent.includes('size') || lowerContent.includes('weight')) {
      return 'Product Specifications';
    }
    if (lowerContent.includes('feature') || lowerContent.includes('benefit')) {
      return 'Features & Benefits';
    }
    if (lowerContent.includes('material') || lowerContent.includes('fabric')) {
      return 'Material & Construction';
    }
    if (lowerContent.includes('warranty') || lowerContent.includes('return') || lowerContent.includes('policy')) {
      return 'Policies & Warranty';
    }
    if (lowerContent.includes('use case') || lowerContent.includes('suitable')) {
      return 'Usage & Applications';
    }
    
    // Extract first meaningful phrase as title
    const sentences = content.split(/[.!?]+/);
    if (sentences.length > 0) {
      const firstSentence = sentences[0].trim();
      if (firstSentence.length > 10 && firstSentence.length < 80) {
        return firstSentence;
      }
    }
    
    return `Section ${index}`;
  }

  private generateChunkSummary(content: string): string {
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length === 0) return 'Content summary not available';
    
    const firstSentence = sentences[0].trim();
    const summary = firstSentence.length > 100 ? 
      firstSentence.substring(0, 97) + '...' : 
      firstSentence;
      
    return summary || 'Content summary not available';
  }

  private determineChunkType(content: string): 'introduction' | 'specification' | 'features' | 'pricing' | 'policies' | 'technical' | 'general' {
    const lowerContent = content.toLowerCase();
    
    if (lowerContent.includes('price') || lowerContent.includes('cost') || lowerContent.includes('₹') || lowerContent.includes('mrp')) {
      return 'pricing';
    }
    if (lowerContent.includes('dimension') || lowerContent.includes('specification') || lowerContent.includes('technical')) {
      return 'specification';
    }
    if (lowerContent.includes('feature') || lowerContent.includes('benefit') || lowerContent.includes('advantage')) {
      return 'features';
    }
    if (lowerContent.includes('warranty') || lowerContent.includes('return') || lowerContent.includes('policy') || lowerContent.includes('exchange')) {
      return 'policies';
    }
    if (lowerContent.includes('material') || lowerContent.includes('technical') || lowerContent.includes('construction')) {
      return 'technical';
    }
    
    return 'general';
  }

  private calculateChunkImportance(content: string, keyInfo: string[]): number {
    let importance = 5; // Base importance
    
    const lowerContent = content.toLowerCase();
    
    // Boost importance for pricing information
    if (lowerContent.includes('price') || lowerContent.includes('₹') || lowerContent.includes('cost')) {
      importance += 3;
    }
    
    // Boost for specifications
    if (lowerContent.includes('dimension') || lowerContent.includes('weight') || lowerContent.includes('size')) {
      importance += 2;
    }
    
    // Boost for features
    if (lowerContent.includes('feature') || lowerContent.includes('benefit')) {
      importance += 1;
    }
    
    // Check if content contains any detected key information
    const hasKeyInfo = keyInfo.some(info => {
      const infoText = info.toLowerCase().replace(/^[^:]*:\s*/, '');
      return lowerContent.includes(infoText);
    });
    
    if (hasKeyInfo) {
      importance += 2;
    }
    
    return Math.min(10, importance);
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
      'use case', 'target audience', 'suitable for', 'product description',
      'variants', 'pricing', 'cost', 'amount', 'care instructions',
      'fabric type', 'item weight', 'item dimensions', 'cushion',
      'seat cushion', 'ergonomic', 'memory foam', 'comfort'
    ];
    
    const lowerText = text.toLowerCase();
    const matchCount = productIndicators.filter(indicator => 
      lowerText.includes(indicator)
    ).length;
    
    // Also check for pricing patterns as strong indicators
    const hasPricing = /\b\d{3,5}\b/.test(text) && /(?:price|cost|mrp|₹|rs)/i.test(text);
    
    // Check for measurement patterns
    const hasMeasurements = /\d+(?:\.\d+)?\s*(?:cm|mm|kg|g|inch|inches|centimeters)/i.test(text);
    
    return matchCount >= 3 || hasPricing || hasMeasurements;
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
    
    // Fix spaced-out pricing numbers (like "1 8 99" -> "1899")
    cleanedText = cleanedText.replace(/\b(\d)\s+(\d)\s+(\d+)\b/g, '$1$2$3');
    cleanedText = cleanedText.replace(/\b(\d)\s+(\d+)\b/g, '$1$2');
    
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