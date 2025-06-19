import { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';

// Simple fallback handler for any unmatched API routes
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Extract the path from the request
    const path = req.url || '/api/unknown';
    
    return res.status(404).json({ 
      message: `API endpoint not found: ${path}`,
      availableEndpoints: [
        'GET /api/documents',
        'DELETE /api/documents?id=<id>',
        'GET /api/chat',
        'POST /api/chat',
        'GET /api/stats'
      ]
    });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
} 