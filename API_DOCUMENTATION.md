# Intelligent Document Analyzer API Documentation

## Overview

The Intelligent Document Analyzer API provides endpoints for document processing, batch uploads, RAG-powered chat, and system management. The API supports PDF, DOCX, TXT, and Markdown (.md) file processing with AI-powered chunking and vector storage.

## Base URL

```
http://localhost:3000
```

## Authentication

Currently, no authentication is required for API access.

---

## Document Management Endpoints

### 1. Get All Documents

**Endpoint:** `GET /api/documents`

**Description:** Retrieve a list of all uploaded documents with their processing status and metadata.

**Response:**
```json
[
  {
    "id": 1,
    "filename": "1735659370433_document.pdf",
    "originalName": "document.pdf",
    "fileType": "pdf",
    "fileSize": 154470,
    "status": "indexed",
    "uploadedAt": "2024-01-15T10:00:00Z",
    "processedAt": "2024-01-15T10:00:30Z",
    "chunkCount": 15,
    "metadata": {
      "mimetype": "application/pdf"
    }
  }
]
```

**Status Codes:**
- `200`: Success
- `500`: Server error

---

### 2. Upload Document (File)

**Endpoint:** `POST /api/documents/upload`

**Description:** Upload a single document file for processing and indexing.

**Request:**
- Content-Type: `multipart/form-data`
- Body: `file` (required) - Document file (PDF, DOCX, TXT, Markdown)
- Max file size: 10MB

**Response:**
```json
{
  "id": 1,
  "filename": "1735659370433_document.pdf",
  "originalName": "document.pdf",
  "fileType": "pdf",
  "fileSize": 154470,
  "status": "indexed",
  "uploadedAt": "2024-01-15T10:00:00Z",
  "processedAt": "2024-01-15T10:00:30Z",
  "chunkCount": 15,
  "metadata": {
    "mimetype": "application/pdf",
    "uploadType": "file"
  }
}
```

**Status Codes:**
- `200`: Document uploaded and processed successfully
- `400`: Invalid file or missing file
- `500`: Processing failed

---

### 3. Upload Document (URL)

**Endpoint:** `POST /api/documents/upload-url`

**Description:** Upload a document from a URL (including Google Drive links).

**Request:**
```json
{
  "url": "https://example.com/document.pdf",
  "name": "Custom Document Name" // optional
}
```

**Supported URLs:**
- Direct PDF links
- Direct Markdown (.md) links
- Google Drive share links (`https://drive.google.com/file/d/FILE_ID/view`)

**Response:** Same as file upload with additional metadata:
```json
{
  "metadata": {
    "sourceUrl": "https://example.com/document.pdf",
    "uploadType": "url",
    "isGoogleDrive": false,
    "contentType": "application/pdf"
  }
}
```

**Status Codes:**
- `200`: Document uploaded and processed successfully
- `400`: Invalid URL, access denied, or invalid file
- `500`: Processing failed

---

### 4. Delete Document

**Endpoint:** `DELETE /api/documents/:id`

**Description:** Delete a document and remove it from the vector database.

**Parameters:**
- `id` (path): Document ID

**Response:**
```json
{
  "message": "Document deleted successfully"
}
```

**Status Codes:**
- `200`: Document deleted successfully
- `404`: Document not found
- `500`: Server error

---

## Batch Upload Endpoints

### 1. Batch Upload from URLs

**Endpoint:** `POST /api/documents/batch-upload-urls`

**Description:** Upload multiple documents from URLs with queue-based processing.

**Request:**
```json
{
  "urls": [
    "https://example.com/doc1.pdf",
    "https://drive.google.com/file/d/FILE_ID/view",
    {
      "url": "https://example.com/doc2.pdf",
      "name": "Custom Document Name"
    }
  ],
  "concurrency": 3,      // optional, default: 3
  "retryAttempts": 2     // optional, default: 2
}
```

**Constraints:**
- Maximum 100 URLs per batch
- Supported: PDF URLs, Markdown (.md) URLs, and Google Drive links
- Concurrency range: 1-10
- Retry attempts range: 0-5

