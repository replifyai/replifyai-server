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

export interface ChunkingStrategy {
  name: string;
  minChunkSize: number;
  maxChunkSize: number;
  overlapSize: number;
  preserveStructure: boolean;
}

export class DocumentProcessor {
  private defaultStrategy: ChunkingStrategy = {
    name: "semantic",
    minChunkSize: 200,
    maxChunkSize: 800,
    overlapSize: 100,
    preserveStructure: true
  };

  private productDocStrategy: ChunkingStrategy = {
    name: "product-focused",
    minChunkSize: 150,
    maxChunkSize: 600,
    overlapSize: 80,
    preserveStructure: true
  };

  async processDocument(document: Document, fileBuffer: Buffer): Promise<void> {
    try {
      // Update status to processing
      await storage.updateDocumentStatus(document.id, "processing");

      // Extract text based on file type
      const text = await this.extractText(fileBuffer, document.fileType);
      
      console.log(`Extracted text length: ${text.length} characters`);
      
      // Extract document metadata
      const docMetadata = await extractDocumentMetadata(text, document.originalName);

      // Determine chunking strategy based on document type
      const strategy = this.determineChunkingStrategy(document.originalName, text);
      console.log(`Using strategy: ${strategy.name}`);

      // Create intelligent chunks
      const chunks = await this.createIntelligentChunks(text, document.originalName, strategy);
      console.log(`Created ${chunks.length} chunks`);

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
          metadata: {
            ...chunk.metadata,
            strategy: strategy.name,
            docMetadata
          },
        });

