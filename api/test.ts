import { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  return res.json({
    message: 'API is working!',
    method: req.method,
    url: req.url,
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
}

// Also export as named export for compatibility
export { handler }; 