**Response:**
```json
{
  "jobId": "batch_1735659370433_abc123",
  "message": "Batch upload job created with 3 URLs",
  "totalItems": 3,
  "status": "pending"
}
```

**Status Codes:**
- `200`: Batch job created successfully
- `400`: Invalid request (empty URLs, too many URLs, invalid format)
- `500`: Server error

---

### 2. Batch Upload Files

**Endpoint:** `POST /api/documents/batch-upload-files`

**Description:** Upload multiple files directly with queue-based processing.

**Request:**
- Content-Type: `multipart/form-data`
- `files`: Array of files (up to 100 files)
- `concurrency`: Number (optional, default: 3)
- `retryAttempts`: Number (optional, default: 2)

**Constraints:**
- Maximum 100 files per batch
- Max file size: 10MB per file
- Supported types: PDF, DOCX, TXT

**Response:**
```json
{
  "jobId": "batch_1735659370433_def456",
  "message": "Batch upload job created with 5 files",
  "totalItems": 5,
  "status": "pending"
}
```

**Status Codes:**
- `200`: Batch job created successfully
- `400`: No files uploaded or invalid request
- `500`: Server error

---

### 3. Get Batch Job Status

**Endpoint:** `GET /api/batch-jobs/:jobId`

**Description:** Monitor the progress and status of a batch upload job.

**Parameters:**
- `jobId` (path): Batch job identifier

**Response:**
```json
{
  "id": "batch_1735659370433_abc123",
  "status": "processing",
  "totalItems": 50,
  "completedItems": 32,
  "failedItems": 3,
  "startTime": "2024-01-15T10:00:00Z",
  "endTime": null,
  "concurrency": 3,
  "retryAttempts": 2,
  "items": [
    {
      "id": "batch_1735659370433_abc123_item_0",
      "url": "https://example.com/doc1.pdf",
      "name": "Custom Name",
      "status": "completed",
      "error": null,
      "documentId": 42,
      "progress": 100,
      "startTime": "2024-01-15T10:00:05Z",
      "endTime": "2024-01-15T10:00:25Z"
    }
  ]
}
```

**Job Status Values:**
- `pending`: Job created but not started
- `processing`: Job is actively processing documents
- `completed`: All documents processed successfully
- `failed`: Job failed due to critical error
- `cancelled`: Job was manually cancelled

**Item Status Values:**
- `pending`: Item waiting to be processed
- `processing`: Item currently being processed
- `completed`: Item processed successfully
- `failed`: Item processing failed

**Status Codes:**
- `200`: Job status retrieved successfully
- `404`: Job not found
- `500`: Server error

---

### 4. Get All Batch Jobs

**Endpoint:** `GET /api/batch-jobs`

**Description:** Get a list of all batch upload jobs.

**Response:**
```json
[
  {
    "id": "batch_1735659370433_abc123",
    "status": "completed",
    "totalItems": 10,
    "completedItems": 8,
    "failedItems": 2,
    "startTime": "2024-01-15T10:00:00Z",
    "endTime": "2024-01-15T10:05:00Z",
    "concurrency": 3,
    "retryAttempts": 2
  }
]
```

**Status Codes:**
- `200`: Jobs retrieved successfully
- `500`: Server error

---

### 5. Cancel Batch Job

**Endpoint:** `POST /api/batch-jobs/:jobId/cancel`

**Description:** Cancel a running or pending batch upload job.

**Parameters:**
- `jobId` (path): Batch job identifier

**Response:**
```json
{
  "message": "Batch job cancelled successfully"
}
```

**Behavior:**
- Pending items are marked as failed
- Currently processing items continue to completion
- Completed jobs cannot be cancelled
- Already processed documents remain in the system

**Status Codes:**
- `200`: Job cancelled successfully
- `400`: Job cannot be cancelled or not found
- `500`: Server error

---

## Chat Endpoints

### 1. Send Chat Message

**Endpoint:** `POST /api/chat`

**Description:** Send a message to the RAG-powered chat system with intelligent query classification. The system automatically detects greetings and casual messages, providing friendly contextual responses without unnecessary document retrieval.