        processedChunks.push({
          id: savedChunk.id,
          vector: embedding,
          payload: {
            documentId: document.id,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            filename: document.originalName,
            metadata: {
              ...chunk.metadata,
              strategy: strategy.name,
              docMetadata
            },
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

  private determineChunkingStrategy(filename: string, text: string): ChunkingStrategy {
    const lowerFilename = filename.toLowerCase();
    const lowerText = text.toLowerCase();

    // Check if it's a product document
    const productKeywords = [
      'product', 'specification', 'datasheet', 'manual', 'guide', 
      'catalog', 'brochure', 'feature', 'benefit', 'price', 'model',
      'technical', 'installation', 'setup', 'configuration'
    ];

    const isProductDoc = productKeywords.some(keyword => 
      lowerFilename.includes(keyword) || lowerText.includes(keyword)
    );

    return isProductDoc ? this.productDocStrategy : this.defaultStrategy;
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
                    text += '\n\n'; // Add page breaks
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

  private async createIntelligentChunks(
    text: string, 
    filename: string, 
    strategy: ChunkingStrategy
  ): Promise<ProcessedChunk[]> {
    const chunks: ProcessedChunk[] = [];
    
    console.log(`Input text length: ${text.length}`);
    console.log(`Strategy: ${strategy.name}, maxChunkSize: ${strategy.maxChunkSize}`);
    
    // Always try structure-aware chunking first
    const structuredSections = this.identifyDocumentStructure(text);
    console.log(`Found ${structuredSections.length} sections`);
    
    if (strategy.preserveStructure && structuredSections.length > 1) {
      // Process each section separately
      let globalChunkIndex = 0;
      
      for (const section of structuredSections) {
        console.log(`Processing section: ${section.title} (${section.content.length} chars)`);
        const sectionChunks = await this.chunkSection(
          section, 
          filename, 
          strategy, 
          globalChunkIndex
        );
        console.log(`Section produced ${sectionChunks.length} chunks`);
        chunks.push(...sectionChunks);
        globalChunkIndex += sectionChunks.length;
      }
    } else {
      // Force chunking even with single section
      console.log("Using semantic chunking fallback");
      const semanticChunks = await this.createSemanticChunks(text, filename, strategy);
      chunks.push(...semanticChunks);
    }

    console.log(`Final chunk count: ${chunks.length}`);
    return chunks;
  }

  private identifyDocumentStructure(text: string): Array<{
    title: string;
    content: string;
    type: 'heading' | 'section' | 'list' | 'paragraph' | 'table' | 'product-spec';
    level: number;
  }> {
    const sections = [];
    
    // Enhanced patterns for product documents
    const productSectionPatterns = [
      /product\s+name/i,
      /product\s+specification/i,
      /technical\s+specification/i,
      /features/i,
      /benefits/i,
      /dimensions/i,
      /material/i,
      /color/i,
      /size/i,
      /price/i,
      /mrp/i,
      /return\s+policy/i,
      /exchange\s+policy/i,
      /use\s+case/i,
      /target\s+audience/i,
      /installation/i,
      /setup/i,
      /configuration/i
    ];

    // Split text into potential sections using multiple delimiters
    const lines = text.split(/[\n\r]+/).filter(line => line.trim());
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    
    // Try to identify product document sections
    if (this.isProductDocument(text)) {
      return this.identifyProductSections(text, paragraphs);
    }
    
    // Fallback to general structure detection
    let currentSection = {
      title: 'Introduction',
      content: '',
      type: 'paragraph' as const,
      level: 1
    };

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (this.isHeading(trimmedLine)) {
        // Save current section if it has content
        if (currentSection.content.trim()) {
          sections.push({ ...currentSection });
        }
        
        // Start new section
        currentSection = {
          title: this.cleanHeading(trimmedLine),
          content: '',
          type: 'paragraph' as const,
          level: this.getHeadingLevel(trimmedLine)
        };
      } else {
        currentSection.content += trimmedLine + ' ';
      }
    }

    // Add final section
    if (currentSection.content.trim()) {
      sections.push(currentSection);
    }

    // If we still only have one section and it's large, force split it
    if (sections.length === 1 && sections[0].content.length > 1000) {
      return this.forceSplitLargeSection(sections[0]);
    }

    return sections.length > 1 ? sections : [{ 
      title: 'Document', 
      content: text, 
      type: 'paragraph' as const, 
      level: 1 
    }];
  }

  private isProductDocument(text: string): boolean {
    const productIndicators = [
      'product name', 'product specification', 'mrp', 'price', 'sku',
      'features', 'benefits', 'material', 'dimensions', 'weight',
      'return policy', 'exchange policy', 'warranty', 'hsn',
      'technical specification', 'color', 'size', 'model'
    ];
    
    const lowerText = text.toLowerCase();
    return productIndicators.some(indicator => lowerText.includes(indicator));
  }

  private identifyProductSections(text: string, paragraphs: string[]): Array<{
    title: string;
    content: string;
    type: 'heading' | 'section' | 'list' | 'paragraph' | 'table' | 'product-spec';
    level: number;
  }> {
    const sections = [];
    
    // Define section patterns for product documents
    const sectionPatterns = [
      { pattern: /product\s+name|product\s+specification/i, title: 'Product Specification', type: 'product-spec' },
      { pattern: /technical\s+specification|material|dimensions|weight/i, title: 'Technical Specifications', type: 'product-spec' },
      { pattern: /features|benefits|advantages/i, title: 'Features & Benefits', type: 'product-spec' },
      { pattern: /use\s+case|target\s+audience|suitable\s+for/i, title: 'Use Cases', type: 'product-spec' },
      { pattern: /return\s+policy|exchange\s+policy|warranty/i, title: 'Policies', type: 'product-spec' },
      { pattern: /price|mrp|cost|pricing/i, title: 'Pricing', type: 'product-spec' },
    ];

    let currentSection = null;
    let unmatchedContent = '';

    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      if (!trimmedPara) continue;

      let matched = false;
      
      // Check if this paragraph starts a new section
      for (const { pattern, title, type } of sectionPatterns) {
        if (pattern.test(trimmedPara)) {
          // Save previous section
          if (currentSection && currentSection.content.trim()) {
            sections.push(currentSection);
          }
          
          // Save any unmatched content as general section
          if (unmatchedContent.trim()) {
            sections.push({
              title: 'Additional Information',
              content: unmatchedContent.trim(),
              type: 'paragraph' as const,
              level: 2
            });
            unmatchedContent = '';
          }

          // Start new section
          currentSection = {
            title,
            content: trimmedPara,
            type: type as any,
            level: 2
          };
          matched = true;
          break;
        }
      }

      if (!matched) {
        if (currentSection) {
          currentSection.content += '\n' + trimmedPara;
        } else {
          unmatchedContent += '\n' + trimmedPara;
        }
      }
    }

    // Add final section
    if (currentSection && currentSection.content.trim()) {
      sections.push(currentSection);
    }

    // Add any remaining unmatched content
    if (unmatchedContent.trim()) {
      sections.push({
        title: 'Additional Information',
        content: unmatchedContent.trim(),
        type: 'paragraph' as const,
        level: 2
      });
    }

    // If no sections were identified, create artificial sections
    if (sections.length === 0) {
      return this.createArtificialSections(text);
    }

    return sections;
  }

  private createArtificialSections(text: string): Array<{
    title: string;
    content: string;
    type: 'heading' | 'section' | 'list' | 'paragraph' | 'table' | 'product-spec';
    level: number;
  }> {
    const sections = [];
    const sentences = this.splitIntoSentences(text);
    const targetSectionSize = 3; // sentences per section
    
    for (let i = 0; i < sentences.length; i += targetSectionSize) {
      const sectionSentences = sentences.slice(i, i + targetSectionSize);
      const content = sectionSentences.join(' ').trim();
      
      if (content) {
        sections.push({
          title: `Section ${Math.floor(i / targetSectionSize) + 1}`,
          content,
          type: 'paragraph' as const,
          level: 2
        });
      }
    }

    return sections;
  }

  private forceSplitLargeSection(section: any): Array<{
    title: string;
    content: string;
    type: 'heading' | 'section' | 'list' | 'paragraph' | 'table' | 'product-spec';
    level: number;
  }> {
    const maxSectionSize = 800;
    const sections = [];
    const content = section.content;
    
    // Split by sentences and group them
    const sentences = this.splitIntoSentences(content);
    let currentContent = '';
    let sectionIndex = 1;
    
    for (const sentence of sentences) {
      if (currentContent.length + sentence.length > maxSectionSize && currentContent) {
        sections.push({
          title: `${section.title} (Part ${sectionIndex})`,
          content: currentContent.trim(),
          type: section.type,
          level: section.level
        });
        currentContent = sentence;
        sectionIndex++;
      } else {
        currentContent += (currentContent ? ' ' : '') + sentence;
      }
    }
    
    // Add final section
    if (currentContent.trim()) {
      sections.push({
        title: `${section.title}${sectionIndex > 1 ? ` (Part ${sectionIndex})` : ''}`,
        content: currentContent.trim(),
        type: section.type,
        level: section.level
      });
    }
    
    return sections;
  }

  private isHeading(line: string): boolean {
    // Enhanced heading detection
    return (
      /^#{1,6}\s/.test(line) || // Markdown headers
      /^[A-Z][A-Z\s]{5,}$/.test(line) || // ALL CAPS
      /^\d+\.\s[A-Z]/.test(line) || // Numbered sections
      /^[A-Z][a-z\s]+:$/.test(line) || // Title with colon
      /^[IVX]+\.\s/.test(line) || // Roman numerals
      /^[A-Z][a-z\s]+-$/.test(line) || // Title with dash
      /^Product\s+/i.test(line) || // Product headings
      /^Technical\s+/i.test(line) || // Technical headings
      /^Features/i.test(line) || // Feature headings
      /^Benefits/i.test(line) // Benefit headings
    );
  }

  private cleanHeading(line: string): string {
    return line
      .replace(/^#+\s*/, '') // Remove markdown #
      .replace(/^\d+\.\s*/, '') // Remove numbers
      .replace(/^[IVX]+\.\s*/, '') // Remove roman numerals
      .replace(/:$/, '') // Remove trailing colon
      .replace(/-$/, '') // Remove trailing dash
      .trim();
  }

  private getHeadingLevel(line: string): number {
    if (/^#\s/.test(line)) return 1;
    if (/^##\s/.test(line)) return 2;
    if (/^###\s/.test(line)) return 3;
    if (/^\d+\.\s/.test(line)) return 2;
    if (/^[A-Z][A-Z\s]{5,}$/.test(line)) return 1;
    return 2;
  }

  private isList(line: string): boolean {
    return /^[\-\*\+]\s/.test(line) || /^\d+\.\s/.test(line) || /^[a-z]\)\s/.test(line);
  }

  private isTable(line: string): boolean {
    return line.includes('|') || /\t/.test(line);
  }

  private async chunkSection(
    section: any, 
    filename: string, 
    strategy: ChunkingStrategy, 
    startIndex: number
  ): Promise<ProcessedChunk[]> {
    const chunks: ProcessedChunk[] = [];
    const content = section.content.trim();
    
    console.log(`Chunking section "${section.title}": ${content.length} chars, maxSize: ${strategy.maxChunkSize}`);
    
    if (content.length <= strategy.maxChunkSize) {
      // Section fits in one chunk
      chunks.push({
        content: content,
        chunkIndex: startIndex,
        metadata: {
          filename,
          sectionTitle: section.title,
          sectionType: section.type,
          level: section.level,
          chunkLength: content.length,
          isComplete: true,
          topics: this.extractTopics(content),
          keyTerms: this.extractKeyTerms(content)
        }
      });
    } else {
      // Split section into smaller chunks
      console.log(`Section too large, splitting...`);
      const sectionChunks = await this.createSemanticChunks(content, filename, strategy);
      sectionChunks.forEach((chunk, index) => {
        chunks.push({
          ...chunk,
          chunkIndex: startIndex + index,
          metadata: {
            ...chunk.metadata,
            sectionTitle: section.title,
            sectionType: section.type,
            level: section.level,
            isComplete: false
          }
        });
      });
    }

    return chunks;
  }

  private async createSemanticChunks(
    text: string, 
    filename: string, 
    strategy: ChunkingStrategy
  ): Promise<ProcessedChunk[]> {
    const chunks: ProcessedChunk[] = [];
    
    console.log(`Creating semantic chunks from ${text.length} characters`);
    
    // Enhanced sentence splitting for product documents
    const sentences = this.splitIntoSentences(text);
    console.log(`Split into ${sentences.length} sentences`);
    
    let currentChunk = "";
    let chunkIndex = 0;
    let sentenceStart = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim();
      if (!sentence) continue;

      const potentialChunk = currentChunk + (currentChunk ? ' ' : '') + sentence;
      
      console.log(`Sentence ${i}: Adding "${sentence.substring(0, 50)}..." (${sentence.length} chars)`);
      console.log(`Current chunk length: ${currentChunk.length}, potential: ${potentialChunk.length}, max: ${strategy.maxChunkSize}`);
      
      // More aggressive chunking - create chunk if we exceed max size OR have good content
      if ((potentialChunk.length > strategy.maxChunkSize && currentChunk.length >= strategy.minChunkSize) ||
          (potentialChunk.length >= strategy.maxChunkSize * 0.8 && this.isGoodChunkBoundary(sentence))) {
        
        console.log(`Creating chunk ${chunkIndex} with ${currentChunk.length} characters`);
        
        // Create chunk
        chunks.push({
          content: currentChunk.trim(),
          chunkIndex,
          metadata: {
            filename,
            sentenceStart,
            sentenceEnd: i - 1,
            chunkLength: currentChunk.length,
            topics: this.extractTopics(currentChunk),
            keyTerms: this.extractKeyTerms(currentChunk)
          }
        });

        // Start new chunk with overlap
        const overlapText = this.createOverlap(currentChunk, strategy.overlapSize);
        currentChunk = overlapText + (overlapText ? ' ' : '') + sentence;
        chunkIndex++;
        sentenceStart = Math.max(0, i - Math.floor(strategy.overlapSize / 50));
      } else {
        currentChunk = potentialChunk;
      }
    }

    // Add final chunk - be more lenient with minimum size
    if (currentChunk.trim() && currentChunk.length >= Math.min(strategy.minChunkSize / 2, 100)) {
      console.log(`Creating final chunk ${chunkIndex} with ${currentChunk.length} characters`);
      
      chunks.push({
        content: currentChunk.trim(),
        chunkIndex,
        metadata: {
          filename,
          sentenceStart,
          sentenceEnd: sentences.length - 1,
          chunkLength: currentChunk.length,
          topics: this.extractTopics(currentChunk),
          keyTerms: this.extractKeyTerms(currentChunk)
        }
      });
    }

    // Fallback: if we still have no chunks, force create at least one
    if (chunks.length === 0 && text.trim()) {
      console.log("No chunks created, forcing single chunk");
      chunks.push({
        content: text.trim(),
        chunkIndex: 0,
        metadata: {
          filename,
          sentenceStart: 0,
          sentenceEnd: sentences.length - 1,
          chunkLength: text.length,
          topics: this.extractTopics(text),
          keyTerms: this.extractKeyTerms(text),
          forced: true
        }
      });
    }

    console.log(`Final semantic chunks: ${chunks.length}`);
    return chunks;
  }

  private isGoodChunkBoundary(sentence: string): boolean {
    // Check if this sentence is a good place to end a chunk
    const boundaryIndicators = [
      /\.$/, // Ends with period
      /\!$/, // Ends with exclamation
      /\?$/, // Ends with question
      /policy/i, // Ends a policy section
      /specification/i, // Ends a spec section
      /features/i, // Ends a features section
    ];
    
    return boundaryIndicators.some(pattern => pattern.test(sentence));
  }

  private splitIntoSentences(text: string): string[] {
    // Enhanced sentence splitting that handles product document formats better
    const sentences = text
      // First split on period followed by space and capital letter
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      // Also split on common product document patterns
      .flatMap(sentence => 
        sentence.split(/(?<=\.)\s*(?=(?:Product|Material|Color|Size|Price|MRP|Features|Benefits|Return|Exchange|Technical|Specification|Suitable|Target|Available|Dimensions|Weight|HSN|Tax)\b)/i)
      )
      // Split on hyphen followed by text (common in product docs)
      .flatMap(sentence => 
        sentence.split(/(?<=-)\s+(?=[A-Z][a-z])/))
      .filter(s => s.trim().length > 0);
    
    return sentences;
  }

  private createOverlap(text: string, overlapSize: number): string {
    if (overlapSize <= 0) return '';
    
    const words = text.split(' ');
    const overlapWords = Math.min(Math.floor(overlapSize / 5), words.length, 20); // Limit overlap
    return words.slice(-overlapWords).join(' ');
  }

  private extractTopics(text: string): string[] {
    const topics = [];
    const lowerText = text.toLowerCase();
    
    // Product-specific topic patterns
    const productTopics = [
      { pattern: /product\s+specification|product\s+name/i, topic: 'Product Specification' },
      { pattern: /technical\s+specification|material|dimensions/i, topic: 'Technical Specifications' },
      { pattern: /features|benefits/i, topic: 'Features & Benefits' },
      { pattern: /price|mrp|cost/i, topic: 'Pricing' },
      { pattern: /return\s+policy|exchange/i, topic: 'Policies' },
      { pattern: /use\s+case|target\s+audience/i, topic: 'Use Cases' },
      { pattern: /color|size|variant/i, topic: 'Variants' },
      { pattern: /installation|setup|configuration/i, topic: 'Setup' },
    ];

    for (const { pattern, topic } of productTopics) {
      if (pattern.test(text)) {
        topics.push(topic);
      }
    }

    // Extract capitalized phrases (potential topics)
    const capitalizedPhrases = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    topics.push(...capitalizedPhrases.slice(0, 2));

    return [...new Set(topics)].slice(0, 5);
  }

  private extractKeyTerms(text: string): string[] {
    const keyTerms = [];
    
    // Product-specific key terms
    const productTerms = text.match(/\b(?:SKU|MRP|HSN|GST|warranty|exchange|return|specification|material|dimension|weight|color|size|model|version|series|capacity|power|voltage|frequency|temperature|pressure)\b/gi) || [];
    keyTerms.push(...productTerms);

    // Technical terms with numbers
    const technicalTerms = text.match(/\b[A-Za-z]+\d+[A-Za-z]*\b/g) || [];
    keyTerms.push(...technicalTerms);

    // Terms in quotes or parentheses
    const quotedTerms = text.match(/["']([^"']+)["']|\(([^)]+)\)/g) || [];
    keyTerms.push(...quotedTerms.map(term => term.replace(/[\"'()]/g, '')));

    // Brand names and product names (capitalized multi-word terms)
    const brandNames = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    keyTerms.push(...brandNames.filter(term => term.length > 3));

    return [...new Set(keyTerms.map(term => term.toLowerCase()))].slice(0, 10);
  }

  async deleteDocumentFromVector(documentId: number): Promise<void> {
    await qdrantService.deleteByDocumentId(documentId);
  }
}

export const documentProcessor = new DocumentProcessor();