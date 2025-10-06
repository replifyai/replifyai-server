import { createEmbedding } from "./embeddingService.js";
import { extractDocumentMetadata } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";
import { storage } from "../storage.js";
import type { Document } from "../../shared/schema.js";
import mammoth from "mammoth";
import pdf2json from "pdf2json";
import OpenAI from "openai";


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface ExtractedLink {
  url: string;
  text?: string;
  type: 'link' | 'image' | 'email' | 'phone';
  position?: { page?: number; x?: number; y?: number };
}

export interface ExtractedContent {
  text: string;
  links: ExtractedLink[];
}

export interface ProcessedChunk {
  content: string;
  chunkIndex: number;
  metadata?: any;
  qualityScore?: number;
  links?: ExtractedLink[];
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
      const extractedContent = await this.extractText(fileBuffer, document.fileType);
      
      // Clean and normalize the extracted text
      const text = this.cleanAndNormalizeText(extractedContent.text);
      
      console.log(`Extracted text length: ${text.length} characters (cleaned from ${extractedContent.text.length})`);
      console.log(`Extracted ${extractedContent.links.length} links from document`);
      
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
      const processedChunks = aiChunkingResult.chunks.map((aiChunk, index) => {
        // Find links that are relevant to this chunk
        const chunkLinks = this.findRelevantLinks(aiChunk.content, extractedContent.links, text);
        
        return {
          content: aiChunk.content,
          chunkIndex: index,
          qualityScore: Math.min(aiChunk.importance / 10, 1), // Convert importance to quality score
          links: chunkLinks,
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
            uploadType: (document.metadata as any)?.uploadType || 'file',
            // Include all document links for reference
            documentLinks: extractedContent.links
          }
        };
      });
      console.log("🚀 ~ DocumentProcessor ~ processedChunks ~ processedChunks:", JSON.stringify(processedChunks, null, 2));

      console.log(`Created ${processedChunks.length} AI-powered chunks`);

      // Process each chunk
      const vectorChunks = [];
      for (let i = 0; i < processedChunks.length; i++) {
        const chunk = processedChunks[i];
        
        // Create embedding
        const embedding = await createEmbedding(chunk.content);
        
        // Generate enhanced metadata for robust retrieval
        const semanticTitle = this.generateSemanticTitle(chunk.content, chunk.metadata);
        const keywords = this.extractRobustKeywords(chunk.content, chunk.metadata);
        const documentSection = this.generateDocumentSection(chunk, processedChunks, i);
        
        // Enhanced metadata for the chunk
        const enhancedMetadata = {
          ...chunk.metadata,
          // Semantic metadata
          semanticTitle,
          keywords,
          
          // Document section hierarchy for context stitching
          documentSection,
          
          // Chunk references for navigation
          chunkReference: `${document.id}_${chunk.chunkIndex}`,
          previousChunk: i > 0 ? `${document.id}_${i - 1}` : null,
          nextChunk: i < processedChunks.length - 1 ? `${document.id}_${i + 1}` : null,
          
          // Temporal metadata
          uploadTimestamp: Date.now(),
          
          // Search optimization
          searchableText: this.generateSearchableText(chunk.content, chunk.metadata),
          keywordDensity: this.calculateKeywordDensity(chunk.content, keywords),
          
          // Links and media
          links: chunk.links || [],
          linkCount: chunk.links ? chunk.links.length : 0,
          imageLinks: chunk.links ? chunk.links.filter(link => link.type === 'image') : [],
          externalLinks: chunk.links ? chunk.links.filter(link => link.type === 'link') : [],
        };
        
        // Store chunk in database with enhanced metadata
        const savedChunk = await storage.createChunk({
          documentId: document.id,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          embedding,
          metadata: enhancedMetadata,
        });

        vectorChunks.push({
          id: savedChunk.id,
          vector: embedding,
          payload: {
            documentId: document.id,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            filename: document.originalName,
            semanticTitle,
            keywords,
            metadata: enhancedMetadata,
            uploadTimestamp: Date.now(),
            originalChunkId: savedChunk.id,
            chunkReference: `${document.id}_${chunk.chunkIndex}`,
            // Include links in the payload for RAG retrieval
            links: chunk.links || [],
            imageLinks: chunk.links ? chunk.links.filter(link => link.type === 'image') : [],
            externalLinks: chunk.links ? chunk.links.filter(link => link.type === 'link') : [],
          },
        });
      }

      // Add to vector database
      await qdrantService.addPoints(vectorChunks);
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
        model: "gpt-4o",
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
    // Analyze document structure and content
    const analysis = this.analyzeTextStructure(text);
    const isProductDoc = this.isProductDocument(text);
    const keyInfoPatterns = this.extractKeyInformation(text);
  
    // Build adaptive instructions based on document analysis
    const adaptiveInstructions = this.buildAdaptiveInstructions(analysis, isProductDoc, keyInfoPatterns);
  
    return `
  Analyze the entire document and divide it into logically grouped, information-rich chunks suitable for a RAG system.  
  **Every chunk must maximize recall and precision for semantic search.**  
  Do not miss, repeat, or fragment important details.
  
  Document: "${filename}"  
  Content Length: ${text.length} characters  
  Chunking Strategy: ${strategy.name}  
  Document Structure: ${analysis.documentStructure}  
  Max Chunk Size: ${strategy.maxChunkSize} characters  
  Min Chunk Size: ${strategy.minChunkSize} characters  
  
  CRITICAL REQUIREMENTS:
  - Capture EVERY important fact, number, price, specification, measurement, and policy—**no losses**
  - Group closely-related information into a single chunk when possible (avoid single-line or sparse chunks)
  - Merge very small, related sections to avoid information being split across multiple, sparse chunks
  - Add **references/tags** in the metadata if information is closely linked to another chunk (optional: 'relatedChunks' field)
  - Avoid redundancy between chunks—each detail should appear in only one chunk unless absolutely necessary for context
  - Assign MEANINGFUL, user-intent focused titles and clear, concise summaries to each chunk
  - Assign importance (1-10) reflecting the value and retrieval relevance of chunk information
  
  ADDITIONAL ENRICHMENTS:
  - Include a 'keyTopics' array and a 'chunkType' field for each chunk as metadata
  - If applicable, add a 'lastUpdated' timestamp and any relevant advanced metadata structure (e.g., tags, entities)
  - Each chunk should have unique and clear key topics for precise filtering
  - For product docs, explicitly identify and organize chunks for: variants, sizes, colors, pricing, features, use cases, care/policy, specs, and benefits
  
  QUALITY ASSURANCE:
  - Every numerical value, technical measurement, or specification is present and correct
  - No key information is omitted, repeated unnecessarily, or split across single-line chunks
  - All content is grouped logically by function or topic, never arbitrarily
  - No duplicate or overlapping information between chunks (except where context requires)
  
  Respond in the following strict JSON format:
  
  {
    "documentType": "product" | "invoice" | "manual" | "technical" | "general",
    "documentSummary": "Brief but complete summary (max 2 lines) of the entire document",
    "chunks": [
      {
        "content": "Chunk content (${strategy.minChunkSize}-${strategy.maxChunkSize} chars), covering a related set of information in detail",
        "title": "Clear, specific title for this chunk",
        "summary": "2-3 sentences summarizing what the chunk includes",
        "keyTopics": ["primary topic", "secondary topic", ...],
        "importance": 1-10,
        "chunkType": "introduction" | "specification" | "features" | "pricing" | "policies" | "use_cases" | "benefits" | "technical" | "general",
        "lastUpdated": "YYYY-MM-DD", // optional
        "relatedChunks": [chunkIndex1, chunkIndex2] // optional
      }
    ]
  }
  
  Document Analysis:
  ${analysis.likelyOCRIssues ? '- Possible OCR issues—check for garbled text' : '- Text is clean'}
  ${keyInfoPatterns.length > 0 ? `- Key patterns found:\n${keyInfoPatterns.map(info => `  • ${info}`).join('\n')}` : '- No specific patterns detected'}
  
  Document Content:
  """
  ${text}
  """
  
  ${adaptiveInstructions}
  `;
  }

  private buildAdaptiveInstructions(analysis: any, isProductDoc: boolean, keyInfo: string[]): string {
    let instructions = '';
    
    if (isProductDoc) {
      instructions += `
PRODUCT DOCUMENT - You MUST capture:
- ALL pricing information (MRP, discounts, offers, costs, fees)
- Complete product specifications and features
- Exact measurements and technical details
- Material composition and construction details
- Warranty, return, and exchange policies
- Use cases and target applications
- Benefits and unique selling points
- Color variants and model information
- Any certifications or standards mentioned
- Brand and manufacturer information`;
    } else if (analysis.documentStructure === 'invoice') {
      instructions += `
INVOICE/BILLING DOCUMENT - You MUST capture:
- All line items with quantities and prices
- Subtotals, taxes, and grand totals
- Payment terms and due dates
- Billing and shipping addresses
- Invoice numbers and dates
- Vendor/customer information
- Discount and promotion details`;
    } else if (analysis.documentStructure === 'manual') {
      instructions += `
MANUAL/INSTRUCTION DOCUMENT - You MUST capture:
- Step-by-step procedures and instructions
- Safety warnings and precautions
- Technical specifications and requirements
- Troubleshooting information
- Parts lists and diagrams references
- Contact information for support`;
    } else {
      instructions += `
GENERAL DOCUMENT - Ensure you capture:
- All numerical data and measurements
- Key processes and procedures
- Important policies and guidelines
- Technical specifications
- Contact information and references
- Any structured information (tables, lists)
- Dates and deadlines`;
    }
    
    // Add specific instructions based on detected patterns
    if (keyInfo.some(info => info.includes('Pricing'))) {
      instructions += `
- SPECIAL ATTENTION: Pricing information detected - ensure all prices are captured accurately`;
    }
    
    if (keyInfo.some(info => info.includes('Measurement'))) {
      instructions += `
- SPECIAL ATTENTION: Measurements detected - capture all dimensions, weights, and specifications`;
    }
    
    if (analysis.likelyOCRIssues) {
      instructions += `
- NOTE: Text may have OCR spacing issues - interpret spaced numbers correctly`;
    }
    
    return instructions;
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
    
    // Use adaptive extraction based on document analysis
    const analysis = this.analyzeTextStructure(text);
    
    // Extract pricing information adaptively
    const pricingInfo = this.extractPricingInformation(text, analysis);
    keyInfo.push(...pricingInfo);
    
    // Extract measurements adaptively
    const measurementInfo = this.extractMeasurementInformation(text);
    keyInfo.push(...measurementInfo);
    
    // Extract model/product codes
    const modelInfo = this.extractModelInformation(text);
    keyInfo.push(...modelInfo);
    
    // Extract other key information
    const otherInfo = this.extractOtherKeyInformation(text);
    keyInfo.push(...otherInfo);
    
    return [...new Set(keyInfo)]; // Remove duplicates
  }

  private extractPricingInformation(text: string, analysis: any): string[] {
    const pricingInfo: string[] = [];
    
    // Universal pricing patterns that work across different formats
    const universalPatterns = [
      // Currency symbols followed by numbers
      /(?:₹|rs\.?|inr|usd|\$|€|£)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{2})?)/gi,
      // Price/cost keywords followed by numbers
      /(?:price|cost|mrp|rate|amount|fee|charge|total)[\s:=\-]*(?:₹|rs\.?|\$)?\s*(\d{2,6}(?:,\d{3})*(?:\.\d{2})?)/gi,
      // Numbers followed by currency words
      /(\d{2,6}(?:,\d{3})*(?:\.\d{2})?)\s*(?:rupees?|dollars?|euros?|pounds?|only|each)/gi,
      // In pricing/cost sections, find significant numbers
      /(?:pricing|cost|price|charges?)[\s\S]{0,150}?(\d{2,6}(?:,\d{3})*)/gi
    ];

    // Document-specific patterns based on structure
    if (analysis.documentStructure === 'product') {
      universalPatterns.push(
        // Product name - price patterns
        /(?:^|\n)[^\n]*(?:product|item|model)[\s\S]{0,100}?(\d{3,6})/gi,
        // Table-like structures with prices
        /(?:^|\n)[^\n]*[\-\s]+(\d{3,6})[\s]*(?:\n|$)/gi
      );
    } else if (analysis.documentStructure === 'invoice') {
      universalPatterns.push(
        // Invoice total patterns
        /(?:total|subtotal|grand total|amount due)[\s:=\-]*(\d{2,6}(?:,\d{3})*(?:\.\d{2})?)/gi,
        // Line item patterns
        /(?:^|\n)[^\n]*\s+(\d{1,6}(?:,\d{3})*(?:\.\d{2})?)\s*(?:\n|$)/gi
      );
    }

    for (const pattern of universalPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          // Extract the actual number from the match
          const numberMatch = match.match(/\d{1,6}(?:,\d{3})*(?:\.\d{2})?/);
          if (numberMatch) {
            const number = numberMatch[0];
            // Filter out obviously wrong numbers (like phone numbers, years, etc.)
            if (this.isLikelyPriceNumber(number, match)) {
              pricingInfo.push(`Pricing found: ${number}`);
            }
          }
        });
      }
    }

    return pricingInfo;
  }

  private isLikelyPriceNumber(number: string, context: string): boolean {
    const numValue = parseFloat(number.replace(/,/g, ''));
    const lowerContext = context.toLowerCase();
    
    // Too small to be a meaningful price (unless it's cents)
    if (numValue < 1 && !lowerContext.includes('cent')) return false;
    
    // Too large to be a reasonable price
    if (numValue > 10000000) return false;
    
    // Looks like a year
    if (numValue >= 1900 && numValue <= 2030 && number.length === 4) return false;
    
    // Looks like a phone number
    if (number.length >= 10 && /^\d+$/.test(number.replace(/[,\s]/g, ''))) return false;
    
    // Has good pricing context
    if (lowerContext.includes('price') || lowerContext.includes('cost') || 
        lowerContext.includes('₹') || lowerContext.includes('rs') ||
        lowerContext.includes('$') || lowerContext.includes('total')) {
      return true;
    }
    
    // Reasonable price range
    return numValue >= 10 && numValue <= 1000000;
  }

  private extractMeasurementInformation(text: string): string[] {
    const measurementInfo: string[] = [];
    
    const measurementPatterns = [
      // Physical dimensions
      /(\d+(?:\.\d+)?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*(?:x|×)?\s*(\d+(?:\.\d+)?)?\s*(?:cm|mm|m|inch|in|ft|feet)/gi,
      /(?:dimensions?|size|length|width|height)[\s:=\-]*(\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)*)\s*(?:cm|mm|m|inch|in|ft|feet)/gi,
      // Weight measurements
      /(?:weight|mass)[\s:=\-]*(\d+(?:\.\d+)?)\s*(?:kg|g|grams?|pounds?|lbs?|oz)/gi,
      /(\d+(?:\.\d+)?)\s*(?:kg|g|grams?|pounds?|lbs?|oz)/gi,
      // Volume/capacity
      /(?:capacity|volume)[\s:=\-]*(\d+(?:\.\d+)?)\s*(?:l|liters?|ml|gallons?|cups?)/gi,
      // Power/electrical
      /(\d+(?:\.\d+)?)\s*(?:w|watts?|v|volts?|a|amps?|hz|hertz)/gi
    ];
    
    for (const pattern of measurementPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          measurementInfo.push(`Measurement found: ${match.trim()}`);
        });
      }
    }
    
    return measurementInfo;
  }

  private extractModelInformation(text: string): string[] {
    const modelInfo: string[] = [];
    
    const modelPatterns = [
      // Model numbers/codes
      /(?:model|sku|part\s+(?:no|number)|item\s+(?:no|number)|product\s+code)[\s:=\-]*([A-Z0-9\-_]{3,20})/gi,
      // General alphanumeric codes
      /\b([A-Z]{2,}-[A-Z0-9\-]{3,})\b/g,
      /\b([A-Z]{3,}\d{2,})\b/g
    ];
    
    for (const pattern of modelPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          modelInfo.push(`Model/SKU found: ${match.trim()}`);
        });
      }
    }
    
    return modelInfo;
  }

  private extractOtherKeyInformation(text: string): string[] {
    const otherInfo: string[] = [];
    
    // Warranty/policy information
    const policyPatterns = [
      /(?:warranty|guarantee)[\s:=\-]*(\d+\s*(?:year|month|day)s?)/gi,
      /(?:return|exchange|refund)\s+policy/gi
    ];
    
    // Material information
    const materialPatterns = [
      /(?:material|made\s+(?:of|from)|fabric)[\s:=\-]*([a-z\s,]{5,50})/gi
    ];
    
    // Color/variant information
    const variantPatterns = [
      /(?:color|colour|variant|available\s+in)s?[\s:=\-]*([a-z\s,]{5,100})/gi
    ];
    
    const allPatterns = [...policyPatterns, ...materialPatterns, ...variantPatterns];
    
    for (const pattern of allPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          if (match.length < 150) { // Avoid capturing too much
            otherInfo.push(`Additional info found: ${match.trim()}`);
          }
        });
      }
    }
    
    return otherInfo;
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
    const lowerText = text.toLowerCase();
    let score = 0;
    
    // Universal product indicators (work across different formats)
    const universalIndicators = [
      { keywords: ['product', 'item'], weight: 2 },
      { keywords: ['price', 'cost', 'mrp'], weight: 3 },
      { keywords: ['features', 'specifications', 'specs'], weight: 2 },
      { keywords: ['dimensions', 'weight', 'size'], weight: 2 },
      { keywords: ['material', 'fabric', 'construction'], weight: 1 },
      { keywords: ['warranty', 'guarantee'], weight: 1 },
      { keywords: ['model', 'sku', 'part number'], weight: 2 },
      { keywords: ['benefits', 'advantages'], weight: 1 },
      { keywords: ['color', 'colour', 'variant'], weight: 1 },
      { keywords: ['brand', 'manufacturer'], weight: 1 }
    ];
    
    // Check for universal indicators
    universalIndicators.forEach(indicator => {
      if (indicator.keywords.some(keyword => lowerText.includes(keyword))) {
        score += indicator.weight;
      }
    });
    
    // Check for pricing patterns (strong indicator)
    const hasPricing = this.detectPricingPatterns(text);
    if (hasPricing) score += 4;
    
    // Check for measurement patterns (strong indicator)
    const hasMeasurements = this.detectMeasurementPatterns(text);
    if (hasMeasurements) score += 3;
    
    // Check for product catalog structure (tables, lists)
    const hasProductStructure = this.detectProductStructure(text);
    if (hasProductStructure) score += 2;
    
    // Document is likely a product document if score >= 5
    return score >= 5;
  }

  private detectPricingPatterns(text: string): boolean {
    const pricingPatterns = [
      /(?:₹|rs\.?|inr|usd|\$|€|£)\s*\d+/gi,
      /(?:price|cost|mrp|total|amount)[\s:=\-]*\d+/gi,
      /\d+\s*(?:rupees?|dollars?|only)/gi
    ];
    
    return pricingPatterns.some(pattern => pattern.test(text));
  }

  private detectMeasurementPatterns(text: string): boolean {
    const measurementPatterns = [
      /\d+(?:\.\d+)?\s*(?:cm|mm|m|inch|in|ft|feet|kg|g|lbs?|oz)/gi,
      /(?:dimensions?|size|weight|length|width|height)[\s:=\-]*\d+/gi,
      /\d+\s*[x×]\s*\d+/gi
    ];
    
    return measurementPatterns.some(pattern => pattern.test(text));
  }

  private detectProductStructure(text: string): boolean {
    // Check for table-like structures or product listings
    const structurePatterns = [
      /(?:^|\n)\s*(?:product|item|model)[\s\S]{0,100}?(?:\d+|₹|rs)/gim,
      /(?:^|\n)[^\n]*[\-\|]+[^\n]*\d+/gim,
      /(?:variants?|models?|options?)[\s:]/gi
    ];
    
    return structurePatterns.some(pattern => pattern.test(text));
  }

  private determineChunkingStrategy(filename: string, text: string): ChunkingStrategy {
    return this.isProductDocument(text) ? this.productDocStrategy : this.defaultStrategy;
  }

  // Keep the enhanced text extraction and cleaning methods
  private async extractText(buffer: Buffer, fileType: string): Promise<ExtractedContent> {
    switch (fileType.toLowerCase()) {
      case 'txt':
        const text = buffer.toString('utf-8');
        return {
          text,
          links: this.extractLinksFromText(text)
        };
      
      case 'pdf':
        try {
          const text = await this.extractPdfTextEnhanced(buffer);
          const links = await this.extractLinksFromPdf(buffer);
          return { text, links };
        } catch (error) {
          throw new Error(`Failed to extract PDF text: ${(error as Error).message}`);
        }
      
      case 'docx':
        try {
          const result = await mammoth.extractRawText({ buffer });
          const links = await this.extractLinksFromDocx(buffer);
          return {
            text: result.value,
            links
          };
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
    
    // Analyze the text to understand its structure
    const textAnalysis = this.analyzeTextStructure(text);
    
    // Apply adaptive cleaning based on the analysis
    cleanedText = this.applyAdaptiveCleaning(cleanedText, textAnalysis);
    
    // Standard cleaning that works for all documents
    cleanedText = cleanedText
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/([.!?])\s*([A-Z])/g, '$1 $2')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
    
    return cleanedText;
  }

  private analyzeTextStructure(text: string): any {
    const analysis = {
      hasSpacedNumbers: false,
      hasSpacedLetters: false,
      spacingPattern: 'none',
      documentStructure: 'unknown',
      commonNumberPatterns: [] as string[],
      likelyOCRIssues: false
    };

    // Detect spaced numbers (like "1 8 99", "2 0 2 4", etc.)
    const spacedNumberMatches = text.match(/\b\d(\s+\d){1,4}\b/g);
    if (spacedNumberMatches && spacedNumberMatches.length > 0) {
      analysis.hasSpacedNumbers = true;
      analysis.commonNumberPatterns = spacedNumberMatches;
      analysis.likelyOCRIssues = true;
    }

    // Detect spaced letters (like "P r o d u c t")
    const spacedLetterMatches = text.match(/\b[A-Za-z](\s+[A-Za-z]){2,}\b/g);
    if (spacedLetterMatches && spacedLetterMatches.length > 2) {
      analysis.hasSpacedLetters = true;
      analysis.likelyOCRIssues = true;
    }

    // Detect document structure
    if (text.toLowerCase().includes('product') && text.toLowerCase().includes('price')) {
      analysis.documentStructure = 'product';
    } else if (text.toLowerCase().includes('invoice') || text.toLowerCase().includes('bill')) {
      analysis.documentStructure = 'invoice';
    } else if (text.toLowerCase().includes('manual') || text.toLowerCase().includes('instruction')) {
      analysis.documentStructure = 'manual';
    }

    return analysis;
  }

  private applyAdaptiveCleaning(text: string, analysis: any): string {
    let cleanedText = text;

    // If we detected spaced numbers, fix them intelligently
    if (analysis.hasSpacedNumbers) {
      // Fix 4-digit years (like "2 0 2 4" -> "2024")
      cleanedText = cleanedText.replace(/\b(19|20)(\s+)(\d)(\s+)(\d)(\s+)(\d)\b/g, '$1$3$5$7');
      
      // Fix 3-4 digit prices/numbers (like "1 8 99" -> "1899")
      cleanedText = cleanedText.replace(/\b(\d)(\s+)(\d)(\s+)(\d+)\b/g, '$1$3$5');
      
      // Fix 2-digit numbers (like "1 5" -> "15")
      cleanedText = cleanedText.replace(/\b(\d)(\s+)(\d)\b/g, (match, d1, space, d2) => {
        // Only fix if it looks like a meaningful number (not random digits)
        const context = text.substring(text.indexOf(match) - 20, text.indexOf(match) + 20);
        if (context.toLowerCase().includes('price') || 
            context.toLowerCase().includes('cost') || 
            context.toLowerCase().includes('amount') ||
            context.includes('₹') || context.includes('rs')) {
          return d1 + d2;
        }
        return match;
      });
    }

    // If we detected spaced letters, fix common words
    if (analysis.hasSpacedLetters) {
      // Fix common spaced words
      const commonWords = ['product', 'description', 'specification', 'price', 'features', 'benefits'];
      commonWords.forEach(word => {
        const spacedPattern = word.split('').join('\\s+');
        const regex = new RegExp(`\\b${spacedPattern}\\b`, 'gi');
        cleanedText = cleanedText.replace(regex, word);
      });
      
      // General spaced letter fixing (more conservative)
      cleanedText = cleanedText.replace(/\b([A-Za-z])\s+([A-Za-z])\s+([A-Za-z]+)\b/g, (match) => {
        // Only fix if the result would be a reasonable word length
        const unspaced = match.replace(/\s+/g, '');
        if (unspaced.length <= 20) {
          return unspaced;
        }
        return match;
      });
    }

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

  async deleteDocumentFromVector(documentId: string): Promise<void> {
    await qdrantService.deleteByDocumentId(documentId);
  }

  /**
   * Generate a semantic title optimized for search and display
   */
  private generateSemanticTitle(content: string, metadata: any): string {
    // Use existing title from metadata if available and meaningful
    if (metadata.title && metadata.title !== 'Untitled Section' && metadata.title.length > 10) {
      return metadata.title;
    }

    // Extract the most meaningful phrase from content
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length > 0) {
      const firstSentence = sentences[0].trim();
      // Create a concise title from first sentence
      if (firstSentence.length <= 80) {
        return firstSentence;
      } else {
        // Truncate intelligently at word boundary
        const truncated = firstSentence.substring(0, 77);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > 40 ? truncated.substring(0, lastSpace) : truncated) + '...';
      }
    }

    // Fallback to chunk type and product name
    const productName = metadata.productName || metadata.filename || 'Product';
    const chunkType = metadata.chunkType || 'Information';
    return `${productName} - ${chunkType.charAt(0).toUpperCase() + chunkType.slice(1)}`;
  }

  /**
   * Extract comprehensive keywords for hybrid search (BM25 + vector)
   */
  private extractRobustKeywords(content: string, metadata: any): string[] {
    const keywords = new Set<string>();

    // 1. Extract from existing keyTopics in metadata
    if (metadata.keyTopics && Array.isArray(metadata.keyTopics)) {
      metadata.keyTopics.forEach((topic: string) => keywords.add(topic.toLowerCase()));
    }

    // 2. Extract product-specific keywords from docMetadata
    if (metadata.docMetadata?.key_entities) {
      const entities = metadata.docMetadata.key_entities;
      
      // Product name variants
      if (entities.product_name) {
        keywords.add(entities.product_name.toLowerCase());
        // Add individual words from product name
        entities.product_name.split(/\s+/).forEach((word: string) => {
          if (word.length > 2) keywords.add(word.toLowerCase());
        });
      }

      // Materials
      if (entities.materials) {
        Object.values(entities.materials).forEach((material: any) => {
          if (typeof material === 'string' && material.length > 2) {
            keywords.add(material.toLowerCase());
          }
        });
      }

      // Dimensions (extract numbers as keywords)
      if (entities.dimensions) {
        keywords.add('dimensions');
        const numbers = entities.dimensions.match(/\d+/g);
        if (numbers) {
          keywords.add(entities.dimensions.toLowerCase());
        }
      }

      // Weight
      if (entities.weight) {
        keywords.add('weight');
      }

      // Pricing
      if (entities.pricing) {
        keywords.add('price');
        keywords.add(`₹${entities.pricing}`);
      }
    }

    // 3. Extract from categories and topics
    if (metadata.docMetadata?.categories) {
      metadata.docMetadata.categories.forEach((cat: string) => keywords.add(cat.toLowerCase()));
    }
    if (metadata.docMetadata?.topics) {
      metadata.docMetadata.topics.forEach((topic: string) => keywords.add(topic.toLowerCase()));
    }

    // 4. Extract chunk-type specific keywords
    const chunkType = metadata.chunkType;
    if (chunkType) {
      keywords.add(chunkType);
      
      // Add related keywords based on chunk type
      const typeKeywords = this.getChunkTypeKeywords(chunkType);
      typeKeywords.forEach(kw => keywords.add(kw));
    }

    // 5. Extract important nouns and phrases from content
    const contentKeywords = this.extractContentKeywords(content);
    contentKeywords.forEach(kw => keywords.add(kw));

    // 6. Add synonyms and related terms for common keywords
    const expandedKeywords = this.expandKeywordsWithSynonyms(Array.from(keywords));
    expandedKeywords.forEach(kw => keywords.add(kw));

    // Convert to array and limit to top 20 most relevant
    return Array.from(keywords).slice(0, 20);
  }

  /**
   * Get related keywords based on chunk type
   */
  private getChunkTypeKeywords(chunkType: string): string[] {
    const typeKeywordMap: Record<string, string[]> = {
      'pricing': ['price', 'cost', 'mrp', 'offer', 'discount', 'payment'],
      'specification': ['specs', 'dimensions', 'weight', 'size', 'technical', 'measurements'],
      'features': ['benefits', 'features', 'advantages', 'highlights', 'functionality'],
      'policies': ['warranty', 'return', 'exchange', 'refund', 'guarantee', 'policy'],
      'use_cases': ['usage', 'application', 'use', 'purpose', 'suitable for'],
      'benefits': ['advantages', 'benefits', 'features', 'value', 'improvements'],
      'technical': ['technical', 'specifications', 'details', 'construction', 'design'],
      'introduction': ['overview', 'summary', 'about', 'introduction', 'description']
    };

    return typeKeywordMap[chunkType] || [];
  }

  /**
   * Extract important keywords from content text
   */
  private extractContentKeywords(content: string): string[] {
    const keywords: string[] = [];
    
    // Extract capitalized words (likely important terms)
    const capitalizedWords = content.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    capitalizedWords.forEach(word => {
      if (word.length > 3) keywords.push(word.toLowerCase());
    });

    // Extract numbers with units (measurements, prices)
    const measurements = content.match(/\d+(?:\.\d+)?\s*(?:cm|mm|m|kg|g|inch|₹|rs)/gi) || [];
    measurements.forEach(m => keywords.push(m.toLowerCase()));

    // Extract quoted phrases
    const quotes = content.match(/"([^"]+)"/g) || [];
    quotes.forEach(q => {
      const cleaned = q.replace(/"/g, '');
      if (cleaned.length > 3 && cleaned.length < 50) {
        keywords.push(cleaned.toLowerCase());
      }
    });

    return keywords;
  }

  /**
   * Expand keywords with common synonyms for better search coverage
   */
  private expandKeywordsWithSynonyms(keywords: string[]): string[] {
    const synonymMap: Record<string, string[]> = {
      'pillow': ['cushion'],
      'leg': ['limb'],
      'support': ['aid', 'assistance'],
      'pain': ['ache', 'discomfort'],
      'comfort': ['ease', 'relaxation'],
      'ergonomic': ['comfortable', 'supportive'],
      'circulation': ['blood flow'],
      'fatigue': ['tiredness', 'exhaustion'],
      'relief': ['comfort', 'ease']
    };

    const expanded: string[] = [];
    keywords.forEach(keyword => {
      if (synonymMap[keyword]) {
        expanded.push(...synonymMap[keyword]);
      }
    });

    return expanded;
  }

  /**
   * Generate document section hierarchy for context stitching
   */
  private generateDocumentSection(chunk: ProcessedChunk, allChunks: ProcessedChunk[], currentIndex: number): { parent: string; current: string; next?: string } {
    const metadata = chunk.metadata;
    const chunkType = metadata?.chunkType || 'general';

    // Determine parent section based on document type
    let parent = 'Product Overview';
    if (metadata?.documentType === 'manual') {
      parent = 'User Manual';
    } else if (metadata?.documentType === 'technical') {
      parent = 'Technical Documentation';
    } else if (metadata?.documentType === 'invoice') {
      parent = 'Invoice Details';
    }

    // Current section is based on chunk type
    const current = this.chunkTypeToSectionName(chunkType);

    // Next section preview (if available)
    let next: string | undefined;
    if (currentIndex < allChunks.length - 1) {
      const nextChunk = allChunks[currentIndex + 1];
      const nextType = nextChunk.metadata?.chunkType || 'general';
      next = this.chunkTypeToSectionName(nextType);
    }

    return { parent, current, next };
  }

  /**
   * Convert chunk type to human-readable section name
   */
  private chunkTypeToSectionName(chunkType: string): string {
    const sectionMap: Record<string, string> = {
      'introduction': 'Introduction',
      'specification': 'Specifications',
      'features': 'Features',
      'pricing': 'Pricing',
      'policies': 'Policies',
      'use_cases': 'Use Cases',
      'benefits': 'Benefits',
      'technical': 'Technical Details',
      'general': 'General Information'
    };

    return sectionMap[chunkType] || 'Information';
  }

  /**
   * Generate searchable text optimized for keyword search (BM25)
   */
  private generateSearchableText(content: string, metadata: any): string {
    const parts: string[] = [];

    // Add content
    parts.push(content);

    // Add metadata fields that should be searchable
    if (metadata.title) parts.push(metadata.title);
    if (metadata.summary) parts.push(metadata.summary);
    if (metadata.productName) parts.push(metadata.productName);
    if (metadata.filename) parts.push(metadata.filename);

    // Add key entities
    if (metadata.docMetadata?.key_entities) {
      const entities = metadata.docMetadata.key_entities;
      if (entities.product_name) parts.push(entities.product_name);
      if (entities.dimensions) parts.push(entities.dimensions);
      if (entities.pricing) parts.push(`price ${entities.pricing}`);
      if (entities.materials) {
        Object.values(entities.materials).forEach((m: any) => {
          if (typeof m === 'string') parts.push(m);
        });
      }
    }

    // Add categories and topics
    if (metadata.docMetadata?.categories) {
      parts.push(...metadata.docMetadata.categories);
    }
    if (metadata.docMetadata?.topics) {
      parts.push(...metadata.docMetadata.topics);
    }

    // Join and normalize
    return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Find links that are relevant to a specific chunk
   */
  private findRelevantLinks(chunkContent: string, allLinks: ExtractedLink[], fullText: string): ExtractedLink[] {
    const relevantLinks: ExtractedLink[] = [];
    
    // Find the position of this chunk in the full text
    const chunkStart = fullText.indexOf(chunkContent);
    if (chunkStart === -1) {
      // If chunk not found in full text, return links that appear in the chunk content
      return allLinks.filter(link => 
        link.position && 
        chunkContent.includes(link.url.split('/').pop() || '') ||
        (link.text && chunkContent.includes(link.text))
      );
    }
    
    const chunkEnd = chunkStart + chunkContent.length;
    
    // Find links that are within or near this chunk
    for (const link of allLinks) {
      if (link.position && link.position.x !== undefined) {
        const linkPosition = link.position.x;
        
        // Include links that are within the chunk or within 200 characters of it
        if (linkPosition >= chunkStart - 200 && linkPosition <= chunkEnd + 200) {
          relevantLinks.push(link);
        }
      } else {
        // For links without position info, check if they appear in the chunk content
        if (chunkContent.includes(link.url) || (link.text && chunkContent.includes(link.text))) {
          relevantLinks.push(link);
        }
      }
    }
    
    return relevantLinks;
  }

  /**
   * Extract links from text content using regex patterns
   */
  private extractLinksFromText(text: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    
    // URL patterns
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
    const imagePattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?[^\s<>"{}|\\^`\[\]]*)?)/gi;
    const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
    const phonePattern = /(\+?[\d\s\-\(\)]{10,})/gi;
    
    // Extract URLs
    let match;
    while ((match = urlPattern.exec(text)) !== null) {
      const url = match[1];
      const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?.*)?$/i.test(url);
      
      links.push({
        url,
        type: isImage ? 'image' : 'link',
        position: { x: match.index, y: 0 }
      });
    }
    
    // Extract images (separate pass to avoid duplicates)
    while ((match = imagePattern.exec(text)) !== null) {
      const url = match[1];
      // Check if not already added
      if (!links.some(link => link.url === url)) {
        links.push({
          url,
          type: 'image',
          position: { x: match.index, y: 0 }
        });
      }
    }
    
    // Extract emails
    while ((match = emailPattern.exec(text)) !== null) {
      links.push({
        url: `mailto:${match[1]}`,
        text: match[1],
        type: 'email',
        position: { x: match.index, y: 0 }
      });
    }
    
    // Extract phone numbers
    while ((match = phonePattern.exec(text)) !== null) {
      const phone = match[1].replace(/\s+/g, '');
      if (phone.length >= 10) {
        links.push({
          url: `tel:${phone}`,
          text: match[1],
          type: 'phone',
          position: { x: match.index, y: 0 }
        });
      }
    }
    
    return links;
  }

  /**
   * Extract links from DOCX using mammoth
   */
  private async extractLinksFromDocx(buffer: Buffer): Promise<ExtractedLink[]> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const links = this.extractLinksFromText(result.value);
      
      // Try to extract more detailed link information if available
      const detailedResult = await mammoth.convertToHtml({ buffer });
      if (detailedResult.value) {
        // Extract links from HTML content
        const htmlLinks = this.extractLinksFromHtml(detailedResult.value);
        // Merge with text-based links, avoiding duplicates
        const mergedLinks = [...links];
        htmlLinks.forEach(htmlLink => {
          if (!mergedLinks.some(link => link.url === htmlLink.url)) {
            mergedLinks.push(htmlLink);
          }
        });
        return mergedLinks;
      }
      
      return links;
    } catch (error) {
      console.warn('Failed to extract links from DOCX:', error);
      return [];
    }
  }

  /**
   * Extract links from HTML content
   */
  private extractLinksFromHtml(html: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    
    // Extract <a> tags
    const linkPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      links.push({
        url: match[1],
        text: match[2].trim(),
        type: 'link'
      });
    }
    
    // Extract <img> tags
    const imgPattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((match = imgPattern.exec(html)) !== null) {
      links.push({
        url: match[1],
        type: 'image'
      });
    }
    
    return links;
  }

  /**
   * Extract links from PDF using pdf2json
   */
  private async extractLinksFromPdf(buffer: Buffer): Promise<ExtractedLink[]> {
    return new Promise((resolve, reject) => {
      const pdfParser = new pdf2json();
      
      pdfParser.on("pdfParser_dataError", (errData: any) => {
        console.warn('PDF parsing error for link extraction:', errData.parserError);
        resolve([]);
      });
      
      pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
        try {
          const links: ExtractedLink[] = [];
          
          if (pdfData.Pages) {
            for (let pageIndex = 0; pageIndex < pdfData.Pages.length; pageIndex++) {
              const page = pdfData.Pages[pageIndex];
              let pageText = '';
              
              if (page.Texts) {
                for (const textItem of page.Texts) {
                  if (textItem.R) {
                    for (const run of textItem.R) {
                      if (run.T) {
                        const decodedText = decodeURIComponent(run.T);
                        pageText += decodedText;
                      }
                    }
                  }
                }
              }
              
              // Extract links from page text
              const pageLinks = this.extractLinksFromText(pageText);
              pageLinks.forEach(link => {
                if (link.position) {
                  link.position.page = pageIndex + 1;
                }
              });
              links.push(...pageLinks);
            }
          }
          
          resolve(links);
        } catch (error) {
          console.warn('Error extracting links from PDF:', error);
          resolve([]);
        }
      });
      
      pdfParser.parseBuffer(buffer);
    });
  }

  /**
   * Calculate keyword density for ranking
   */
  private calculateKeywordDensity(content: string, keywords: string[]): Record<string, number> {
    const density: Record<string, number> = {};
    const lowerContent = content.toLowerCase();
    const totalWords = lowerContent.split(/\s+/).length;

    keywords.forEach(keyword => {
      const regex = new RegExp(`\\b${keyword.toLowerCase()}\\b`, 'g');
      const matches = lowerContent.match(regex);
      const count = matches ? matches.length : 0;
      density[keyword] = totalWords > 0 ? count / totalWords : 0;
    });

    return density;
  }
}

export const documentProcessor = new DocumentProcessor();