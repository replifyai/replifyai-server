import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { storage } from "./storage.js";
import { documentProcessor } from "./features/upload/documentProcessor.js";
import { ragService } from "./features/rag/core/ragService.js";
import { vectorStore } from "./features/rag/providers/index.js";
import { batchUploadService } from "./features/upload/batchUploadService.js";
import { insertSettingSchema } from "../shared/schema.js";
import { env } from "./env.js";
import { generateQuiz, evaluateQuiz } from './quiz/index.js';
import { qaIngestionService } from "./features/upload/qaIngestionService.js";
import { WebSocketHandler } from './features/realtime/websocketHandler.js';
import { customerService } from './features/customer/customerService.js';
import axios from 'axios';

// Extend global type for Slack event deduplication
declare global {
  var processedEvents: Set<string> | undefined;
}

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Only PDF, DOCX, TXT, and Markdown files are allowed.'));
    }
  }
});

export async function registerRoutes(app: Express): Promise<Server> {
  
  // Get all documents
  app.get("/api/documents", async (req, res) => {
    try {
      const documents = await storage.getAllDocuments();
      res.json(documents);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Upload document from URL
  app.post("/api/documents/upload-url", async (req, res) => {
    try {
      const { url, name } = req.body;
      
      if (!url) {
        return res.status(400).json({ message: "URL is required" });
      }

      // Validate URL format
      let validUrl: URL;
      try {
        validUrl = new URL(url);
      } catch {
        return res.status(400).json({ message: "Invalid URL format" });
      }

      // Convert Google Drive URLs to direct download format
      let downloadUrl = url;
      let isGoogleDrive = false;
      
      if (url.includes('drive.google.com')) {
        const googleDriveId = extractGoogleDriveId(url);
        if (!googleDriveId) {
          return res.status(400).json({ message: "Invalid Google Drive URL format. Please use a shareable Google Drive link." });
        }
        downloadUrl = `https://drive.google.com/uc?export=download&id=${googleDriveId}`;
        isGoogleDrive = true;
        console.log(`Converted Google Drive URL: ${url} -> ${downloadUrl}`);
      } else {
        // Check if URL ends with .pdf, .md or has PDF/markdown content type for non-Google Drive URLs
        const urlLower = url.toLowerCase();
        const isPdf = urlLower.includes('.pdf') || urlLower.includes('pdf');
        const isMarkdown = urlLower.includes('.md') || urlLower.includes('.markdown');
        
        if (!isPdf && !isMarkdown) {
          return res.status(400).json({ message: "URL must point to a PDF or Markdown (.md) file" });
        }
      }

      console.log(`Downloading file from URL: ${downloadUrl}`);

      // Download the file from URL
      const response = await fetch(downloadUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      if (!response.ok) {
        if (isGoogleDrive && response.status === 403) {
          return res.status(400).json({ 
            message: "Google Drive file is not publicly accessible. Please ensure the file is shared with 'Anyone with the link' permission." 
          });
        }
        return res.status(400).json({ message: `Failed to download file: ${response.statusText}` });
      }

      const contentType = response.headers.get('content-type');
      
      // For Google Drive, we might get HTML if the file is not publicly accessible
      if (isGoogleDrive && contentType && contentType.includes('text/html')) {
        return res.status(400).json({ 
          message: "Google Drive file is not publicly accessible or requires authentication. Please ensure the file is shared with 'Anyone with the link' permission." 
        });
      }
      
      // Validate content type for non-Google Drive URLs
      if (!isGoogleDrive && contentType) {
        const isPdfContent = contentType.includes('pdf');
        const isMarkdownContent = contentType.includes('text/markdown') || contentType.includes('text/plain');
        
        if (!isPdfContent && !isMarkdownContent) {
          return res.status(400).json({ message: "URL does not point to a PDF or Markdown file" });
        }
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const fileSize = buffer.length;

      if (fileSize > 10 * 1024 * 1024) {
        return res.status(400).json({ message: "File is too large (max 10MB)" });
      }

      // Determine file type and validate accordingly
      const urlLower = url.toLowerCase();
      const isPdfUrl = urlLower.includes('.pdf') || urlLower.includes('pdf');
      const isMarkdownUrl = urlLower.includes('.md') || urlLower.includes('.markdown');
      
      let fileType = 'pdf'; // default for Google Drive
      let isValidFile = false;
      
      if (isPdfUrl || (!isMarkdownUrl && !isPdfUrl)) {
        // Check if it's a PDF
        if (isPdfBuffer(buffer)) {
          fileType = 'pdf';
          isValidFile = true;
        }
      }
      
      if (isMarkdownUrl || (!isPdfUrl && !isMarkdownUrl)) {
        // Check if it's a markdown file (text content)
        const textContent = buffer.toString('utf-8');
        if (textContent.length > 0 && !isPdfBuffer(buffer)) {
          fileType = 'md';
          isValidFile = true;
        }
      }
      
      if (!isValidFile) {
        return res.status(400).json({ message: "Downloaded file is not a valid PDF or Markdown file" });
      }

      // Extract filename from URL or use provided name
      let originalName = name;
      if (!originalName) {
        if (isGoogleDrive) {
          originalName = fileType === 'md' ? 'google-drive-document.md' : 'google-drive-document.pdf';
        } else {
          const urlPath = validUrl.pathname;
          const urlFilename = urlPath.split('/').pop() || `document.${fileType}`;
          originalName = urlFilename;
        }
      }

      console.log(`Downloaded ${fileType.toUpperCase()}: ${originalName}, Size: ${fileSize} bytes`);

      // Create document record with URL reference
      const document = await storage.createDocument({
        filename: `${Date.now()}_${originalName}`,
        originalName: originalName,
        fileType: fileType,
        fileSize: fileSize,
        status: "uploading",
        metadata: { 
          sourceUrl: url, // Store original URL, not the converted one
          downloadUrl: downloadUrl, // Store the actual download URL used
          uploadType: 'url',
          isGoogleDrive: isGoogleDrive,
          contentType: contentType || (fileType === 'pdf' ? 'application/pdf' : 'text/markdown')
        },
      });

      try {
        // Process document with URL reference
        await documentProcessor.processDocument(document, buffer, url);
        
        // Get the updated document with final status
        const processedDocument = await storage.getDocument(document.id);
        if (vectorStore.name !== 'google') {
          await storage.deleteDocument(document.id);
        }
        res.json(processedDocument);
      } catch (processingError) {
        console.error(`Failed to process document ${document.id}:`, processingError);
        res.status(500).json({ 
          message: "Document upload succeeded but processing failed", 
          error: (processingError as Error).message,
          document 
        });
      }
    } catch (error) {
      console.error('File URL upload error:', error);
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Upload document (file)
  app.post("/api/documents/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { originalname, mimetype, size, buffer } = req.file;
      
      // Determine file type
      let fileType = 'unknown';
      if (mimetype === 'application/pdf') fileType = 'pdf';
      else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') fileType = 'docx';
      else if (mimetype === 'text/plain') fileType = 'txt';
      else if (mimetype === 'text/markdown') fileType = 'md';

      // Create document record
      const document = await storage.createDocument({
        filename: `${Date.now()}_${originalname}`,
        originalName: originalname,
        fileType,
        fileSize: size,
        status: "uploading",
        metadata: { 
          mimetype,
          uploadType: 'file'
        },
      });

      try {
        // Process document synchronously with timeout
        await Promise.race([
          documentProcessor.processDocument(document, buffer),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Document processing timeout')), env.API_TIMEOUT)
          )
        ]);
        
        // Get the updated document with final status
        const processedDocument = await storage.getDocument(document.id);
        if (vectorStore.name !== 'google') {
          await storage.deleteDocument(document.id);
        }
        res.json(processedDocument);
      } catch (processingError) {
        // If processing fails, return error with document info
        console.error(`Failed to process document ${document.id}:`, processingError);
        res.status(500).json({ 
          message: "Document upload succeeded but processing failed", 
          error: (processingError as Error).message,
          document 
        });
      }
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Delete document
  app.delete("/api/documents/:id", async (req, res) => {
    try {
      const id = req.params.id;
      
      // Delete from vector database
      await documentProcessor.deleteDocumentFromVector(id);
      
      // Delete from storage
      await storage.deleteDocument(parseInt(id, 10));
      
      res.json({ message: "Document deleted successfully" });
    } catch (error) {
      console.error('Document deletion error:', (error as Error).message);
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Chat endpoint
  app.post("/api/chat", async (req, res) => {
    try {
      const { 
        message, 
        retrievalCount, 
        similarityThreshold,
        productName = "",
        companyContext,
        // New: Enhanced RAG options
        useEnhancedRAG = true,
        useReranking = false,
        useCompression = false,    // ⚡ Default: false for better performance
        useMultiQuery = true,
        maxQueries = 2,            // ⚡ Default: 2 (was 5) for better performance
        finalChunkCount = 12,      // ⚡ Default: 12 (was 10) for balanced mode
        performanceMode,           // ⚡ New: 'fast' | 'balanced' | 'accurate'
        formatAsMarkdown = true,  // New: Format response in Markdown (true) or structured plain text (false)
      } = req.body;
      
      if (!message) {
        return res.status(400).json({ message: "Message is required" });
      }

      // Use enhanced RAG if requested
      if (useEnhancedRAG) {
        // ⚡ Apply performance mode if specified
        let config: any = {
          retrievalCount: retrievalCount || 10,
          similarityThreshold: similarityThreshold || 0.5,
          productName: productName,
          companyContext: companyContext,
          useReranking,
          useCompression,
          useMultiQuery,
          maxQueries,
          finalChunkCount,
          formatAsMarkdown,
        };

        // Apply performance preset if specified
        if (performanceMode) {
          const { RAGConfig } = await import('./config/ragConfig.js');
          const preset = RAGConfig.get(performanceMode as 'fast' | 'balanced' | 'accurate');
          config = { ...preset, ...config }; // User options override preset
        }

        const result = await ragService.queryDocumentsEnhanced(message, config);
        return res.json(result);
      }

      // Legacy RAG
      const result = await ragService.queryDocuments(message, {
        retrievalCount: retrievalCount || 10,
        similarityThreshold: similarityThreshold ||  0.5,
        productName: productName,
        companyContext: companyContext // Optional: { companyName, companyDescription, productCategories }
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Customer-facing ecommerce chatbot endpoint
  app.post("/api/customer/query", async (req, res) => {
    try {
      const { 
        query, 
        category = "", 
        userId, 
        sessionId,
        retrievalCount = 20,
        similarityThreshold = 0.5 
      } = req.body;
      
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ 
          message: "Query is required and must be a non-empty string",
          error: "INVALID_QUERY"
        });
      }

      // Validate query length
      if (query.length > 1000) {
        return res.status(400).json({ 
          message: "Query is too long (max 1000 characters)",
          error: "QUERY_TOO_LONG"
        });
      }

      console.log(`🛍️ Customer query received: "${query}" from user: ${userId || 'anonymous'}`);

      const result = await customerService.processCustomerQuery(query, {
        category,
        userId,
        sessionId,
        retrievalCount,
        similarityThreshold
      });

      // Add response metadata
      const responseWithMetadata = {
        ...result,
        metadata: {
          timestamp: new Date().toISOString(),
          userId: userId || null,
          sessionId: sessionId || null,
          processingTime: Date.now(),
          apiVersion: "1.0"
        }
      };

      res.json(responseWithMetadata);
    } catch (error) {
      console.error('Customer query error:', error);
      res.status(500).json({ 
        message: "Sorry, I'm having trouble processing your request. Please try again.",
        error: "PROCESSING_ERROR",
        details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
      });
    }
  });

  // Ingest QA pairs (manual text answers)
  app.post("/api/qa-pairs", async (req, res) => {
    try {
      const { qaPairs, filename } = req.body;

      if (!qaPairs || !Array.isArray(qaPairs) || qaPairs.length === 0) {
        return res.status(400).json({ message: "qaPairs is required and must be a non-empty array" });
      }

      // Validate minimal shape early
      for (let i = 0; i < qaPairs.length; i++) {
        const p = qaPairs[i];
        if (!p || !p.query || !p.answer || !p.productName) {
          return res.status(400).json({ message: `qaPairs[${i}] must include query, answer, and productName` });
        }
      }

      const result = await qaIngestionService.ingestQAPairs(qaPairs, { filename });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ message: (error as Error).message });
    }
  });

  // Get chat history
  app.get("/api/chat/history", async (req, res) => {
    try {
      const messages = await storage.getAllMessages();
      res.json(messages);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });




  app.post("/api/settings", async (req, res) => {
    try {
      const validatedSetting = insertSettingSchema.parse(req.body);
      const setting = await storage.setSetting(validatedSetting);
      res.json(setting);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  });

  // Batch upload from URLs
  app.post("/api/documents/batch-upload-urls", async (req, res) => {
    try {
      const { urls, concurrency, retryAttempts } = req.body;
      
      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ message: "URLs array is required and cannot be empty" });
      }

      if (urls.length > 100) {
        return res.status(400).json({ message: "Maximum 100 URLs allowed per batch" });
      }

      console.log(`Creating batch upload job for ${urls.length} URLs`);

      // Validate URLs
      const items = urls.map((item: any, index: number) => {
        if (typeof item === 'string') {
          return { url: item };
        } else if (item.url) {
          return { url: item.url, name: item.name };
        } else {
          throw new Error(`Invalid URL format at index ${index}`);
        }
      });

      // Create batch job
      const jobId = await batchUploadService.createBatchJob(items, {
        concurrency: concurrency || 3,
        retryAttempts: retryAttempts || 2
      });

      res.json({
        jobId,
        message: `Batch upload job created with ${urls.length} URLs`,
        totalItems: urls.length,
        status: 'pending'
      });

    } catch (error) {
      console.error('Batch URL upload error:', error);
      res.status(500).json({ message: (error as Error).message });
    }
  });




  // Generate a quiz
  app.post("/api/quiz", async (req, res) => {
    try {
      const quiz = await generateQuiz(req.body);
      res.json(quiz);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Evaluate quiz answers
  app.post("/api/quiz/evaluate", async (req, res) => {
    try {
      const result = evaluateQuiz(req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });


  const httpServer = createServer(app);
  // Initialize WebSocket handler for realtime transcription
  new WebSocketHandler(httpServer);
  return httpServer;
}

// Helper function to extract Google Drive file ID from various URL formats
function extractGoogleDriveId(url: string): string | null {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9-_]+)/,  // /file/d/FILE_ID
    /[?&]id=([a-zA-Z0-9-_]+)/,      // ?id=FILE_ID or &id=FILE_ID
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  return null;
}

// Helper function to check if buffer contains a PDF
function isPdfBuffer(buffer: Buffer): boolean {
  // PDF files start with %PDF
  return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === '%PDF';
}