**Request:**
```json
{
  "message": "What are the key features of the product?",
  "retrievalCount": 10,        // optional, default: 10
  "similarityThreshold": 0.75, // optional, default: 0.75
  "productName": "",           // optional, filter by product name
  "companyContext": {          // optional, customize greeting responses
    "companyName": "Acme Corp",
    "companyDescription": "We provide innovative AI solutions for businesses",
    "productCategories": "AI chatbots, document analysis, RAG systems"
  }
}
```

**Smart Query Classification:**
- **Greetings** (e.g., "hi", "hello"): Returns friendly welcome message with company context
- **Casual Chat** (e.g., "how are you", "thank you"): Returns appropriate conversational response
- **Informational Queries**: Performs RAG retrieval and generates contextual answers

**Environment Variables for Default Company Context:**
```env
COMPANY_NAME=Your Company Name
COMPANY_DESCRIPTION=Brief description of your company
PRODUCT_CATEGORIES=category1, category2, category3
```

**Response:**
```json
{
  "query": "What are the key features of the product?",
  "response": "Based on the documents, the key features include...",
  "sources": [
    {
      "documentId": 1,
      "filename": "product-spec.pdf",
      "content": "The product features advanced AI capabilities...",
      "score": 0.89,
      "metadata": {
        "filename": "product-spec.pdf",
        "topics": ["AI", "features", "capabilities"],
        "keyTerms": ["artificial intelligence", "machine learning"],
        "docMetadata": {
          "sourceUrl": "https://example.com/spec.pdf"
        }
      }
    }
  ],
  "contextAnalysis": {
    "isContextMissing": false,
    "suggestedTopics": ["product features", "specifications"],
    "category": "product_inquiry",
    "priority": "medium"
  }
}
```

**Status Codes:**
- `200`: Chat response generated successfully
- `400`: Missing message parameter
- `500`: Server error

---

### 2. Get Chat History

**Endpoint:** `GET /api/chat/history`

**Description:** Retrieve chat message history.

**Response:**
```json
[
  {
    "id": 1,
    "query": "What are the key features?",
    "response": "The key features include...",
    "createdAt": "2024-01-15T10:00:00Z"
  }
]
```

**Status Codes:**
- `200`: Chat history retrieved successfully
- `500`: Server error

---

## System Endpoints

### 1. Get System Statistics

**Endpoint:** `GET /api/stats`

**Description:** Get system statistics and health information.

**Response:**
```json
{
  "documentCount": 25,
  "chunkCount": 450,
  "indexedDocuments": 23,
  "contextMissingQueries": {
    "total": 15,
    "unresolved": 3,
    "byCategory": {
      "product_inquiry": 8,
      "technical_support": 4,
      "general": 3
    },
    "byPriority": {
      "high": 2,
      "medium": 8,
      "low": 5
    }
  },
  "qdrantStatus": "connected",
  "openaiStatus": "connected"
}
```

**Status Codes:**
- `200`: Statistics retrieved successfully
- `500`: Server error

---

### 2. Get Setting

**Endpoint:** `GET /api/settings/:key`

**Description:** Get a specific system setting.

**Parameters:**
- `key` (path): Setting key

**Response:**
```json
{
  "key": "max_chunk_size",
  "value": "2000",
  "updatedAt": "2024-01-15T10:00:00Z"
}
```

**Status Codes:**
- `200`: Setting retrieved successfully
- `404`: Setting not found
- `500`: Server error

---

### 3. Set Setting

**Endpoint:** `POST /api/settings`

**Description:** Set a system setting.

**Request:**
```json
{
  "key": "max_chunk_size",
  "value": "2000"
}
```

**Response:**
```json
{
  "key": "max_chunk_size",
  "value": "2000",
  "updatedAt": "2024-01-15T10:00:00Z"
}
```

**Status Codes:**
- `200`: Setting updated successfully
- `400`: Invalid request
- `500`: Server error

---

## Error Handling

### Common Error Response Format

```json
{
  "message": "Error description"
}
```

### HTTP Status Codes

- `200`: Success
- `400`: Bad Request (invalid parameters, file too large, etc.)
- `404`: Not Found (document, job, or setting not found)
- `500`: Internal Server Error

### Batch Upload Specific Errors

