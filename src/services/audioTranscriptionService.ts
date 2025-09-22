import { AudioChunk } from '../types/audioAnalysis.js';
import { openai } from './openai.js';
import { deepgramFileService, DeepgramTranscriptionResult } from './deepgramFile.js';

export interface TranscriptionOptions {
  language?: string;
  model?: string;
  temperature?: number;
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  provider?: 'openai' | 'deepgram';
  timestamp_granularities?: string[];
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence?: number;
  }>;
  segments?: Array<{
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  }>;
}

export class AudioTranscriptionService {
  private options: TranscriptionOptions;

  constructor(options: TranscriptionOptions = {}) {
    this.options = {
      language: options.language || 'en',
      model: options.model || 'whisper-1',
      temperature: options.temperature || 0.0,
      responseFormat: options.responseFormat || 'verbose_json',
      provider: options.provider || 'openai',
      timestamp_granularities: options.timestamp_granularities || ['word', 'segment']
    };
  }

  /**
   * Transcribe a single audio chunk
   */
  async transcribeChunk(chunk: AudioChunk): Promise<TranscriptionResult> {
    try {
      if (this.options.provider === 'deepgram') {
        return await this.transcribeChunkWithDeepgram(chunk);
      } else {
        return await this.transcribeChunkWithOpenAI(chunk);
      }
    } catch (error) {
      console.error(`Transcription failed for chunk ${chunk.id}:`, error);
      throw new Error(`Transcription failed: ${(error as Error).message}`);
    }
  }

  /**
   * Transcribe chunk using OpenAI Whisper
   */
  private async transcribeChunkWithOpenAI(chunk: AudioChunk): Promise<TranscriptionResult> {
    // Create a proper File object from the audio data
    const audioFile = new File([chunk.audioData], `chunk_${chunk.id}.wav`, {
      type: 'audio/wav'
    });

    // Transcribe using OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: this.options.model!,
      language: this.options.language,
      temperature: this.options.temperature,
      response_format: this.options.responseFormat as any,
      timestamp_granularities: ['word', 'segment']
    });

    // Parse response based on format
    if (this.options.responseFormat === 'verbose_json') {
      const result = transcription as any;
      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        words: result.words?.map((w: any) => ({
          word: w.word,
          start: w.start,
          end: w.end,
          confidence: w.probability
        })),
        segments: result.segments?.map((s: any) => ({
          id: s.id,
          seek: s.seek,
          start: s.start,
          end: s.end,
          text: s.text,
          tokens: s.tokens,
          temperature: s.temperature,
          avg_logprob: s.avg_logprob,
          compression_ratio: s.compression_ratio,
          no_speech_prob: s.no_speech_prob
        }))
      };
    } else {
      return {
        text: transcription as unknown as string,
        language: this.options.language,
        duration: chunk.duration
      };
    }
  }

  /**
   * Transcribe chunk using Deepgram
   */
  private async transcribeChunkWithDeepgram(chunk: AudioChunk): Promise<TranscriptionResult> {
    const deepgramResult = await deepgramFileService.transcribeFile(
      chunk.audioData, 
      `chunk_${chunk.id}.wav`
    );

    return {
      text: deepgramResult.text,
      language: deepgramResult.language,
      duration: deepgramResult.duration || chunk.duration,
      words: deepgramResult.words?.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence
      })),
      segments: deepgramResult.segments?.map(s => ({
        id: s.id,
        seek: 0,
        start: s.start,
        end: s.end,
        text: s.text,
        tokens: [],
        temperature: 0,
        avg_logprob: 0,
        compression_ratio: 0,
        no_speech_prob: 0
      }))
    };
  }

  /**
   * Transcribe multiple chunks in parallel
   */
  async transcribeChunks(chunks: AudioChunk[]): Promise<TranscriptionResult[]> {
    const transcriptionPromises = chunks.map(chunk => this.transcribeChunk(chunk));
    return Promise.all(transcriptionPromises);
  }

  /**
   * Transcribe entire audio file
   */
  async transcribeAudioFile(audioBuffer: Buffer, filename: string): Promise<TranscriptionResult> {
    try {
      if (this.options.provider === 'deepgram') {
        return await this.transcribeFileWithDeepgram(audioBuffer, filename);
      } else {
        return await this.transcribeFileWithOpenAI(audioBuffer, filename);
      }
    } catch (error) {
      console.error('Audio transcription failed:', error);
      throw new Error(`Audio transcription failed: ${(error as Error).message}`);
    }
  }

  /**
   * Transcribe file using OpenAI Whisper
   */
  private async transcribeFileWithOpenAI(audioBuffer: Buffer, filename: string): Promise<TranscriptionResult> {
    // Create a proper File object from the audio data
    const audioFile = new File([audioBuffer], filename, {
      type: 'audio/wav'
    });

    // Transcribe using OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: this.options.model!,
      language: this.options.language,
      temperature: this.options.temperature,
      response_format: this.options.responseFormat as any,
      timestamp_granularities: ['word', 'segment']
    });
    console.log("🚀 ~ AudioTranscriptionService ~ transcribeFileWithOpenAI ~ transcription:", transcription);

    // Parse response based on format
    if (this.options.responseFormat === 'verbose_json') {
      const result = transcription as any;
      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        words: result.words?.map((w: any) => ({
          word: w.word,
          start: w.start,
          end: w.end,
          confidence: w.probability
        })),
        segments: result.segments?.map((s: any) => ({
          id: s.id,
          seek: s.seek,
          start: s.start,
          end: s.end,
          text: s.text,
          tokens: s.tokens,
          temperature: s.temperature,
          avg_logprob: s.avg_logprob,
          compression_ratio: s.compression_ratio,
          no_speech_prob: s.no_speech_prob
        }))
      };
    } else {
      return {
        text: transcription as unknown as string,
        language: this.options.language
      };
    }
  }

  /**
   * Transcribe file using Deepgram
   */
  private async transcribeFileWithDeepgram(audioBuffer: Buffer, filename: string): Promise<TranscriptionResult> {
    const deepgramResult = await deepgramFileService.transcribeFile(audioBuffer, filename);

    return {
      text: deepgramResult.text,
      language: deepgramResult.language,
      duration: deepgramResult.duration,
      words: deepgramResult.words?.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence
      })),
      segments: deepgramResult.segments?.map(s => ({
        id: s.id,
        seek: 0,
        start: s.start,
        end: s.end,
        text: s.text,
        tokens: [],
        temperature: 0,
        avg_logprob: 0,
        compression_ratio: 0,
        no_speech_prob: 0
      }))
    };
  }

  /**
   * Combine multiple transcription results into a single transcript
   */
  combineTranscriptions(transcriptions: TranscriptionResult[]): string {
    return transcriptions
      .map(t => t.text)
      .filter(text => text && text.trim().length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract timestamps from combined transcriptions
   */
  extractTimestamps(transcriptions: TranscriptionResult[]): Array<{text: string, start: number, end: number}> {
    const timestamps: Array<{text: string, start: number, end: number}> = [];
    
    transcriptions.forEach(transcription => {
      if (transcription.words) {
        transcription.words.forEach(word => {
          timestamps.push({
            text: word.word,
            start: word.start,
            end: word.end
          });
        });
      } else if (transcription.segments) {
        transcription.segments.forEach(segment => {
          timestamps.push({
            text: segment.text,
            start: segment.start,
            end: segment.end
          });
        });
      }
    });

    return timestamps.sort((a, b) => a.start - b.start);
  }
}


export const audioTranscriptionService = new AudioTranscriptionService();