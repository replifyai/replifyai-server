# Intelligent Document Analyzer - Backend

Backend API server for the Intelligent Document Analyzer application.

## Features

- Document upload and processing
- PDF, DOCX, and other document format support
- OpenAI integration for document analysis
- Vector database integration with Qdrant
- Session management and authentication
- RESTful API endpoints

## Getting Started

### Prerequisites

- Node.js 18 or higher
- PostgreSQL database
- OpenAI API key (optional, for AI features)
- Qdrant instance (for vector operations)

### Installation

1. Clone the repository and install dependencies:
```bash
npm install
```

2. Copy the environment file and configure:
```bash
cp .env.example .env
```

3. Configure your environment variables in `.env`

4. Push database schema:
```bash
npm run db:push
```

### Development

Start the development server:
```bash
npm run dev
```

The server will start on `http://localhost:5000`

### Production

Build and start the production server:
```bash
npm run build
npm start
```

## API Endpoints

The API provides the following main endpoints:

- `GET /health` - Health check
- `POST /api/documents` - Upload documents
- `GET /api/documents` - List documents
- `POST /api/chat` - Chat with documents
- `GET /api/stats` - Get statistics

## Environment Variables

See `.env.example` for all required environment variables.

Key variables:
- `DATABASE_URL` - PostgreSQL connection string
- `OPENAI_API_KEY` - OpenAI API key
- `QDRANT_URL` - Qdrant database URL
- `FRONTEND_URL` - Frontend URL for CORS (default: http://localhost:3000)

## Deployment

### Railway/Render/Heroku

1. Set environment variables
2. Deploy using `npm run build && npm start`

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 5000
CMD ["npm", "start"]
```

### Vercel

Deploy API routes from the `api/` directory as serverless functions. 