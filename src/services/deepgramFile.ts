import { env } from '../env.js';
import FormData from 'form-data';

export interface DeepgramFileOptions {
  language?: string;
  model?: string;
  punctuate?: boolean;
  diarize?: boolean;
  diarize_version?: string;
  smart_format?: boolean;
  utterances?: boolean;
  paragraphs?: boolean;
  detect_language?: boolean;
  filler_words?: boolean;
  multichannel?: boolean;
  alternatives?: number;
  numerals?: boolean;
  profanity_filter?: boolean;
  redact?: string[];
  search?: string[];
  replace?: string[];
  keywords?: string[];
  keyword_boost?: 'legacy' | 'latest';
  sentiment?: boolean;
  sentiment_threshold?: number;
  topics?: boolean;
  intents?: boolean;
  language_detection?: boolean;
  encoding?: string;
  sample_rate?: number;
  channels?: number;
}

export interface DeepgramTranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: number;
  }>;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    speaker?: number;
    confidence: number;
  }>;
  utterances?: Array<{
    start: number;
    end: number;
    speaker: number;
    transcript: string;
    confidence: number;
    words: Array<{
      word: string;
      start: number;
      end: number;
      confidence: number;
      speaker: number;
    }>;
  }>;
  topics?: Array<{
    topic: string;
    confidence: number;
  }>;
  intents?: Array<{
    intent: string;
    confidence: number;
  }>;
  sentiment?: {
    sentiment: 'positive' | 'negative' | 'neutral';
    confidence: number;
  };
}

export class DeepgramFileService {
  private options: Required<DeepgramFileOptions>;

  constructor(options: DeepgramFileOptions = {}) {
    this.options = {
      language: options.language || 'en-US',
      model: options.model || 'nova-2-general',
      punctuate: options.punctuate ?? true,
      diarize: options.diarize ?? true,
      diarize_version: options.diarize_version || '2023-10-12',
      smart_format: options.smart_format ?? true,
      utterances: options.utterances ?? true,
      paragraphs: options.paragraphs ?? false,
      detect_language: options.detect_language ?? false,
      filler_words: options.filler_words ?? false,
      multichannel: options.multichannel ?? false,
      alternatives: options.alternatives || 1,
      numerals: options.numerals ?? true,
      profanity_filter: options.profanity_filter ?? false,
      redact: options.redact || [],
      search: options.search || [],
      replace: options.replace || [],
      keywords: options.keywords || [],
      keyword_boost: options.keyword_boost || 'latest',
      sentiment: options.sentiment ?? false,
      sentiment_threshold: options.sentiment_threshold || 0.5,
      topics: options.topics ?? false,
      intents: options.intents ?? false,
      language_detection: options.language_detection ?? false,
      encoding: options.encoding || 'linear16',
      sample_rate: options.sample_rate || 16000,
      channels: options.channels || 1
    };
  }

