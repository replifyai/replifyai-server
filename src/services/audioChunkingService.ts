import { AudioChunk } from '../types/audioAnalysis.js';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export interface AudioChunkingOptions {
  chunkDuration: number; // in seconds
  overlapDuration?: number; // in seconds, default 2
  minChunkDuration?: number; // minimum chunk duration in seconds
}

export class AudioChunkingService {
  private options: Required<AudioChunkingOptions>;

  constructor(options: AudioChunkingOptions = { chunkDuration: 45 }) {
    this.options = {
      chunkDuration: options.chunkDuration,
      overlapDuration: options.overlapDuration || 2,
      minChunkDuration: options.minChunkDuration || 10
    };
  }

  /**
   * Chunk audio file into segments for processing
   */
  async chunkAudioFile(
    audioBuffer: Buffer, 
    filename: string,
    totalDuration?: number
  ): Promise<AudioChunk[]> {
    try {
      console.log(`Chunking audio file: ${filename}, buffer size: ${audioBuffer.length} bytes`);
      
      // Create temporary file
      const tempFile = join(tmpdir(), `audio_${randomUUID()}.wav`);
      await writeFile(tempFile, audioBuffer);
      console.log(`Created temporary file: ${tempFile}`);

      // Get audio duration if not provided
      const duration = totalDuration || await this.getAudioDuration(tempFile);
      console.log(`Audio duration: ${duration} seconds`);
      
      // Calculate chunks
      const chunks = this.calculateChunks(duration);
      console.log(`Calculated ${chunks.length} chunks`);
      
      // Extract audio chunks using ffmpeg
      const audioChunks: AudioChunk[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`Extracting chunk ${i + 1}/${chunks.length}: ${chunk.startTime}s - ${chunk.endTime}s`);
        const chunkBuffer = await this.extractAudioChunk(tempFile, chunk.startTime, chunk.duration);
        
        audioChunks.push({
          id: randomUUID(),
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          duration: chunk.duration,
          audioData: chunkBuffer
        });
      }

      // Clean up temporary file
      await unlink(tempFile);
      console.log(`Successfully created ${audioChunks.length} audio chunks`);
      
      return audioChunks;
    } catch (error) {
      console.error('Audio chunking failed:', error);
      console.log('Falling back to single chunk approach...');
      
      // Fallback: create a single chunk with the entire audio
      try {
        const fallbackChunk: AudioChunk = {
          id: randomUUID(),
          startTime: 0,
          endTime: totalDuration || 0,
          duration: totalDuration || 0,
          audioData: audioBuffer
        };
        
        console.log('Created fallback single chunk');
        return [fallbackChunk];
      } catch (fallbackError) {
        console.error('Fallback chunking also failed:', fallbackError);
        throw new Error(`Failed to chunk audio: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Calculate chunk timestamps based on duration and options
   */
  private calculateChunks(totalDuration: number): Array<{startTime: number, endTime: number, duration: number}> {
    const chunks: Array<{startTime: number, endTime: number, duration: number}> = [];
    const { chunkDuration, overlapDuration, minChunkDuration } = this.options;
    
    let currentTime = 0;
    
    while (currentTime < totalDuration) {
      const remainingTime = totalDuration - currentTime;
      let chunkDurationToUse = chunkDuration;
      
      // Adjust chunk duration for the last chunk
      if (remainingTime < chunkDuration) {
        if (remainingTime < minChunkDuration && chunks.length > 0) {
          // Merge with previous chunk if too small
          const lastChunk = chunks[chunks.length - 1];
          lastChunk.endTime = totalDuration;
          lastChunk.duration = lastChunk.endTime - lastChunk.startTime;
          break;
        }
        chunkDurationToUse = remainingTime;
      }
      
      chunks.push({
        startTime: currentTime,
        endTime: Math.min(currentTime + chunkDurationToUse, totalDuration),
        duration: chunkDurationToUse
      });
      
      // Move to next chunk with overlap
      currentTime += chunkDurationToUse - overlapDuration;
    }
    
    return chunks;
  }

  /**
   * Get audio duration using ffprobe
   */
  private async getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath
      ]);

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          resolve(isNaN(duration) ? 0 : duration);
        } else {
          console.error(`ffprobe failed with code ${code}, output: ${output}`);
          reject(new Error(`ffprobe failed with code ${code}`));
        }
      });

      ffprobe.on('error', (error) => {
        console.error(`ffprobe error: ${error.message}`);
        reject(new Error(`ffprobe error: ${error.message}`));
      });
    });
  }

  /**
   * Extract audio chunk using ffmpeg
   */
  private async extractAudioChunk(
    inputFile: string, 
    startTime: number, 
    duration: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputFile,
        '-ss', startTime.toString(),
        '-t', duration.toString(),
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        'pipe:1'
      ]);

      ffmpeg.stdout.on('data', (data) => {
        chunks.push(data);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          console.error(`ffmpeg failed with code ${code}`);
          reject(new Error(`ffmpeg failed with code ${code}`));
        }
      });

      ffmpeg.on('error', (error) => {
        console.error(`ffmpeg error: ${error.message}`);
        reject(new Error(`ffmpeg error: ${error.message}`));
      });
    });
  }

  /**
   * Validate audio file format
   */
  async validateAudioFile(audioBuffer: Buffer): Promise<{valid: boolean, format?: string, duration?: number}> {
    try {
      // Create temporary file for validation
      const tempFile = join(tmpdir(), `validate_${randomUUID()}.wav`);
      await writeFile(tempFile, audioBuffer);

      const duration = await this.getAudioDuration(tempFile);
      await unlink(tempFile);

      return {
        valid: duration > 0,
        format: 'wav', // Assuming we convert to WAV
        duration
      };
    } catch (error) {
      return {
        valid: false
      };
    }
  }
}

export const audioChunkingService = new AudioChunkingService();