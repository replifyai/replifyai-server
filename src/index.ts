import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import { registerRoutes } from "./routes.js";
import { env, validateEnv } from "./env.js";

// Validate environment variables on startup
validateEnv();

const app = express();

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static files from public directory
app.use(express.static(path.join(process.cwd(), 'public')));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      console.log(logLine);
    }
  });

  next();
});

// Initialize app synchronously for Vercel
let isInitialized = false;

async function initializeApp() {
  if (isInitialized) return app;
  
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  });

  // Serve the API documentation page at root
  app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });

  // Catch-all for undefined routes (but not static files)
  app.use('/api/*', (req, res) => {
    res.status(404).json({ message: 'API endpoint not found' });
  });

  isInitialized = true;
  return server;
}

// Initialize the app immediately
const initPromise = initializeApp().catch(console.error);

// For local development, start the server
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  initPromise.then((server) => {
    const port = env.PORT || 5000;
    if (server) {
      server.listen(port, () => {
        console.log(`🚀 Backend server running on port ${port}`);
        console.log(`📡 API available at http://localhost:${port}/api`);
        console.log(`📄 Documentation available at http://localhost:${port}`);
      });
    }
  });
}

// Export the app for Vercel - ensure it's initialized
export default app;