  /**
   * Transcribe an audio file using Deepgram API
   */
  async transcribeFile(audioBuffer: Buffer, filename: string): Promise<DeepgramTranscriptionResult> {
    if (!env.DEEPGRAM_API_KEY) {
      throw new Error('DEEPGRAM_API_KEY is required for Deepgram transcription');
    }

    try {
      // Create form data using Node.js form-data
      const formData = new FormData();
      formData.append('file', audioBuffer, {
        filename: filename,
        contentType: this.getMimeType(filename)
      });

      // Build query parameters - only include essential ones to avoid API errors
      const params = new URLSearchParams();
      params.set('model', this.options.model);
      params.set('language', this.options.language);
      params.set('punctuate', this.options.punctuate.toString());
      params.set('diarize', this.options.diarize.toString());
      params.set('smart_format', this.options.smart_format.toString());
      params.set('utterances', this.options.utterances.toString());
      params.set('numerals', this.options.numerals.toString());
      params.set('encoding', this.options.encoding);
      params.set('sample_rate', this.options.sample_rate.toString());
      params.set('channels', this.options.channels.toString());

      // Add optional parameters only if they have values
      if (this.options.redact && this.options.redact.length > 0) {
        params.set('redact', this.options.redact.join(','));
      }
      if (this.options.search && this.options.search.length > 0) {
        params.set('search', this.options.search.join(','));
      }
      if (this.options.replace && this.options.replace.length > 0) {
        params.set('replace', this.options.replace.join(','));
      }
      if (this.options.keywords && this.options.keywords.length > 0) {
        params.set('keywords', this.options.keywords.join(','));
      }

      const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;
      console.log('Deepgram API URL:', url);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
          ...formData.getHeaders()
        },
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Deepgram API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      return this.parseDeepgramResponse(result);

    } catch (error) {
      console.error('Deepgram file transcription failed:', error);
      throw new Error(`Deepgram transcription failed: ${(error as Error).message}`);
    }
  }

  /**
   * Transcribe multiple audio chunks
   */
  async transcribeChunks(audioChunks: Array<{id: string, audioData: Buffer, filename: string}>): Promise<Array<{chunkId: string, result: DeepgramTranscriptionResult}>> {
    const transcriptionPromises = audioChunks.map(async (chunk) => {
      try {
        const result = await this.transcribeFile(chunk.audioData, chunk.filename);
        return { chunkId: chunk.id, result };
      } catch (error) {
        console.error(`Deepgram transcription failed for chunk ${chunk.id}:`, error);
        return { 
          chunkId: chunk.id, 
          result: {
            text: '',
            language: this.options.language,
            duration: 0,
            words: [],
            segments: []
          }
        };
      }
    });

    return Promise.all(transcriptionPromises);
  }

  /**
   * Get MIME type based on filename
   */
  private getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();
    const mimeTypes: {[key: string]: string} = {
      'wav': 'audio/wav',
      'mp3': 'audio/mpeg',
      'mp4': 'audio/mp4',
      'm4a': 'audio/mp4',
      'ogg': 'audio/ogg',
      'webm': 'audio/webm',
      'flac': 'audio/flac',
      'aac': 'audio/aac'
    };
    return mimeTypes[ext || ''] || 'audio/wav';
  }

  /**
   * Parse Deepgram API response
   */
  private parseDeepgramResponse(response: any): DeepgramTranscriptionResult {
    const results = response.results;
    if (!results || !results.channels || results.channels.length === 0) {
      return {
        text: '',
        language: this.options.language,
        duration: 0,
        words: [],
        segments: []
      };
    }

    const channel = results.channels[0];
    const transcript = channel.alternatives[0]?.transcript || '';
    const words = channel.alternatives[0]?.words || [];
    const segments = channel.alternatives[0]?.paragraphs?.transcript || channel.alternatives[0]?.segments || [];

    return {
      text: transcript,
      language: results.language || this.options.language,
      duration: results.metadata?.duration || 0,
      words: words.map((word: any) => ({
        word: word.word,
        start: word.start,
        end: word.end,
        confidence: word.confidence,
        speaker: word.speaker
      })),
      segments: segments.map((segment: any, index: number) => ({
        id: index,
        start: segment.start || 0,
        end: segment.end || 0,
        text: segment.text || segment.transcript || '',
        speaker: segment.speaker,
        confidence: segment.confidence || 1.0
      })),
      utterances: results.utterances?.map((utterance: any) => ({
        start: utterance.start,
        end: utterance.end,
        speaker: utterance.speaker,
        transcript: utterance.transcript,
        confidence: utterance.confidence,
        words: utterance.words?.map((word: any) => ({
          word: word.word,
          start: word.start,
          end: word.end,
          confidence: word.confidence,
          speaker: word.speaker
        })) || []
      })),
      topics: results.topics?.map((topic: any) => ({
        topic: topic.topic,
        confidence: topic.confidence
      })),
      intents: results.intents?.map((intent: any) => ({
        intent: intent.intent,
        confidence: intent.confidence
      })),
      sentiment: results.sentiment ? {
        sentiment: results.sentiment.sentiment,
        confidence: results.sentiment.confidence
      } : undefined
    };
  }
}

export const deepgramFileService = new DeepgramFileService();