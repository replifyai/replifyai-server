import { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ message: 'Method not allowed' });
    }
    
    // Simple stats for demo
    const stats = {
      totalDocuments: 0,
      totalChunks: 0,
      totalMessages: 0,
      qdrantStatus: "not configured",
      openaiStatus: process.env.OPENAI_API_KEY ? "connected" : "not configured",
      databaseStatus: process.env.DATABASE_URL ? "connected" : "not configured",
    };
    
    return res.json(stats);
  } catch (error) {
    console.error('Stats API Error:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
} 