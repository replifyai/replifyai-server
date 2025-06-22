import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { storage } from "./storage.js";
import { documentProcessor } from "./services/documentProcessor.js";
import { universalDocumentProcessor } from "./services/universalDocumentProcessor.js";
import { ragService } from "./services/ragService.js";
import { insertDocumentSchema, insertSettingSchema } from "../shared/schema.js";

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

  // Upload document
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
        metadata: { mimetype },
      });

      // Process document asynchronously
      processDocumentAsync(document.id, buffer, originalname, fileType);

      res.json(document);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Async function to process document and update database
  async function processDocumentAsync(documentId: number, buffer: Buffer, originalname: string, fileType: string) {
    try {
      console.log(`Processing document ${documentId}...`);
      
      // Get the document record
      const document = await storage.getDocument(documentId);
      if (!document) {
        throw new Error(`Document ${documentId} not found`);
      }
      
      // Use the existing document processor
      await documentProcessor.processDocument(document, buffer);
      
      console.log(`Document ${documentId} processed successfully`);
    } catch (error) {
      console.error(`Failed to process document ${documentId}:`, error);
      
      // Update document status to failed
      await storage.updateDocumentStatus(documentId, "failed");
    }
  }

  // Delete document
  app.delete("/api/documents/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const document = await storage.getDocument(id);
      
      if (!document) {
        return res.status(404).json({ message: "Document not found" });
      }

      // Delete from vector database
      await documentProcessor.deleteDocumentFromVector(id);
      
      // Delete from storage
      await storage.deleteDocument(id);
      
      res.json({ message: "Document deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });

  // Chat endpoint
  app.post("/api/chat", async (req, res) => {
    try {
      const { message, retrievalCount, similarityThreshold } = req.body;
      
      if (!message) {
        return res.status(400).json({ message: "Message is required" });
      }

      const result = await ragService.queryDocuments(message, {
        retrievalCount: retrievalCount || 20,
        similarityThreshold: similarityThreshold ||  0.75,
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
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

  // Get system stats
  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await ragService.getSystemStats();
      const qdrantStatus = await ragService.getQdrantStatus();
      
      res.json({
        ...stats,
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

  const httpServer = createServer(app);
  return httpServer;
}
