# Batch Upload System Guide

## Overview

The batch upload system allows you to upload hundreds of PDFs efficiently without server timeouts. It uses a queue-based processing system with configurable concurrency and retry mechanisms.

## Features

- **Queue-based Processing**: Handles large volumes without overwhelming the server
- **Configurable Concurrency**: Control how many documents process simultaneously (default: 3)
- **Retry Mechanism**: Automatically retries failed uploads (default: 2 attempts)
- **Progress Tracking**: Real-time monitoring of upload progress
- **Error Handling**: Detailed error reporting for failed uploads
- **Multiple Input Types**: Support for URLs, Google Drive links, and file uploads
- **Job Management**: Cancel, monitor, and track batch jobs

## API Endpoints

### 1. Batch Upload from URLs

Upload multiple documents from URLs (including Google Drive links).

```http
POST /api/documents/batch-upload-urls
Content-Type: application/json

{
  "urls": [
    "https://example.com/document1.pdf",
    "https://drive.google.com/file/d/FILE_ID/view?usp=sharing",
    "https://example.com/document2.pdf"
  ],
  "concurrency": 3,
  "retryAttempts": 2
}
```

**Response:**
```json
{
  "jobId": "batch_1234567890",
  "message": "Batch upload job created with 3 URLs",
  "totalItems": 3,
  "status": "pending"
}
```

### 2. Batch Upload Files

Upload multiple files directly.

```http
POST /api/documents/batch-upload-files
Content-Type: multipart/form-data

files: [file1.pdf, file2.pdf, file3.pdf]
concurrency: 3
retryAttempts: 2
```

**Response:**
```json
{
  "jobId": "batch_1234567891",
  "message": "Batch upload job created with 3 files",
  "totalItems": 3,
  "status": "pending"
}
```

### 3. Monitor Job Progress

Track the progress of a batch upload job.

```http
GET /api/batch-jobs/{jobId}
```

**Response:**
```json
{
  "id": "batch_1234567890",
  "status": "processing",
  "totalItems": 100,
  "processedItems": 45,
  "successCount": 42,
  "failedCount": 3,
  "createdAt": "2024-01-15T10:00:00Z",
  "startedAt": "2024-01-15T10:00:05Z",
  "completedAt": null,
  "errors": [
    "Failed to download: https://example.com/invalid.pdf - 404 Not Found"
  ],
  "config": {
    "concurrency": 3,
    "retryAttempts": 2
  }
}
```

### 4. List All Jobs

Get all batch upload jobs.

```http
GET /api/batch-jobs
```

### 5. Cancel Job

Cancel a running batch job.

```http
POST /api/batch-jobs/{jobId}/cancel
```

## Usage Examples

### JavaScript/Node.js

```javascript
import fetch from 'node-fetch';

// Batch upload from URLs
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
  
  const result = await response.json();
  console.log('Job created:', result.jobId);
  
  // Monitor progress
  await monitorJob(result.jobId);
}

async function monitorJob(jobId) {
  while (true) {
    const response = await fetch(`http://localhost:3000/api/batch-jobs/${jobId}`);
    const job = await response.json();
    
    console.log(`Progress: ${job.processedItems}/${job.totalItems} (${job.status})`);
    
    if (job.status === 'completed' || job.status === 'failed') {
      console.log('Final result:', job);
      break;
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
```

### Python

```python
import requests
import time

def batch_upload_urls(urls):
    response = requests.post('http://localhost:3000/api/documents/batch-upload-urls', 
                           json={
                               'urls': urls,
                               'concurrency': 5,
                               'retryAttempts': 3
                           })
    
    result = response.json()
    print(f"Job created: {result['jobId']}")
    
    # Monitor progress
    monitor_job(result['jobId'])

def monitor_job(job_id):
    while True:
        response = requests.get(f'http://localhost:3000/api/batch-jobs/{job_id}')
        job = response.json()
        
        print(f"Progress: {job['processedItems']}/{job['totalItems']} ({job['status']})")
        
        if job['status'] in ['completed', 'failed']:
            print('Final result:', job)
            break
        
        time.sleep(2)
```

### cURL

```bash
# Start batch upload
curl -X POST http://localhost:3000/api/documents/batch-upload-urls \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://example.com/doc1.pdf",
      "https://example.com/doc2.pdf"
    ],
    "concurrency": 3,
    "retryAttempts": 2
  }'

