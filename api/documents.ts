import { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
// Remove multer import as it won't work in serverless
// import multer from 'multer';
import { storage } from '../server/storage';
import { documentProcessor } from '../server/services/documentProcessor';
import { validateEnv } from '../server/env';

// Validate environment variables
validateEnv();

// Use relative imports instead of @shared alias
interface Document {
  id: number;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  processedAt: Date | null;
  status: string;
  chunkCount: number;
  metadata: any;
}

// Simple in-memory storage for demo
const documents: Document[] = [];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { method } = req;
    
    if (method === 'GET') {
      // Get all documents
      return res.json(documents);
    }
    
    if (method === 'POST') {
      // Handle file upload - not supported in serverless for now
      return res.status(501).json({ message: 'File upload not implemented in serverless function' });
    }
    
    if (method === 'DELETE') {
      // Delete document by ID from query params
      const id = parseInt(req.query.id as string);
      if (!id) {
        return res.status(400).json({ message: 'Document ID is required' });
      }
      
      const index = documents.findIndex(doc => doc.id === id);
      if (index === -1) {
        return res.status(404).json({ message: 'Document not found' });
      }

      // Remove from array
      documents.splice(index, 1);
      
      return res.json({ message: 'Document deleted successfully' });
    }
    
    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error) {
    console.error('Documents API Error:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
} 