```json
{
  "message": "Batch upload job created with 3 URLs",
  "jobId": "batch_123",
  "errors": [
    "Failed to download: https://example.com/invalid.pdf - 404 Not Found",
    "Invalid PDF format: https://example.com/notpdf.txt"
  ]
}
```

---

## Rate Limits and Constraints

### File Upload Limits
- **Single file**: 10MB maximum
- **Batch upload**: 100 files/URLs maximum per batch
- **Supported formats**: PDF, DOCX, TXT

### Batch Processing Limits
- **Concurrency**: 1-10 simultaneous processes
- **Retry attempts**: 0-5 attempts per failed item
- **Job retention**: Jobs are kept for 24 hours after completion

### API Timeouts
- **Single upload**: 30 seconds processing timeout
- **Batch processing**: No timeout (queue-based)
- **Chat queries**: 30 seconds response timeout

---

## Integration Examples

### JavaScript/Node.js

```javascript
import fetch from 'node-fetch';
import FormData from 'form-data';

// Single file upload
async function uploadFile(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  
  const response = await fetch('http://localhost:3000/api/documents/upload', {
    method: 'POST',
    body: form
  });
  
  return await response.json();
}

// Batch URL upload
async function batchUploadUrls(urls) {
  const response = await fetch('http://localhost:3000/api/documents/batch-upload-urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: urls,
      concurrency: 5,
      retryAttempts: 3
    })
  });
  
  return await response.json();
}

// Monitor batch job
async function monitorBatchJob(jobId) {
  const response = await fetch(`http://localhost:3000/api/batch-jobs/${jobId}`);
  return await response.json();
}

// Send chat message
async function sendChatMessage(message) {
  const response = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  
  return await response.json();
}
```

### Python

```python
import requests
import time

# Single file upload
def upload_file(file_path):
    with open(file_path, 'rb') as f:
        files = {'file': f}
        response = requests.post('http://localhost:3000/api/documents/upload', files=files)
    return response.json()

# Batch URL upload
def batch_upload_urls(urls):
    data = {
        'urls': urls,
        'concurrency': 5,
        'retryAttempts': 3
    }
    response = requests.post('http://localhost:3000/api/documents/batch-upload-urls', json=data)
    return response.json()

# Monitor batch job
def monitor_batch_job(job_id):
    response = requests.get(f'http://localhost:3000/api/batch-jobs/{job_id}')
    return response.json()

# Send chat message
def send_chat_message(message):
    data = {'message': message}
    response = requests.post('http://localhost:3000/api/chat', json=data)
    return response.json()
```

### cURL Examples

```bash
# Upload single file
curl -X POST http://localhost:3000/api/documents/upload \
  -F "file=@document.pdf"

# Upload from URL
curl -X POST http://localhost:3000/api/documents/upload-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/document.pdf"}'

# Batch upload URLs
curl -X POST http://localhost:3000/api/documents/batch-upload-urls \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://example.com/doc1.pdf",
      "https://example.com/doc2.pdf"
    ],
    "concurrency": 3
  }'

# Monitor batch job
curl http://localhost:3000/api/batch-jobs/batch_1735659370433_abc123

# Send chat message
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are the key features?"}'

# Get system stats
curl http://localhost:3000/api/stats
```

---

## Best Practices

### Batch Upload Optimization
1. **Concurrency**: Start with 3, adjust based on server performance
2. **Batch Size**: Use 50-100 URLs per batch for optimal performance
3. **Error Handling**: Always monitor job progress and handle failures
4. **Google Drive**: Use lower concurrency (1-2) to avoid rate limits

### Document Processing
1. **File Preparation**: Ensure PDFs are text-searchable, not image-only
2. **Naming**: Use descriptive filenames for better organization
3. **Size Management**: Keep files under 10MB for optimal processing

### Chat Integration
1. **Context**: Provide specific questions for better AI responses
2. **Retrieval Tuning**: Adjust `retrievalCount` and `similarityThreshold` based on needs
3. **Error Handling**: Handle context missing scenarios gracefully

---

This API documentation covers all available endpoints in the Intelligent Document Analyzer system, including the comprehensive batch upload functionality for handling large-scale document processing efficiently. 