import { createEmbedding } from "../rag/providers/embeddingService.js";
import { extractDocumentMetadata } from "../../services/llm/openai.js";
import { qdrantService } from "../rag/providers/qdrantHybrid.js";
import { storage } from "../../storage.js";
import type { Document } from "../../../shared/schema.js";
import mammoth from "mammoth";
import pdf2json from "pdf2json";
import OpenAI from "openai";
import { pdfToPng } from "pdf-to-png-converter";
import { inferenceProvider } from "../../services/llm/inference.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../env.js";


const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

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
      console.log(`\n${'='.repeat(80)}`);
      console.log(`📄 PROCESSING DOCUMENT: ${document.originalName}`);
      console.log(`${'='.repeat(80)}\n`);

      // Update status to processing
      await storage.updateDocumentStatus(document.id, "processing");

      // Extract text with enhanced extraction
      console.log(`📖 Step 1: Extracting text from ${document.fileType.toUpperCase()} file...`);
      const extractedContent = await this.extractText(fileBuffer, document.fileType);
      console.log(`✅ Extracted ${extractedContent.text.length} characters`);
      console.log(`✅ Found ${extractedContent.links.length} links`);
      
      // Clean and normalize the extracted text
      console.log(`\n🧹 Step 2: Cleaning and normalizing text...`);
      const text = this.cleanAndNormalizeText(extractedContent.text);
      console.log(`✅ Cleaned text: ${text.length} characters (from ${extractedContent.text.length})`);
      
      
      // Validate text quality
      const qualityCheck = this.validateTextQuality(text);
      if (!qualityCheck) {
        console.warn(`⚠️  Text quality is low, but continuing processing...`);
      } else {
        console.log(`✅ Text quality validation passed`);
      }
      
      // Extract document metadata
      console.log(`\n📋 Step 3: Extracting document metadata...`);
      const docMetadata = await extractDocumentMetadata(text, document.originalName);
      console.log(`✅ Document metadata extracted`);

      // Determine chunking strategy
      const strategy = this.determineChunkingStrategy(document.originalName, text);
      console.log(`\n🎯 Step 4: Using chunking strategy: ${strategy.name}`);

      // Use AI-powered intelligent chunking
      console.log(`\n🤖 Step 5: Creating intelligent chunks with AI...`);
      const aiChunkingResult = await this.createAIChunks(text, document.originalName, strategy);
      
      console.log(`✅ Successfully created ${aiChunkingResult.chunks.length} chunks`);
      console.log(`📊 TOTAL CHUNKS CREATED: ${aiChunkingResult.chunks.length}`);
      console.log(`   Document Type: ${aiChunkingResult.documentType}`);
      console.log(`   Document Summary: ${aiChunkingResult.documentSummary.substring(0, 100)}...`);


      
      // Convert AI chunks to ProcessedChunks
      console.log(`\n🔗 Step 6: Processing chunks and linking...`);
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
            sourceUrl: sourceUrl || (document.metadata as any)?.sourceUrl,
            uploadType: (document.metadata as any)?.uploadType || 'file',
            documentLinks: extractedContent.links
          }
        };
      });

      console.log(`✅ Processed ${processedChunks.length} chunks with metadata`);

      // Process each chunk
      console.log(`\n🎨 Step 7: Creating embeddings and storing chunks...`);
      const vectorChunks = [];
      for (let i = 0; i < processedChunks.length; i++) {
        const chunk = processedChunks[i];
        
        console.log(`   Processing chunk ${i + 1}/${processedChunks.length}...`);
        
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
            links: chunk.links || [],
            imageLinks: chunk.links ? chunk.links.filter(link => link.type === 'image') : [],
            externalLinks: chunk.links ? chunk.links.filter(link => link.type === 'link') : [],
          },
        });
      }

      console.log(`✅ Created ${vectorChunks.length} vector chunks with embeddings`);

      // Add to vector database
      await qdrantService.addPoints(vectorChunks);
      
      console.log(`\n💾 Step 8: Updating document status...`);
      await storage.updateDocumentStatus(document.id, "indexed", new Date());
      await storage.updateDocumentChunkCount(document.id, processedChunks.length);
      
      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ SUCCESSFULLY PROCESSED: ${document.originalName}`);
      console.log(`📊 TOTAL CHUNKS: ${processedChunks.length}`);
      console.log(`📝 Total characters: ${text.length}`);
      console.log(`🔗 Total links: ${extractedContent.links.length}`);
      console.log(`${'='.repeat(80)}\n`);

    } catch (error) {
      console.error(`\n${'='.repeat(80)}`);
      console.error(`❌ PROCESSING FAILED: ${document.originalName}`);
      console.error(`${'='.repeat(80)}`);
      console.error(`Error: ${(error as Error).message}`);
      console.error(`Stack trace:\n${(error as Error).stack}`);
      console.error(`${'='.repeat(80)}\n`);
      
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
      
      console.log(`   🤖 Calling OpenAI GPT-4o for intelligent chunking...`);
      
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are a document chunking specialist. Your task is to divide documents into semantically meaningful chunks.

CRITICAL RULES - READ CAREFULLY:
1. Use ONLY the text provided - do not add, infer, or create any new information
2. Each chunk must contain ONLY text that appears verbatim in the source document
3. Do not rephrase, paraphrase, or rewrite - copy the EXACT text for each chunk
4. Divide based on natural section boundaries (headings, topics, content changes)
5. Capture ALL information - nothing should be lost between chunks
6. Each chunk should be self-contained and make sense independently
7. Pay special attention to:
   - Pricing information (exact numbers and currency)
   - Measurements and specifications (exact values and units)
   - Product names and model numbers (exact spelling)
   - Dates and contact information (exact formats)
8. Maintain logical flow and context
9. Identify and properly categorize different types of content

VALIDATION REQUIREMENTS:
- Every word in your chunks must exist in the source document
- All numbers, prices, and measurements must be exact
- No hallucinations or invented content
- No summaries that don't reflect actual content

Always respond with valid JSON only. No markdown formatting.`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.0, // Zero temperature for maximum consistency
        max_tokens: 8000
      });

      const result = response.choices[0]?.message?.content;
      if (!result) {
        throw new Error("No response from OpenAI");
      }

      console.log(`   ✅ Received AI response (${result.length} characters)`);

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
        console.log(`   ✅ Successfully parsed JSON response`);
      } catch (parseError) {
        console.error(`   ❌ JSON parsing failed:`, parseError);
        console.error(`   Raw response preview:`, result.substring(0, 500));
        throw new Error(`Failed to parse AI response as JSON: ${(parseError as Error).message}`);
      }
      
      // Validate and clean the result (WITH HALLUCINATION DETECTION)
      console.log(`   🔍 Validating chunks for hallucinations...`);
      const validatedResult = this.validateAndCleanAIResult(aiResult, strategy, text);
      console.log(`   ✅ Validation complete: ${validatedResult.chunks.length} valid chunks`);
      
      return validatedResult;
      
    } catch (error) {
      console.error(`   ❌ AI chunking failed:`, (error as Error).message);
      console.log(`   🔄 Falling back to enhanced simple chunking...`);
      
      // Fallback to enhanced simple chunking
      return this.createEnhancedFallbackChunks(text, filename, strategy);
    }
  }

  private buildAIChunkingPrompt(text: string, filename: string, strategy: ChunkingStrategy): string {
    return `You are a document chunking specialist. Divide this document into logical, semantically meaningful chunks.

DOCUMENT INFORMATION:
- Filename: "${filename}"
- Content Length: ${text.length} characters
- Target Chunk Size: ${strategy.minChunkSize}-${strategy.maxChunkSize} characters

YOUR TASK:
Analyze the document and create chunks that:
1. Preserve natural section boundaries (headings, topics, content type changes)
2. Keep related information together
3. Are self-contained and meaningful when read independently
4. Contain ONLY text that exists verbatim in the source document

CRITICAL REQUIREMENTS:
✓ Copy exact text - do not paraphrase or rewrite
✓ Capture EVERY detail: prices, measurements, specifications, names, dates
✓ Group related information logically
✓ Maintain proper context and flow
✓ Do not split tables, lists, or related data
✓ Do not invent or infer information

CONTENT TO CAPTURE:
- All numerical data (prices, measurements, quantities)
- Technical specifications and details
- Product names and model numbers
- Policies, warranties, and terms
- Contact information and links
- Headers, titles, and section markers

OUTPUT FORMAT (valid JSON only):
{
  "documentType": "product|manual|technical|general|handbook|guide",
  "documentSummary": "Brief one-sentence summary of the entire document",
  "chunks": [
    {
      "content": "EXACT verbatim text from the document (${strategy.minChunkSize}-${strategy.maxChunkSize} chars)",
      "title": "Clear, descriptive title for this section",
      "summary": "2-3 sentence summary of what this chunk contains",
      "keyTopics": ["primary topic", "secondary topic", "tertiary topic"],
      "importance": 1-10 (10 = critical information like pricing/specs),
      "chunkType": "introduction|specification|features|pricing|policies|technical|general"
    }
  ]
}

QUALITY CHECKS:
- Every chunk content must be extractable from source document
- No invented or inferred information
- All numbers, prices, and names must be exact
- Complete thoughts and logical groupings
- No orphaned or incomplete information

SOURCE DOCUMENT:
"""
${text}
"""

Remember: EXTRACT ONLY. Do not create, infer, summarize, or rephrase. Copy the exact text.`;
  }

  private validateAndCleanAIResult(
    result: AIChunkingResult, 
    strategy: ChunkingStrategy, 
    originalText: string
  ): AIChunkingResult {
    if (!result.chunks || result.chunks.length === 0) {
      throw new Error("No chunks returned from AI");
    }

    console.log(`      🔍 Validating ${result.chunks.length} chunks...`);
    const validChunks = [];
    const lowerOriginal = originalText.toLowerCase();
    const rejectedChunks = [];

    for (let i = 0; i < result.chunks.length; i++) {
      const chunk = result.chunks[i];
      
      // CRITICAL: Verify chunk content actually exists in original document
      // Take samples from beginning, middle, and end of chunk
      const chunkContent = chunk.content.toLowerCase().trim();
      const chunkLength = chunk.content.length;
      
      // Sample from different positions
      const startSample = chunkContent.substring(0, Math.min(80, chunkLength)).trim();
      const midSample = chunkLength > 200 
        ? chunkContent.substring(Math.floor(chunkLength / 2) - 40, Math.floor(chunkLength / 2) + 40).trim()
        : '';
      const endSample = chunkLength > 100 
        ? chunkContent.substring(Math.max(0, chunkLength - 80)).trim()
        : '';

      // Check if samples exist in original
      const startExists = startSample.length > 20 && lowerOriginal.includes(startSample.substring(0, 50));
      const midExists = midSample.length > 20 ? lowerOriginal.includes(midSample.substring(0, 40)) : true;
      const endExists = endSample.length > 20 && lowerOriginal.includes(endSample.substring(Math.max(0, endSample.length - 50)));

      // Chunk is valid if at least 2 out of 3 samples exist
      const validationScore = [startExists, midExists, endExists].filter(Boolean).length;
      const isValid = validationScore >= 2;

      if (!isValid) {
        console.warn(`      ⚠️  HALLUCINATION DETECTED in Chunk ${i + 1}:`);
        console.warn(`         Title: "${chunk.title}"`);
        console.warn(`         Start sample found: ${startExists}`);
        console.warn(`         Mid sample found: ${midExists}`);
        console.warn(`         End sample found: ${endExists}`);
        console.warn(`         Preview: "${chunk.content.substring(0, 100)}..."`);
        console.warn(`         ❌ REJECTING this chunk`);
        
        rejectedChunks.push({
          index: i + 1,
          title: chunk.title,
          reason: 'Content not found in original document'
        });
        continue;
      }

      // Additional validation
      const isValidLength = chunk.content.length >= strategy.minChunkSize / 3;
      const hasContent = chunk.content.trim().length > 50;

      if (!isValidLength) {
        console.warn(`      ⚠️  Chunk ${i + 1} too short (${chunk.content.length} chars), skipping`);
        rejectedChunks.push({
          index: i + 1,
          title: chunk.title,
          reason: `Too short (${chunk.content.length} chars)`
        });
        continue;
      }

      if (!hasContent) {
        console.warn(`      ⚠️  Chunk ${i + 1} has insufficient content, skipping`);
        rejectedChunks.push({
          index: i + 1,
          title: chunk.title,
          reason: 'Insufficient content'
        });
        continue;
      }

      // Chunk passed validation
      validChunks.push({
        ...chunk,
        content: chunk.content.trim(),
        title: chunk.title || 'Untitled Section',
        summary: chunk.summary || 'No summary available',
        keyTopics: chunk.keyTopics || [],
        importance: Math.max(1, Math.min(10, chunk.importance || 5)),
        chunkType: chunk.chunkType || 'general' as const
      });
    }

    if (validChunks.length === 0) {
      console.error(`      ❌ All chunks failed validation!`);
      throw new Error("No valid chunks after hallucination detection");
    }

    console.log(`      ✅ Validated ${validChunks.length} chunks (${rejectedChunks.length} rejected)`);
    
    if (rejectedChunks.length > 0) {
      console.log(`      📋 Rejected chunks summary:`);
      rejectedChunks.forEach(r => {
        console.log(`         - Chunk ${r.index}: "${r.title}" - ${r.reason}`);
      });
    }

    // Verify coverage - ensure we didn't lose too much content
    const totalChunkLength = validChunks.reduce((sum, c) => sum + c.content.length, 0);
    const coverageRatio = totalChunkLength / originalText.length;

    console.log(`      📊 Coverage analysis:`);
    console.log(`         Original text: ${originalText.length} chars`);
    console.log(`         Chunked text: ${totalChunkLength} chars`);
    console.log(`         Coverage ratio: ${(coverageRatio * 100).toFixed(1)}%`);

    if (coverageRatio < 0.6) {
      console.warn(`      ⚠️  LOW COVERAGE WARNING: Only ${(coverageRatio * 100).toFixed(1)}% of content captured`);
      console.warn(`      Consider using fallback chunking or reviewing the AI output`);
    } else if (coverageRatio < 0.8) {
      console.warn(`      ⚠️  Moderate coverage: ${(coverageRatio * 100).toFixed(1)}% of content captured`);
    } else {
      console.log(`      ✅ Good coverage: ${(coverageRatio * 100).toFixed(1)}% of content captured`);
    }

    return {
      ...result,
      chunks: validChunks,
      documentSummary: result.documentSummary || 'Document processed successfully',
      documentType: result.documentType || 'general'
    };
  }

  private createEnhancedFallbackChunks(
    text: string, 
    filename: string, 
    strategy: ChunkingStrategy
  ): AIChunkingResult {
    console.log(`   📦 Using enhanced fallback chunking method`);
    console.log(`   🎯 Strategy: Preserve ALL content with smart boundaries`);
    
    // Generate a proper document summary
    const documentSummary = this.generateDocumentSummary(text, filename);
    const documentType = this.determineDocumentType(text);
    
    console.log(`   📋 Document type: ${documentType}`);
    console.log(`   📝 Document summary: ${documentSummary.substring(0, 100)}...`);
    
    const chunks = [];
    
    // Split by double newlines first (paragraph boundaries)
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 30);
    console.log(`   📄 Found ${paragraphs.length} paragraphs`);
    
    let currentChunk = '';
    let chunkIndex = 0;
    
    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const potentialChunk = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;
      
      // Check if adding this paragraph would exceed max size
      if (potentialChunk.length > strategy.maxChunkSize && currentChunk.length >= strategy.minChunkSize) {
        // Save current chunk
        const chunkTitle = this.generateChunkTitle(currentChunk, chunkIndex + 1);
        const chunkSummary = this.generateChunkSummary(currentChunk);
        const chunkType = this.determineChunkType(currentChunk);
        const keyTopics = this.extractSimpleTopics(currentChunk);
        
        chunks.push({
          content: currentChunk.trim(),
          title: chunkTitle,
          summary: chunkSummary,
          keyTopics: keyTopics,
          importance: this.calculateChunkImportance(currentChunk, keyTopics),
          chunkType: chunkType
        });
        
        console.log(`   ✓ Chunk ${chunkIndex + 1}: "${chunkTitle}" (${currentChunk.length} chars)`);
        
        currentChunk = paragraph;
        chunkIndex++;
      } else {
        currentChunk = potentialChunk;
      }
    }
    
    // Add final chunk
    if (currentChunk.trim().length >= strategy.minChunkSize / 2) {
      const chunkTitle = this.generateChunkTitle(currentChunk, chunkIndex + 1);
      const chunkSummary = this.generateChunkSummary(currentChunk);
      const chunkType = this.determineChunkType(currentChunk);
      const keyTopics = this.extractSimpleTopics(currentChunk);
      
      chunks.push({
        content: currentChunk.trim(),
        title: chunkTitle,
        summary: chunkSummary,
        keyTopics: keyTopics,
        importance: this.calculateChunkImportance(currentChunk, keyTopics),
        chunkType: chunkType
      });
      
      console.log(`   ✓ Chunk ${chunkIndex + 1}: "${chunkTitle}" (${currentChunk.length} chars)`);
    }

    // Verify coverage
    const totalLength = chunks.reduce((sum, c) => sum + c.content.length, 0);
    const coverage = (totalLength / text.length) * 100;
    console.log(`   📊 Fallback chunking coverage: ${coverage.toFixed(1)}%`);
    console.log(`   ✅ Created ${chunks.length} chunks`);

    return {
      documentType,
      documentSummary,
      chunks
    };
  }

  private generateDocumentSummary(text: string, filename: string): string {
    // Extract first few meaningful sentences
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 15);
    const firstSentences = sentences.slice(0, 2).join('. ').trim() + '.';
    
    // Identify document type
    const isProduct = this.isProductDocument(text);
    
    if (isProduct) {
      const productName = this.extractProductName(text, filename);
      return `Product documentation for ${productName}. ${firstSentences.substring(0, 150)}`;
    } else {
      return `${filename.replace(/\.(pdf|docx?|txt)$/i, '')}: ${firstSentences.substring(0, 200)}`;
    }
  }

  private determineDocumentType(text: string): string {
    if (this.isProductDocument(text)) return 'product';
    
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('handbook') || lowerText.includes('guide')) return 'handbook';
    if (lowerText.includes('manual') || lowerText.includes('instruction')) return 'manual';
    if (lowerText.includes('technical') || lowerText.includes('specification')) return 'technical';
    if (lowerText.includes('invoice') || lowerText.includes('bill')) return 'invoice';
    
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
    if (lowerContent.includes('price') || lowerContent.includes('cost') || lowerContent.includes('₹') || lowerContent.includes('pricing')) {
      return 'Pricing Information';
    }
    if (lowerContent.includes('dimension') || lowerContent.includes('size') || lowerContent.includes('weight') || lowerContent.includes('measurement')) {
      return 'Product Specifications';
    }
    if (lowerContent.includes('feature') || lowerContent.includes('benefit')) {
      return 'Features & Benefits';
    }
    if (lowerContent.includes('material') || lowerContent.includes('fabric') || lowerContent.includes('construction')) {
      return 'Material & Construction';
    }
    if (lowerContent.includes('warranty') || lowerContent.includes('return') || lowerContent.includes('policy') || lowerContent.includes('exchange')) {
      return 'Policies & Warranty';
    }
    if (lowerContent.includes('use case') || lowerContent.includes('suitable') || lowerContent.includes('application')) {
      return 'Usage & Applications';
    }
    if (lowerContent.includes('about') || lowerContent.includes('overview') || lowerContent.includes('introduction')) {
      return 'Overview';
    }
    if (lowerContent.includes('contact') || lowerContent.includes('support') || lowerContent.includes('email') || lowerContent.includes('phone')) {
      return 'Contact Information';
    }
    
    // Try to extract a title from the first line or heading
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      const firstLine = lines[0].trim();
      // If first line is short and looks like a heading
      if (firstLine.length > 5 && firstLine.length < 80 && !firstLine.endsWith('.')) {
        return firstLine;
      }
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
    
    // Use first 2 sentences for summary
    const summaryText = sentences.slice(0, 2).join('. ').trim();
    const summary = summaryText.length > 150 ? 
      summaryText.substring(0, 147) + '...' : 
      summaryText + '.';
      
    return summary || 'Content summary not available';
  }

  private determineChunkType(content: string): 'introduction' | 'specification' | 'features' | 'pricing' | 'policies' | 'technical' | 'general' {
    const lowerContent = content.toLowerCase();
    
    // Score each type
    const scores = {
      pricing: 0,
      specification: 0,
      features: 0,
      policies: 0,
      technical: 0,
      introduction: 0,
      general: 0
    };

    // Pricing indicators
    if (lowerContent.includes('price') || lowerContent.includes('cost') || 
        lowerContent.includes('₹') || lowerContent.includes('rs') || 
        lowerContent.includes('mrp') || lowerContent.includes('discount')) {
      scores.pricing += 3;
    }

    // Specification indicators
    if (lowerContent.includes('dimension') || lowerContent.includes('specification') || 
        lowerContent.includes('weight') || lowerContent.includes('size') ||
        lowerContent.includes('measurement')) {
      scores.specification += 3;
    }

    // Features indicators
    if (lowerContent.includes('feature') || lowerContent.includes('benefit') || 
        lowerContent.includes('advantage') || lowerContent.includes('capability')) {
      scores.features += 3;
    }

    // Policies indicators
    if (lowerContent.includes('warranty') || lowerContent.includes('return') || 
        lowerContent.includes('policy') || lowerContent.includes('exchange') ||
        lowerContent.includes('guarantee')) {
      scores.policies += 3;
    }

    // Technical indicators
    if (lowerContent.includes('material') || lowerContent.includes('technical') || 
        lowerContent.includes('construction') || lowerContent.includes('engineering')) {
      scores.technical += 3;
    }

    // Introduction indicators
    if (lowerContent.includes('about') || lowerContent.includes('overview') || 
        lowerContent.includes('introduction') || lowerContent.includes('welcome')) {
      scores.introduction += 3;
    }

    // Find highest score
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore === 0) return 'general';

    const type = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0];
    return (type || 'general') as any;
  }

  private calculateChunkImportance(content: string, keyTopics: string[]): number {
    let importance = 5; // Base importance
    
    const lowerContent = content.toLowerCase();
    
    // High importance for pricing
    if (lowerContent.includes('price') || lowerContent.includes('₹') || 
        lowerContent.includes('cost') || lowerContent.includes('mrp')) {
      importance += 3;
    }
    
    // High importance for specifications
    if (lowerContent.includes('dimension') || lowerContent.includes('weight') || 
        lowerContent.includes('size') || lowerContent.includes('specification')) {
      importance += 2;
    }
    
    // Medium importance for features
    if (lowerContent.includes('feature') || lowerContent.includes('benefit')) {
      importance += 1;
    }
    
    // Importance based on content density
    const hasNumbers = /\d+/.test(content);
    const hasMeasurements = /\d+\s*(?:cm|mm|m|kg|g|inch|ft)/i.test(content);
    
    if (hasNumbers) importance += 1;
    if (hasMeasurements) importance += 1;
    
    // Importance based on key topics
    if (keyTopics.length >= 3) importance += 1;
    
    return Math.min(10, Math.max(1, importance));
  }

  private extractSimpleTopics(text: string): string[] {
    // Extract meaningful words (nouns, adjectives, important terms)
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 4); // Only words with 5+ characters
    
    // Common words to exclude
    const stopWords = new Set([
      'about', 'above', 'after', 'again', 'against', 'all', 'also', 'and', 'any', 'are',
      'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
      'can', 'could', 'did', 'do', 'does', 'doing', 'don', 'down', 'during', 'each',
      'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'here', 'how',
      'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'may', 'might', 'more',
      'most', 'must', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
      'our', 'out', 'over', 'own', 'same', 'should', 'so', 'some', 'such', 'than',
      'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
      'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were',
      'what', 'when', 'where', 'which', 'while', 'who', 'will', 'with', 'would', 'you',
      'your', 'yours', 'yourself', 'yourselves'
    ]);
    
    const importantWords = words.filter(word => !stopWords.has(word));
    
    // Count word frequencies
    const wordCount = importantWords.reduce((acc, word) => {
      acc[word] = (acc[word] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Get top 5 most frequent words as topics
    return Object.entries(wordCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([word]) => word);
  }

  private isProductDocument(text: string): boolean {
    const lowerText = text.toLowerCase();
    let score = 0;
    
    // Universal product indicators
    const indicators = [
      { keywords: ['product', 'item'], weight: 2 },
      { keywords: ['price', 'cost', 'mrp', 'pricing'], weight: 3 },
      { keywords: ['features', 'specifications', 'specs'], weight: 2 },
      { keywords: ['dimensions', 'weight', 'size'], weight: 2 },
      { keywords: ['material', 'fabric', 'construction'], weight: 1 },
      { keywords: ['warranty', 'guarantee'], weight: 1 },
      { keywords: ['model', 'sku', 'part number'], weight: 2 },
      { keywords: ['benefits', 'advantages'], weight: 1 },
      { keywords: ['color', 'colour', 'variant'], weight: 1 },
      { keywords: ['brand', 'manufacturer'], weight: 1 }
    ];
    
    // Check indicators
    indicators.forEach(indicator => {
      if (indicator.keywords.some(keyword => lowerText.includes(keyword))) {
        score += indicator.weight;
      }
    });
    
    // Check for pricing patterns
    if (this.detectPricingPatterns(text)) score += 4;
    
    // Check for measurement patterns
    if (this.detectMeasurementPatterns(text)) score += 3;
    
    // Check for product structure
    if (this.detectProductStructure(text)) score += 2;
    
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

  // TEXT EXTRACTION METHODS
  private async extractText(buffer: Buffer, fileType: string): Promise<ExtractedContent> {
    switch (fileType.toLowerCase()) {
      case 'txt':
        const text = buffer.toString('utf-8');
        return {
          text,
          links: this.extractLinksFromText(text)
        };
      
      case 'md':
      case 'markdown':
        const markdownText = buffer.toString('utf-8');
        return {
          text: markdownText,
          links: this.extractLinksFromText(markdownText)
        };
      
      case 'pdf':
        try {
          console.log(`   📄 Extracting from PDF...`);
          const text = await this.extractPdfTextWithVisionFallback(buffer);
          const links = await this.extractLinksFromPdf(buffer);
          console.log(`   ✅ PDF extraction complete`);
          return { text, links };
        } catch (error) {
          throw new Error(`Failed to extract PDF text: ${(error as Error).message}`);
        }
      
      case 'docx':
        try {
          console.log(`   📄 Extracting from DOCX...`);
          const result = await mammoth.extractRawText({ buffer });
          const links = await this.extractLinksFromDocx(buffer);
          console.log(`   ✅ DOCX extraction complete`);
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
                
                // Sort by position (top to bottom, left to right)
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
            reject(new Error('PDF text extraction failed - document appears to be empty or image-based'));
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

  /**
   * Extract text from PDF - prioritize Gemini for better quality, fallback to traditional
   */
  private async extractPdfTextWithVisionFallback(buffer: Buffer): Promise<string> {
    try {
      console.log(`      🤖 Using Gemini 2.0 Flash for PDF extraction (primary method)...`);
      const geminiText = await this.extractTextFromPdfUsingMultimodal(buffer);
      console.log(`      ✅ Gemini extraction successful (${geminiText.length} chars)`);
      return geminiText;
      
    } catch (geminiError) {
      console.log(`      ⚠️  Gemini extraction failed: ${(geminiError as Error).message}`);
      console.log(`      🔍 Attempting traditional PDF text extraction as fallback...`);
      
      try {
        const traditionalText = await this.extractPdfTextEnhanced(buffer);
        
        // Validate quality
        if (this.validateTextQuality(traditionalText)) {
          console.log(`      ✅ Traditional extraction successful (${traditionalText.length} chars)`);
          return traditionalText;
        }
        
        console.log(`      ❌ Traditional extraction quality too poor to use`);
        throw new Error("Poor text quality from traditional extraction");
        
      } catch (traditionalError) {
        console.error(`      ❌ Both extraction methods failed`);
        throw new Error(`Both Gemini and traditional PDF extraction failed. Gemini: ${(geminiError as Error).message}, Traditional: ${(traditionalError as Error).message}`);
      }
    }
  }

  /**
   * Extract text from PDF using Gemini 2.0 Flash - handles both text and visual content
   */
  private async extractTextFromPdfUsingMultimodal(buffer: Buffer): Promise<string> {
    try {
      // Convert buffer to base64 for Gemini
      const base64Pdf = buffer.toString('base64');
      console.log(`         📄 Processing PDF (${(buffer.length / 1024).toFixed(0)} KB) with Gemini...`);
      
      // Initialize Gemini model with large output capacity
      const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash-exp",  // Using the experimental version for better PDF processing
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192, // Max tokens for Flash model
        }
      });
      
      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64Pdf
          }
        },
        {
          text: `Extract ALL content from this PDF document - both text AND visual information.

REQUIREMENTS:

1. TEXT EXTRACTION:
   - Extract all written text exactly as it appears
   - Maintain document structure: headings, paragraphs, lists, tables
   - Include ALL pages - do not skip any content
   - Fix obvious OCR spacing errors (e.g., "F r i d o" → "Frido")
   - Preserve all data: names, numbers, measurements, specifications

2. VISUAL CONTENT DESCRIPTION:
   - Describe ALL diagrams, charts, flowcharts, and infographics in detail
   - Explain what each visual element shows and represents
   - Capture data from charts (percentages, numbers, trends)
   - Describe maps with locations and geographic information
   - Explain organizational charts and hierarchies
   - Describe process flows and decision trees
   - Capture information from photos and images with context
   - Extract table structures completely

3. OUTPUT FORMAT:
   - Regular text content as-is
   - After visual elements, add: [VISUAL: detailed description]
   - Example format:

   Marketing Growth Playbook
   
   [VISUAL: Flowchart diagram showing three main stages:
   
   1. Problem Awareness (Yellow boxes):
      - "Talk About the Problem" box
      - "Own the Problem" box
      - Connected to "Problem Awareness" banner
   
   2. Solution Awareness (Yellow boxes):
      - "Ads on Meta, Google etc" box
      - "Influencer/Affiliate Marketing" box
      - "Sales Across Platforms" box
      - "Customer Review & Feedback" box
      - Feedback loop arrow connecting back to stage 1
   
   3. Channel Strategy (Beige boxes in flow):
      Offline Sales → Enhanced Brand Presence → Marketplace → Halo Effect → myfrido.com
   
   4. Foundation (Bottom boxes):
      - "We Own our Design IP" → "From R&D to Production to Commercialization"
      - "We Own our Marketing IP" → "From Ideating - Planning - Creative - Production"
      - Both converging to: "Complete Control Over Product Life Cycle"
   
   The diagram uses yellow for awareness stages, beige for channel flow, with black text and directional arrows showing the complete marketing ecosystem and feedback mechanisms.]

CRITICAL: 
- Do NOT skip any visual elements
- Describe diagrams as if explaining to someone who cannot see them
- Include all data points from charts and graphs
- Be comprehensive - this is for knowledge extraction

Output: Complete text extraction with detailed visual descriptions.`
        }
      ]);

      const extractedText = result.response.text();
      
      if (!extractedText || extractedText.trim().length < 100) {
        throw new Error('Insufficient text extracted from PDF');
      }

      console.log(`         ✅ Extracted ${extractedText.length} characters`);
      
      return extractedText.trim();
      
    } catch (error) {
      console.error(`         ❌ Gemini extraction failed:`, error);
      throw new Error(`Gemini PDF extraction failed: ${(error as Error).message}`);
    }
  }

  /**
   * DEPRECATED: Old method using GPT-4 Vision - replaced by Gemini 1.5 Pro
   * Keeping for reference but no longer used
   */
  /*
  private async extractTextFromPageImage(imageBuffer: Buffer, pageNumber: number): Promise<string> {
    const base64Image = imageBuffer.toString('base64');
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Vision extraction timeout')), 60000);
    });
    
    const visionPromise = openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a precise OCR transcription tool. Your ONLY job is to extract text from images.

STRICT RULES:
1. Extract ONLY the actual text visible in the image
2. Copy text EXACTLY as written - do not paraphrase or summarize
3. DO NOT describe visual elements, colors, layouts, or designs
4. DO NOT add commentary like "the image shows" or "this page contains"
5. DO NOT infer or create information not explicitly written
6. Maintain original formatting: headings, paragraphs, lists, tables
7. Fix obvious OCR spacing errors (e.g., "F r i d o" → "Frido")
8. Preserve all numbers, measurements, and technical data exactly
9. Include page headers/footers only if they contain actual content

OUTPUT FORMAT:
Return ONLY the extracted text. No preamble, no analysis, no descriptions.
Just pure text transcription.

EXAMPLES:
✓ CORRECT: "FRIDO EXPERIENCE STORE\nBY ARCATRON MOBILITY\n\nYour guide to..."
✗ WRONG: "The page shows a title 'Frido Experience Store' with yellow branding..."
✗ WRONG: "This is a handbook cover featuring..."

Remember: TRANSCRIBE ONLY. No descriptions.`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract all text from this page image. Output only the text, nothing else.`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
                detail: "high"
              }
            }
          ]
        }
      ],
      max_tokens: 4000,
      temperature: 0.0
    });

    const response = await Promise.race([visionPromise, timeoutPromise]);
    const extractedText = response.choices[0]?.message?.content;
    
    if (!extractedText) {
      throw new Error("No content returned from vision model");
    }

    // Check for hallucination indicators
    const lowerText = extractedText.toLowerCase();
    const hallucinationPhrases = [
      'the image shows',
      'the page shows',
      'this page contains',
      'there is a',
      'we can see',
      'the document displays',
      'visual elements include',
      'the layout features',
      'at the top',
      'on the left',
      'on the right'
    ];
    
    const hasHallucination = hallucinationPhrases.some(phrase => lowerText.includes(phrase));
    
    if (hasHallucination) {
      console.warn(`            ⚠️  Possible description detected in page ${pageNumber}, retrying...`);
      return await this.retryExtractionWithStrictPrompt(imageBuffer, pageNumber);
    }

    return extractedText.trim();
  }
  */

  /**
   * Retry extraction with even stricter prompt
   */
  private async retryExtractionWithStrictPrompt(imageBuffer: Buffer, pageNumber: number): Promise<string> {
    const base64Image = imageBuffer.toString('base64');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `TEXT TRANSCRIPTION ONLY.

Rules:
- Copy every word you see
- No descriptions
- No analysis
- No explanations
- Just the text

Output: Pure text transcription.`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Transcribe the text from this image. Output format: just the text.`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
                detail: "high"
              }
            }
          ]
        }
      ],
      max_tokens: 4000,
      temperature: 0.0
    });

    return response.choices[0]?.message?.content?.trim() || '';
  }

  private cleanAndNormalizeText(text: string): string {
    let cleanedText = text;
    
    // Remove excessive whitespace but preserve paragraph breaks
    cleanedText = cleanedText
      .replace(/[ \t]+/g, ' ') // Multiple spaces/tabs to single space
      .replace(/\n{3,}/g, '\n\n') // Multiple newlines to double newline
      .replace(/\n /g, '\n') // Remove space after newline
      .replace(/ \n/g, '\n') // Remove space before newline
      .trim();
    
    return cleanedText;
  }

  private validateTextQuality(text: string): boolean {
    if (text.length < 100) return false;
    
    const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
    const letterRatio = letterCount / text.length;
    
    if (letterRatio < 0.5) return false;
    
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const reasonableWords = words.filter(w => 
      w.length >= 2 && /[a-zA-Z]/.test(w)
    ).length;
    
    const wordQualityRatio = reasonableWords / Math.max(words.length, 1);
    return wordQualityRatio > 0.6;
  }

  async deleteDocumentFromVector(documentId: string): Promise<void> {
    await qdrantService.deleteByDocumentId(documentId);
  }

  /**
   * Generate semantic title for chunk
   */
  private generateSemanticTitle(content: string, metadata: any): string {
    if (metadata.title && metadata.title !== 'Untitled Section' && metadata.title.length > 10) {
      return metadata.title;
    }

    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length > 0) {
      const firstSentence = sentences[0].trim();
      if (firstSentence.length <= 80) {
        return firstSentence;
      } else {
        const truncated = firstSentence.substring(0, 77);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > 40 ? truncated.substring(0, lastSpace) : truncated) + '...';
      }
    }

    const productName = metadata.productName || metadata.filename || 'Product';
    const chunkType = metadata.chunkType || 'Information';
    return `${productName} - ${chunkType.charAt(0).toUpperCase() + chunkType.slice(1)}`;
  }

  /**
   * Extract robust keywords for hybrid search
   */
  private extractRobustKeywords(content: string, metadata: any): string[] {
    const keywords = new Set<string>();

    // From metadata
    if (metadata.keyTopics && Array.isArray(metadata.keyTopics)) {
      metadata.keyTopics.forEach((topic: string) => keywords.add(topic.toLowerCase()));
    }

    // From docMetadata
    if (metadata.docMetadata?.key_entities) {
      const entities = metadata.docMetadata.key_entities;
      
      if (entities.product_name) {
        keywords.add(entities.product_name.toLowerCase());
        entities.product_name.split(/\s+/).forEach((word: string) => {
          if (word.length > 2) keywords.add(word.toLowerCase());
        });
      }

      if (entities.materials) {
        Object.values(entities.materials).forEach((material: any) => {
          if (typeof material === 'string' && material.length > 2) {
            keywords.add(material.toLowerCase());
          }
        });
      }

      if (entities.pricing) {
        keywords.add('price');
        keywords.add(`₹${entities.pricing}`);
      }
    }

    // From categories
    if (metadata.docMetadata?.categories) {
      metadata.docMetadata.categories.forEach((cat: string) => keywords.add(cat.toLowerCase()));
    }

    // From chunk type
    const chunkType = metadata.chunkType;
    if (chunkType) {
      keywords.add(chunkType);
      const typeKeywords = this.getChunkTypeKeywords(chunkType);
      typeKeywords.forEach(kw => keywords.add(kw));
    }

    // From content
    const contentKeywords = this.extractContentKeywords(content);
    contentKeywords.forEach(kw => keywords.add(kw));

    return Array.from(keywords).slice(0, 20);
  }

  private getChunkTypeKeywords(chunkType: string): string[] {
    const typeKeywordMap: Record<string, string[]> = {
      'pricing': ['price', 'cost', 'mrp', 'offer', 'discount'],
      'specification': ['specs', 'dimensions', 'weight', 'size', 'technical'],
      'features': ['benefits', 'features', 'advantages', 'highlights'],
      'policies': ['warranty', 'return', 'exchange', 'refund', 'guarantee'],
      'technical': ['technical', 'specifications', 'details', 'construction']
    };

    return typeKeywordMap[chunkType] || [];
  }

  private extractContentKeywords(content: string): string[] {
    const keywords: string[] = [];
    
    // Capitalized words
    const capitalizedWords = content.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    capitalizedWords.forEach(word => {
      if (word.length > 3) keywords.push(word.toLowerCase());
    });

    // Measurements
    const measurements = content.match(/\d+(?:\.\d+)?\s*(?:cm|mm|m|kg|g|inch|₹|rs)/gi) || [];
    measurements.forEach(m => keywords.push(m.toLowerCase()));

    return keywords;
  }

  private generateDocumentSection(chunk: ProcessedChunk, allChunks: ProcessedChunk[], currentIndex: number): { parent: string; current: string; next?: string } {
    const metadata = chunk.metadata;
    const chunkType = metadata?.chunkType || 'general';

    let parent = 'Document Overview';
    if (metadata?.documentType === 'handbook') parent = 'Handbook';
    else if (metadata?.documentType === 'manual') parent = 'User Manual';
    else if (metadata?.documentType === 'technical') parent = 'Technical Documentation';
    else if (metadata?.documentType === 'product') parent = 'Product Information';

    const current = this.chunkTypeToSectionName(chunkType);

    let next: string | undefined;
    if (currentIndex < allChunks.length - 1) {
      const nextChunk = allChunks[currentIndex + 1];
      const nextType = nextChunk.metadata?.chunkType || 'general';
      next = this.chunkTypeToSectionName(nextType);
    }

    return { parent, current, next };
  }

  private chunkTypeToSectionName(chunkType: string): string {
    const sectionMap: Record<string, string> = {
      'introduction': 'Introduction',
      'specification': 'Specifications',
      'features': 'Features',
      'pricing': 'Pricing',
      'policies': 'Policies',
      'technical': 'Technical Details',
      'general': 'General Information'
    };

    return sectionMap[chunkType] || 'Information';
  }

  private generateSearchableText(content: string, metadata: any): string {
    const parts: string[] = [];

    parts.push(content);
    if (metadata.title) parts.push(metadata.title);
    if (metadata.summary) parts.push(metadata.summary);
    if (metadata.productName) parts.push(metadata.productName);
    if (metadata.filename) parts.push(metadata.filename);

    if (metadata.docMetadata?.key_entities) {
      const entities = metadata.docMetadata.key_entities;
      if (entities.product_name) parts.push(entities.product_name);
      if (entities.pricing) parts.push(`price ${entities.pricing}`);
    }

    if (metadata.docMetadata?.categories) {
      parts.push(...metadata.docMetadata.categories);
    }

    return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private findRelevantLinks(chunkContent: string, allLinks: ExtractedLink[], fullText: string): ExtractedLink[] {
    const relevantLinks: ExtractedLink[] = [];
    
    const chunkStart = fullText.indexOf(chunkContent);
    if (chunkStart === -1) {
      return allLinks.filter(link => 
        chunkContent.includes(link.url) ||
        (link.text && chunkContent.includes(link.text))
      );
    }
    
    const chunkEnd = chunkStart + chunkContent.length;
    
    for (const link of allLinks) {
      if (link.position && link.position.x !== undefined) {
        const linkPosition = link.position.x;
        
        if (linkPosition >= chunkStart - 200 && linkPosition <= chunkEnd + 200) {
          relevantLinks.push(link);
        }
      } else {
        if (chunkContent.includes(link.url) || (link.text && chunkContent.includes(link.text))) {
          relevantLinks.push(link);
        }
      }
    }
    
    return relevantLinks;
  }

  private extractLinksFromText(text: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
    const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
    
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
    
    while ((match = emailPattern.exec(text)) !== null) {
      links.push({
        url: `mailto:${match[1]}`,
        text: match[1],
        type: 'email',
        position: { x: match.index, y: 0 }
      });
    }
    
    return links;
  }

  private async extractLinksFromDocx(buffer: Buffer): Promise<ExtractedLink[]> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return this.extractLinksFromText(result.value);
    } catch (error) {
      console.warn('Failed to extract links from DOCX:', error);
      return [];
    }
  }

  private async extractLinksFromPdf(buffer: Buffer): Promise<ExtractedLink[]> {
    return new Promise((resolve) => {
      const pdfParser = new pdf2json();
      
      pdfParser.on("pdfParser_dataError", () => {
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
                        pageText += decodeURIComponent(run.T);
                      }
                    }
                  }
                }
              }
              
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
          resolve([]);
        }
      });
      
      pdfParser.parseBuffer(buffer);
    });
  }

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