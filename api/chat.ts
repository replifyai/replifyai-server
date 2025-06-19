import { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';

// Simple in-memory storage for demo
interface ChatMessage {
  id: number;
  message: string;
  response: string;
  timestamp: Date;
}

const messages: ChatMessage[] = [];
let messageId = 1;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { method } = req;
    
    if (method === 'GET') {
      // Get chat history
      return res.json(messages);
    }
    
    if (method === 'POST') {
      // Handle chat message
      const { message } = req.body;
      
      if (!message) {
        return res.status(400).json({ message: 'Message is required' });
      }

      // Simple mock response for now
      const response = `I received your message: "${message}". This is a demo response as the full RAG service is not available in serverless mode yet.`;
      
      const chatMessage: ChatMessage = {
        id: messageId++,
        message,
        response,
        timestamp: new Date()
      };
      
      messages.push(chatMessage);

      return res.json({
        response,
        sources: [],
        message: chatMessage
      });
    }
    
    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error) {
    console.error('Chat API Error:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
} 