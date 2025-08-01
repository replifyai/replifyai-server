import 'dotenv/config';

// Environment variable validation and type safety
export const env = {
  // Application
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),
  
  // Database
  DATABASE_URL: process.env.DATABASE_URL || '',
  POSTGRES_URL: process.env.POSTGRES_URL || '',
  
  // Session
  SESSION_SECRET: process.env.SESSION_SECRET || 'default-session-secret-change-in-production',
  
  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR || '',
  
  // Groq
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  
  // Qdrant
  QDRANT_URL: process.env.QDRANT_URL || 'https://qdrant.example.com',
  QDRANT_API_KEY: process.env.QDRANT_API_KEY || '',
  
  // File Upload
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB default
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  
  // Security
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5000',
  
  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  
  // Timeouts (in milliseconds)
  API_TIMEOUT: parseInt(process.env.API_TIMEOUT || '30000', 10), // 30 seconds default
  
  // Replit
  REPL_ID: process.env.REPL_ID || undefined,
} as const;

// Validation function for required environment variables
export function validateEnv() {
  const requiredVars = [
    'DATABASE_URL',
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.error('Missing required environment variables:', missingVars);
    console.error('Please check your .env file and ensure all required variables are set.');
    process.exit(1);
  }
}

// Type definitions for environment variables
export type Environment = typeof env; 