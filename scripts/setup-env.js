#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');

console.log('🔧 Environment Setup Script');
console.log('==========================');

// Check if .env already exists
if (fs.existsSync(envPath)) {
  console.log('✅ .env file already exists');
  console.log('💡 You can manually edit it or delete it to recreate from template');
  process.exit(0);
}

// Check if .env.example exists
if (!fs.existsSync(envExamplePath)) {
  console.error('❌ .env.example file not found');
  console.error('Please ensure .env.example exists in the project root');
  process.exit(1);
}

// Copy .env.example to .env
try {
  fs.copyFileSync(envExamplePath, envPath);
  console.log('✅ Created .env file from .env.example');
  console.log('');
  console.log('📝 Next steps:');
  console.log('1. Edit the .env file with your actual values');
  console.log('2. Set your DATABASE_URL for database connection');
  console.log('3. Add your OPENAI_API_KEY if using AI features');
  console.log('4. Configure QDRANT_URL and QDRANT_API_KEY if using vector search');
  console.log('');
  console.log('⚠️  Never commit the .env file to version control!');
} catch (error) {
  console.error('❌ Failed to create .env file:', error.message);
  process.exit(1);
} 