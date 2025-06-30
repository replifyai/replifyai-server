import { storage } from "../storage.js";
import { documentProcessor } from "./documentProcessor.js";
import { EventEmitter } from "events";

export interface BatchUploadItem {
  id: string;
  url?: string;
  file?: {
    buffer: Buffer;
    originalName: string;
    fileType: string;
    fileSize: number;
  };
  name?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  documentId?: number;
  progress?: number;
  startTime?: Date;
  endTime?: Date;
}

export interface BatchUploadJob {
  id: string;
  items: BatchUploadItem[];
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  totalItems: number;
  completedItems: number;
  failedItems: number;
  startTime?: Date;
  endTime?: Date;
  concurrency: number;
  retryAttempts: number;
}

export class BatchUploadService extends EventEmitter {
  private jobs: Map<string, BatchUploadJob> = new Map();
  private processingQueue: BatchUploadItem[] = [];
  private activeProcesses: Set<string> = new Set();
  private maxConcurrency: number = 3; // Process 3 documents at a time
  private maxRetries: number = 2;
  private processingInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startQueueProcessor();
  }

  /**
   * Create a new batch upload job
   */
  async createBatchJob(
    items: Array<{
      url?: string;
      file?: {
        buffer: Buffer;
        originalName: string;
        fileType: string;
        fileSize: number;
      };
      name?: string;
    }>,
    options: {
      concurrency?: number;
      retryAttempts?: number;
    } = {}
  ): Promise<string> {
    const jobId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const batchItems: BatchUploadItem[] = items.map((item, index) => ({
      id: `${jobId}_item_${index}`,
      url: item.url,
      file: item.file,
      name: item.name,
      status: 'pending',
      progress: 0
    }));

    const job: BatchUploadJob = {
      id: jobId,
      items: batchItems,
      status: 'pending',
      totalItems: items.length,
      completedItems: 0,
      failedItems: 0,
      concurrency: options.concurrency || this.maxConcurrency,
      retryAttempts: options.retryAttempts || this.maxRetries,
      startTime: new Date()
    };

    this.jobs.set(jobId, job);
    
    // Add items to processing queue
    this.processingQueue.push(...batchItems);
    
    console.log(`Created batch job ${jobId} with ${items.length} items`);
    
    // Emit job created event
    this.emit('jobCreated', { jobId, totalItems: items.length });
    
    return jobId;
  }

  /**
   * Get job status and progress
   */
  getJobStatus(jobId: string): BatchUploadJob | null {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Get all jobs
   */
  getAllJobs(): BatchUploadJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Cancel a batch job
   */
  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'completed') {
      return false;
    }

    job.status = 'cancelled';
    job.endTime = new Date();

    // Remove pending items from queue
    this.processingQueue = this.processingQueue.filter(item => 
      !item.id.startsWith(jobId)
    );

    // Mark pending items as failed
    job.items.forEach(item => {
      if (item.status === 'pending') {
        item.status = 'failed';
        item.error = 'Job cancelled';
      }
    });

    this.emit('jobCancelled', { jobId });
    console.log(`Cancelled batch job ${jobId}`);
    
    return true;
  }

  /**
   * Start the queue processor
   */
  private startQueueProcessor(): void {
    if (this.processingInterval) {
      return;
    }

    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, 1000); // Check every second

    console.log('Batch upload queue processor started');
  }

  /**
   * Process items in the queue
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue.length === 0) {
      return;
    }

    // Get jobs that are not at max concurrency
    const availableSlots = this.maxConcurrency - this.activeProcesses.size;
    if (availableSlots <= 0) {
      return;
    }

    // Get next items to process
    const itemsToProcess = this.processingQueue.splice(0, availableSlots);
    
    for (const item of itemsToProcess) {
      if (item.status === 'pending') {
        this.processItem(item);
      }
    }
  }

  /**
   * Process a single upload item
   */
  private async processItem(item: BatchUploadItem): Promise<void> {
    const jobId = item.id.split('_item_')[0];
    const job = this.jobs.get(jobId);
    
    if (!job || job.status === 'cancelled') {
      return;
    }

    this.activeProcesses.add(item.id);
    item.status = 'processing';
    item.startTime = new Date();
    job.status = 'processing';

    this.emit('itemStarted', { jobId, itemId: item.id });

    try {
      let document;
      
      if (item.url) {
        // Handle URL upload
        document = await this.processUrlUpload(item);
      } else if (item.file) {
        // Handle file upload
        document = await this.processFileUpload(item);
      } else {
        throw new Error('No URL or file provided');
      }

      item.status = 'completed';
      item.documentId = document.id;
      item.progress = 100;
      item.endTime = new Date();
      
      job.completedItems++;
      
      this.emit('itemCompleted', { 
        jobId, 
        itemId: item.id, 
        documentId: document.id 
      });

    } catch (error) {
      console.error(`Failed to process item ${item.id}:`, error);
      
      item.error = (error as Error).message;
      item.status = 'failed';
      item.endTime = new Date();
      
      job.failedItems++;
      
      this.emit('itemFailed', { 
        jobId, 
        itemId: item.id, 
        error: item.error 
      });
    } finally {
      this.activeProcesses.delete(item.id);
      
      // Check if job is complete
      this.checkJobCompletion(jobId);
    }
  }

  /**
   * Process URL upload
   */
  private async processUrlUpload(item: BatchUploadItem): Promise<any> {
    if (!item.url) {
      throw new Error('URL is required');
    }

    // Download and validate the file (similar to the route logic)
    const { buffer, originalName, contentType } = await this.downloadFile(item.url);
    
    // Create document record
    const document = await storage.createDocument({
      filename: `${Date.now()}_${originalName}`,
      originalName: originalName,
      fileType: 'pdf',
      fileSize: buffer.length,
      status: "uploading",
      metadata: { 
        sourceUrl: item.url,
        uploadType: 'url',
        batchUpload: true,
        contentType: contentType || 'application/pdf'
      },
    });

    // Process document
    await documentProcessor.processDocument(document, buffer, item.url);
    
    return document;
  }

  /**
   * Process file upload
   */
  private async processFileUpload(item: BatchUploadItem): Promise<any> {
    if (!item.file) {
      throw new Error('File is required');
    }

    const { buffer, originalName, fileType, fileSize } = item.file;
    
    // Create document record
    const document = await storage.createDocument({
      filename: `${Date.now()}_${originalName}`,
      originalName: originalName,
      fileType,
      fileSize,
      status: "uploading",
      metadata: { 
        uploadType: 'file',
        batchUpload: true
      },
    });

    // Process document
    await documentProcessor.processDocument(document, buffer);
    
    return document;
  }

  /**
   * Download file from URL
   */
  private async downloadFile(url: string): Promise<{
    buffer: Buffer;
    originalName: string;
    contentType?: string;
  }> {
    // Convert Google Drive URLs if needed
    let downloadUrl = url;
    let isGoogleDrive = false;
    
    if (url.includes('drive.google.com')) {
      const googleDriveId = this.extractGoogleDriveId(url);
      if (!googleDriveId) {
        throw new Error('Invalid Google Drive URL format');
      }
      downloadUrl = `https://drive.google.com/uc?export=download&id=${googleDriveId}`;
      isGoogleDrive = true;
    }

    const response = await fetch(downloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    const buffer = Buffer.from(await response.arrayBuffer());
    
    // Validate PDF
    if (!this.isPdfBuffer(buffer)) {
      throw new Error('Downloaded file is not a valid PDF');
    }

    let originalName = 'document.pdf';
    if (isGoogleDrive) {
      originalName = 'google-drive-document.pdf';
    } else {
      const urlPath = new URL(url).pathname;
      originalName = urlPath.split('/').pop() || 'document.pdf';
    }

    return { buffer, originalName, contentType: contentType || undefined };
  }

  /**
   * Check if job is complete
   */
  private checkJobCompletion(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const totalProcessed = job.completedItems + job.failedItems;
    
    if (totalProcessed >= job.totalItems) {
      job.status = job.failedItems === 0 ? 'completed' : 'failed';
      job.endTime = new Date();
      
      this.emit('jobCompleted', { 
        jobId, 
        status: job.status,
        completedItems: job.completedItems,
        failedItems: job.failedItems,
        totalItems: job.totalItems
      });

      console.log(`Batch job ${jobId} completed: ${job.completedItems}/${job.totalItems} successful`);
    }
  }

  /**
   * Helper methods
   */
  private extractGoogleDriveId(url: string): string | null {
    const patterns = [
      /\/file\/d\/([a-zA-Z0-9-_]+)/,
      /[?&]id=([a-zA-Z0-9-_]+)/,
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  private isPdfBuffer(buffer: Buffer): boolean {
    return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === '%PDF';
  }

  /**
   * Cleanup completed jobs (call periodically)
   */
  cleanupOldJobs(maxAge: number = 24 * 60 * 60 * 1000): void {
    const cutoffTime = new Date(Date.now() - maxAge);
    
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.endTime && job.endTime < cutoffTime) {
        this.jobs.delete(jobId);
        console.log(`Cleaned up old job: ${jobId}`);
      }
    }
  }

  /**
   * Stop the service
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    console.log('Batch upload service stopped');
  }
}

export const batchUploadService = new BatchUploadService(); 