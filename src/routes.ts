import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { storage } from "./storage.js";
import { documentProcessor } from "./services/documentProcessor.js";
// import { documentProcessor } from "./services/dp1.js";
import { ragService } from "./services/ragService.js";
import { batchUploadService } from "./services/batchUploadService.js";
import { insertSettingSchema } from "../shared/schema.js";
import { env } from "./env.js";
import { generateQuiz, evaluateQuiz } from './quiz/index.js';
import { qaIngestionService } from "./services/qaIngestionService.js";
import { WebSocketHandler } from './services/websocketHandler.js';
import { audioInsightsService } from './services/audioInsightsService.js';
import { createClient } from '@deepgram/sdk';

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Only PDF, DOCX, and TXT files are allowed.'));
    }
  }
});

// Audio upload configuration
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for audio files
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a',
      'audio/ogg', 'audio/webm', 'audio/flac', 'audio/aac'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio file type. Supported formats: WAV, MP3, MP4, M4A, OGG, WEBM, FLAC, AAC'));
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
        // Check if URL ends with .pdf or has PDF content type for non-Google Drive URLs
        if (!url.toLowerCase().includes('.pdf') && !url.toLowerCase().includes('pdf')) {
          return res.status(400).json({ message: "URL must point to a PDF file" });
        }
      }

      console.log(`Downloading PDF from URL: ${downloadUrl}`);

      // Download the PDF from URL
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
        return res.status(400).json({ message: `Failed to download PDF: ${response.statusText}` });
      }

      const contentType = response.headers.get('content-type');
      
      // For Google Drive, we might get HTML if the file is not publicly accessible
      if (isGoogleDrive && contentType && contentType.includes('text/html')) {
        return res.status(400).json({ 
          message: "Google Drive file is not publicly accessible or requires authentication. Please ensure the file is shared with 'Anyone with the link' permission." 
        });
      }
      
      // Validate content type for non-Google Drive URLs
      if (!isGoogleDrive && contentType && !contentType.includes('pdf')) {
        return res.status(400).json({ message: "URL does not point to a PDF file" });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const fileSize = buffer.length;

      if (fileSize > 10 * 1024 * 1024) {
        return res.status(400).json({ message: "PDF file is too large (max 10MB)" });
      }

      // Validate that we actually got a PDF by checking the file header
      if (!isPdfBuffer(buffer)) {
        return res.status(400).json({ message: "Downloaded file is not a valid PDF" });
      }

      // Extract filename from URL or use provided name
      let originalName = name;
      if (!originalName) {
        if (isGoogleDrive) {
          originalName = 'google-drive-document.pdf';
        } else {
          const urlPath = validUrl.pathname;
          const urlFilename = urlPath.split('/').pop() || 'document.pdf';
          originalName = urlFilename;
        }
      }

      console.log(`Downloaded PDF: ${originalName}, Size: ${fileSize} bytes`);

      // Create document record with URL reference
      const document = await storage.createDocument({
        filename: `${Date.now()}_${originalName}`,
        originalName: originalName,
        fileType: 'pdf',
        fileSize: fileSize,
        status: "uploading",
        metadata: { 
          sourceUrl: url, // Store original URL, not the converted one
          downloadUrl: downloadUrl, // Store the actual download URL used
          uploadType: 'url',
          isGoogleDrive: isGoogleDrive,
          contentType: contentType || 'application/pdf'
        },
      });

      try {
        // Process document with URL reference
        await Promise.race([
          documentProcessor.processDocument(document, buffer, url),
          // new Promise((_, reject) => 
          //   setTimeout(() => reject(new Error('Document processing timeout')), env.API_TIMEOUT)
          // )
        ]);
        
        // Get the updated document with final status
        const processedDocument = await storage.getDocument(document.id);
        await storage.deleteDocument(document.id);
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
      console.error('PDF URL upload error:', error);
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
        await storage.deleteDocument(document.id);
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
      const id = req.params.id + "";
      // const document = await storage.getDocument(id);
      
      // if (!document) {
      //   return res.status(404).json({ message: "Document not found" });
      // }

      // Delete from vector database
      await documentProcessor.deleteDocumentFromVector(id);
      
      // Delete from storage
      //@ts-ignore
      await storage.deleteDocument(id);
      
      res.json({ message: "Document deleted successfully" });
    } catch (error) {
      //@ts-ignore
      console.error('Document deletion error:', JSON.stringify(error?.message, null, 2));
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Chat endpoint
  app.post("/api/chat", async (req, res) => {
    try {
      const { message, retrievalCount, similarityThreshold,productName="" } = req.body;
      
      if (!message) {
        return res.status(400).json({ message: "Message is required" });
      }

      const result = await ragService.queryDocuments(message, {
        retrievalCount: retrievalCount || 5,
        similarityThreshold: similarityThreshold ||  0.75,
        productName:productName
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
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

  // Context Missing Query Management Endpoints
  
  // Get all unresolved context missing queries
  // app.get("/api/context-missing", async (req, res) => {
  //   try {
  //     const queries = await storage.getUnresolvedContextMissingQueries();
  //     res.json(queries);
  //   } catch (error) {
  //     res.status(500).json({ message: (error as Error).message });
  //   }
  // });

  // Get context missing analytics
  // app.get("/api/context-missing/analytics", async (req, res) => {
  //   try {
  //     const analytics = await storage.getContextMissingAnalytics();
  //     res.json(analytics);
  //   } catch (error) {
  //     res.status(500).json({ message: (error as Error).message });
  //   }
  // });

  // Resolve a context missing query
  // app.post("/api/context-missing/:id/resolve", async (req, res) => {
  //   try {
  //     const id = parseInt(req.params.id);
  //     const { resolutionNotes } = req.body;
      
  //     await storage.resolveContextMissingQuery(id, resolutionNotes);
  //     res.json({ message: "Query resolved successfully" });
  //   } catch (error) {
  //     res.status(500).json({ message: (error as Error).message });
  //   }
  // });

  // Get system stats
  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await ragService.getSystemStats();
      const qdrantStatus = await ragService.getQdrantStatus();
      const contextMissingAnalytics = await storage.getContextMissingAnalytics();
      
      res.json({
        ...stats,
        contextMissingQueries: {
          total: contextMissingAnalytics.totalQueries,
          unresolved: contextMissingAnalytics.totalQueries - contextMissingAnalytics.resolvedQueries,
          byCategory: contextMissingAnalytics.byCategory,
          byPriority: contextMissingAnalytics.byPriority,
        },
        qdrantStatus: qdrantStatus.status === "error" ? "disconnected" : "connected",
        openaiStatus: process.env.OPENAI_API_KEY ? "connected" : "not configured",
      });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Settings endpoints
  app.get("/api/settings/:key", async (req, res) => {
    try {
      const setting = await storage.getSetting(req.params.key);
      if (!setting) {
        return res.status(404).json({ message: "Setting not found" });
      }
      res.json(setting);
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

  // Batch upload files
  app.post("/api/documents/batch-upload-files", upload.array("files", 100), async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
      }

      const files = req.files as Express.Multer.File[];
      const { concurrency, retryAttempts } = req.body;

      console.log(`Creating batch upload job for ${files.length} files`);

      // Prepare file items
      const items = files.map(file => {
        let fileType = 'unknown';
        if (file.mimetype === 'application/pdf') fileType = 'pdf';
        else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') fileType = 'docx';
        else if (file.mimetype === 'text/plain') fileType = 'txt';

        return {
          file: {
            buffer: file.buffer,
            originalName: file.originalname,
            fileType,
            fileSize: file.size
          }
        };
      });

      // Create batch job
      const jobId = await batchUploadService.createBatchJob(items, {
        concurrency: parseInt(concurrency) || 3,
        retryAttempts: parseInt(retryAttempts) || 2
      });

      res.json({
        jobId,
        message: `Batch upload job created with ${files.length} files`,
        totalItems: files.length,
        status: 'pending'
      });

    } catch (error) {
      console.error('Batch file upload error:', error);
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Get batch job status
  app.get("/api/batch-jobs/:jobId", async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = batchUploadService.getJobStatus(jobId);
      
      if (!job) {
        return res.status(404).json({ message: "Batch job not found" });
      }

      res.json(job);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Get all batch jobs
  app.get("/api/batch-jobs", async (req, res) => {
    try {
      const jobs = batchUploadService.getAllJobs();
      res.json(jobs);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Cancel batch job
  app.post("/api/batch-jobs/:jobId/cancel", async (req, res) => {
    try {
      const { jobId } = req.params;
      const cancelled = batchUploadService.cancelJob(jobId);
      
      if (!cancelled) {
        return res.status(400).json({ message: "Job cannot be cancelled or not found" });
      }

      res.json({ message: "Batch job cancelled successfully" });
    } catch (error) {
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

  // Audio analysis endpoint
  app.post("/api/audio/analyze", audioUpload.single("audio"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No audio file uploaded" });
      }

      const { originalname, mimetype, size, buffer } = req.file;
      const { 
        chunkDuration = 45,
        enableSpeakerIdentification = true,
        enableSentimentAnalysis = true,
        enableToneAnalysis = true,
        language = 'en',
        model = 'openai',
        provider = 'openai'
      } = req.body;

      console.log(`Starting audio analysis for file: ${originalname} (${size} bytes)`);

      // Analyze the audio file
      const result = await audioInsightsService.analyzeAudioFile(buffer, originalname, {
        chunkDuration: parseInt(chunkDuration),
        enableSpeakerIdentification: enableSpeakerIdentification === 'true',
        enableSentimentAnalysis: enableSentimentAnalysis === 'true',
        enableToneAnalysis: enableToneAnalysis === 'true',
        // language,
        model,
        provider
      });

      if (!result.success) {
        return res.status(500).json({ 
          message: "Audio analysis failed", 
          error: result.error,
          processingTime: result.processingTime
        });
      }

      console.log(`Audio analysis completed in ${result.processingTime}ms`);

      // Return the insights
      res.json({
        success: true,
        insights: result.insights,
        processingTime: result.processingTime,
        stats: audioInsightsService.getAnalysisStats(result.insights!)
      });

    } catch (error) {
      console.error('Audio analysis endpoint error:', error);
      res.status(500).json({ 
        message: "Audio analysis failed", 
        error: (error as Error).message 
      });
    }
  });

  // Get audio analysis statistics
  app.get("/api/audio/stats", async (req, res) => {
    try {
      // This could be expanded to return system-wide audio analysis statistics
      res.json({
        message: "Audio analysis service is running",
        supportedFormats: [
          'WAV', 'MP3', 'MP4', 'M4A', 'OGG', 'WEBM', 'FLAC', 'AAC'
        ],
        maxFileSize: '50MB',
        features: [
          'Transcription',
          'Speaker Identification',
          'Sentiment Analysis',
          'Tone Analysis',
          'Audio Chunking',
          'Conversation Flow Analysis'
        ]
      });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Deepgram audio analyzer endpoint
  app.post("/api/audio/deepgram-analyze", audioUpload.single("audio"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No audio file uploaded" });
      }

      const { originalname, mimetype, size, buffer } = req.file;
      const { 
        model = 'nova-3',
        language = 'en',
        summarize = 'true',
        topics = true,
        intents = true,
        detect_entities = true,
        sentiment = true,
        smart_format = false,
        keyterm = [],
        punctuate = true,
        paragraphs = false,
        utterances = true,
        redact = [],
        diarize = true,
        filler_words = true
      } = req.body;

      console.log(`Starting Deepgram analysis for file: ${originalname} (${size} bytes)`);

      // Initialize Deepgram client
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY || '99171406687f94dce284c507ed806f365e249f96';
      const deepgram = createClient(deepgramApiKey);

      // Convert buffer to base64 for Deepgram API
      const base64Audio = buffer.toString('base64');

      // Configure options based on language
      let transcriptionOptions;
      if (language === 'hi') {
        // Hindi-specific options
        transcriptionOptions =  {
          model: 'nova-2',
          language: 'hi-Latn',
          paragraphs: true,
          utterances: true,
          utt_split: 0.8,
          keywords: [':'],
          diarize: true,
        };
      } else {
        // Default options for other languages
        transcriptionOptions = {
          model,
          language,
          summarize: summarize === 'true' ? 'v2' : false,
          topics: topics === 'true',
          intents: intents === 'true',
          detect_entities: detect_entities === 'true',
          sentiment: sentiment === 'true',
          smart_format: smart_format === 'true',
          keyterm: Array.isArray(keyterm) ? keyterm : [],
          punctuate: punctuate === 'true',
          paragraphs: paragraphs === 'true',
          utterances: utterances === 'true',
          redact: Array.isArray(redact) ? redact : [],
          diarize: diarize === 'true',
          filler_words: filler_words === 'true',
        };
      }

      console.log("🚀 ~ registerRoutes ~ transcriptionOptions:", transcriptionOptions);
      const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
        buffer,
        transcriptionOptions
      );

      if (error) {
        console.error('Deepgram error:', error);
        return res.status(500).json({ 
          message: "Deepgram analysis failed", 
          error: error.message || 'Unknown error'
        });
      }

      console.log(`Deepgram analysis completed for ${originalname}`);

      // Return the analysis result
      res.json({
        success: true,
        filename: originalname,
        fileSize: size,
        analysis: result,
        processingTime: Date.now() // You might want to track actual processing time
      });

    } catch (error) {
      console.error('Deepgram analysis endpoint error:', error);
      res.status(500).json({ 
        message: "Deepgram analysis failed", 
        error: (error as Error).message 
      });
    }
  });

  // Deepgram URL analyzer endpoint (for analyzing audio from URLs)
  app.post("/api/audio/deepgram-analyze-url", async (req, res) => {
    try {
      const { 
        url, 
        model = 'nova-3', 
        language = 'en', 
        summarize = 'v2', 
        topics = true, 
        intents = true, 
        detect_entities = true,
        sentiment = true, 
        smart_format = true, 
        keyterm = [],
        punctuate = true,
        paragraphs = true,
        utterances = true,
        redact = [],
        diarize = true,
        filler_words = true
      } = req.body;

      if (!url) {
        return res.status(400).json({ message: "URL is required" });
      }

      // Validate URL format
      try {
        new URL(url);
      } catch {
        return res.status(400).json({ message: "Invalid URL format" });
      }

      console.log(`Starting Deepgram URL analysis for: ${url}`);

      // Initialize Deepgram client
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY || '99171406687f94dce284c507ed806f365e249f96';
      const deepgram = createClient(deepgramApiKey);

      const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
        { url },
        {
          model,
          language,
          summarize: summarize === 'v2' ? 'v2' : false,
          topics: topics === 'true',
          intents: intents === 'true',
          detect_entities: detect_entities === 'true',
          sentiment: sentiment === 'true',
          smart_format: smart_format === 'true',
          keyterm: Array.isArray(keyterm) ? keyterm : [],
          punctuate: punctuate === 'true',
          paragraphs: paragraphs === 'true',
          utterances: utterances === 'true',
          redact: Array.isArray(redact) ? redact : [],
          diarize: diarize === 'true',
          filler_words: filler_words === 'true',
        }
      );

      if (error) {
        console.error('Deepgram URL error:', error);
        return res.status(500).json({ 
          message: "Deepgram URL analysis failed", 
          error: error.message || 'Unknown error'
        });
      }

      console.log(`Deepgram URL analysis completed for ${url}`);

      // Return the analysis result
      res.json({
        success: true,
        url,
        analysis: result,
        processingTime: Date.now() // You might want to track actual processing time
      });

    } catch (error) {
      console.error('Deepgram URL analysis endpoint error:', error);
      res.status(500).json({ 
        message: "Deepgram URL analysis failed", 
        error: (error as Error).message 
      });
    }
  });

  const httpServer = createServer(app);
  // Initialize WebSocket handler for realtime transcription
  new WebSocketHandler(httpServer);
  return httpServer;
}

// Helper function to extract Google Drive file ID from various URL formats
function extractGoogleDriveId(url: string): string | null {
  // Handle different Google Drive URL formats:
  // https://drive.google.com/file/d/FILE_ID/view
  // https://drive.google.com/open?id=FILE_ID
  // https://drive.google.com/uc?id=FILE_ID
  
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