# Monitor job (replace JOB_ID with actual job ID)
curl http://localhost:3000/api/batch-jobs/JOB_ID
```

## Configuration Options

### Concurrency
- **Default**: 3
- **Range**: 1-10
- **Description**: Number of documents processed simultaneously
- **Recommendation**: 
  - 3-5 for mixed document types
  - 1-2 for Google Drive URLs (to avoid rate limits)
  - 5-10 for fast, reliable URLs

### Retry Attempts
- **Default**: 2
- **Range**: 0-5
- **Description**: Number of retry attempts for failed downloads
- **Recommendation**: 
  - 2-3 for most cases
  - 1 for very reliable sources
  - 3-5 for unreliable sources

## Best Practices

### 1. URL Preparation
- Ensure URLs are publicly accessible
- Use direct download links when possible
- For Google Drive, use sharing links with proper permissions

### 2. Batch Size
- **Recommended**: 50-100 URLs per batch
- **Maximum**: 100 URLs per batch
- For larger datasets, create multiple batches

### 3. Monitoring
- Always monitor job progress
- Check for errors and retry failed items if needed
- Cancel jobs if they're taking too long

### 4. Error Handling
- Review error messages for failed uploads
- Common issues: 404 errors, access denied, invalid file formats
- Retry with corrected URLs if possible

## Job Status Types

- **`pending`**: Job created but not started
- **`processing`**: Job is actively processing documents
- **`completed`**: All documents processed successfully
- **`failed`**: Job failed due to critical error
- **`cancelled`**: Job was manually cancelled

## Supported File Types

- **PDF**: `.pdf` files from URLs or uploads
- **DOCX**: `.docx` Word documents
- **TXT**: Plain text files
- **Google Drive**: PDF files shared via Google Drive links

## Limits and Constraints

- **File Size**: 10MB maximum per file
- **Batch Size**: 100 URLs/files maximum per batch
- **Concurrent Jobs**: Multiple jobs can run simultaneously
- **Storage**: Processed documents are stored in the vector database

## Testing

Use the provided test script to verify functionality:

```bash
node test-batch-upload.js
```

This script tests:
- Batch URL uploads
- Batch file uploads
- Job monitoring
- Google Drive integration
- Error handling

## Troubleshooting

### Common Issues

1. **Server Timeout**
   - Solution: Reduce concurrency or batch size

2. **Google Drive Access Denied**
   - Solution: Ensure sharing permissions are set to "Anyone with the link"

3. **High Failure Rate**
   - Solution: Check URL validity, reduce concurrency, increase retry attempts

4. **Memory Issues**
   - Solution: Reduce concurrency, process smaller batches

### Error Codes

- **400**: Invalid request (missing URLs, invalid format)
- **404**: Job not found
- **500**: Server error during processing

## Performance Tips

1. **Optimize Concurrency**: Start with 3, adjust based on performance
2. **Monitor Memory**: Watch server memory usage during large batches
3. **Batch Splitting**: Split very large datasets into multiple smaller batches
4. **Network Optimization**: Use reliable network connection for URL downloads
5. **Error Recovery**: Implement retry logic for failed batches

## Integration Examples

### With Frontend Applications

```javascript
// React component example
const BatchUploader = () => {
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState(null);
  
  const uploadBatch = async (urls) => {
    const response = await fetch('/api/documents/batch-upload-urls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, concurrency: 3 })
    });
    
    const result = await response.json();
    setJobId(result.jobId);
    monitorProgress(result.jobId);
  };
  
  const monitorProgress = async (jobId) => {
    const interval = setInterval(async () => {
      const response = await fetch(`/api/batch-jobs/${jobId}`);
      const job = await response.json();
      setProgress(job);
      
      if (job.status === 'completed' || job.status === 'failed') {
        clearInterval(interval);
      }
    }, 2000);
  };
  
  // Component JSX...
};
```

This batch upload system provides a robust solution for handling large-scale document uploads while maintaining server stability and providing excellent user experience through progress tracking and error handling. 