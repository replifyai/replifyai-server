import { 
  AudioInsights, 
  AudioChunk, 
  AudioAnalysisOptions, 
  AudioAnalysisResult,
  ConversationFlow,
  SpeakerInfo,
  SentimentAnalysis,
  ToneAnalysis
} from '../types/audioAnalysis.js';
import { audioChunkingService } from './audioChunkingService.js';
import { audioTranscriptionService, AudioTranscriptionService } from './audioTranscriptionService.js';
import { speakerIdentificationService } from './speakerIdentificationService.js';
import { sentimentAnalysisService } from './sentimentAnalysisService.js';
import { toneAnalysisService } from './toneAnalysisService.js';
import { randomUUID } from 'crypto';

export class AudioInsightsService {
  private defaultOptions: Required<AudioAnalysisOptions>;

  constructor() {
    this.defaultOptions = {
      chunkDuration: 45,
      enableSpeakerIdentification: true,
      enableSentimentAnalysis: true,
      enableToneAnalysis: true,
      language: 'en',
      model: 'openai',
      provider: 'openai'
    };
  }

  /**
   * Main method to analyze audio file and generate comprehensive insights
   */
  async analyzeAudioFile(
    audioBuffer: Buffer, 
    filename: string, 
    options: AudioAnalysisOptions = {}
  ): Promise<AudioAnalysisResult> {
    const startTime = Date.now();
    
    try {
      // Merge options with defaults
      const analysisOptions = { ...this.defaultOptions, ...options };
      
      // Validate audio file
      const validation = await audioChunkingService.validateAudioFile(audioBuffer);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Invalid audio file format'
        };
      }

      // Step 1: Chunk the audio file into segments
      console.log(`Chunking audio file into ${analysisOptions.chunkDuration}s segments...`);
      const audioChunks = await audioChunkingService.chunkAudioFile(audioBuffer, filename, validation.duration);
      console.log(`Created ${audioChunks.length} audio chunks`);

      // Step 2: Transcribe each chunk with timestamps
      console.log(`Transcribing audio chunks with ${analysisOptions.provider}...`);
      const transcriptionService = new AudioTranscriptionService({
        language: analysisOptions.language,
        model: analysisOptions.model === 'openai' ? 'whisper-1' : 'nova-2-general',
        provider: analysisOptions.provider,
        responseFormat: 'verbose_json',
        timestamp_granularities: ['word', 'segment']
      });
      const transcriptionResults = await transcriptionService.transcribeChunks(audioChunks);
      
      // Step 3: Combine transcriptions and add to chunks
      const chunksWithTranscripts: AudioChunk[] = audioChunks.map((chunk, index) => ({
        ...chunk,
        transcript: transcriptionResults[index]?.text || '',
        // Remove audioData to reduce response size
        audioData: Buffer.alloc(0)
      }));

      console.log(`Transcription completed for ${chunksWithTranscripts.length} chunks`);

      // Step 4: Analyze the chunks
      console.log('Analyzing audio chunks...');
      const analyzedChunks = await this.analyzeChunks(chunksWithTranscripts, analysisOptions);

      // Step 4: Generate overall insights
      console.log('Generating overall insights...');
      const insights = await this.generateOverallInsights(
        analyzedChunks, 
        filename, 
        validation.duration || 0,
        startTime,
        audioBuffer.length,
        analysisOptions
      );

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        insights,
        processingTime
      };

    } catch (error) {
      console.error('Audio analysis failed:', error);
      return {
        success: false,
        error: (error as Error).message,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Analyze individual chunks with all enabled services
   */
  private async analyzeChunks(
    chunks: AudioChunk[], 
    options: Required<AudioAnalysisOptions>
  ): Promise<AudioChunk[]> {
    const analyzedChunks: AudioChunk[] = [];

    // First, do conversation-aware speaker identification
    let speakerResults: Array<{chunkId: string, speaker: SpeakerInfo}> = [];
    if (options.enableSpeakerIdentification) {
      try {
        console.log('Performing conversation-aware speaker identification...');
        const chunkData = chunks.map(chunk => ({
          id: chunk.id,
          transcript: chunk.transcript || '',
          startTime: chunk.startTime,
          endTime: chunk.endTime
        }));
        speakerResults = await speakerIdentificationService.analyzeConversationSpeakers(chunkData);
        console.log(`Speaker identification completed for ${speakerResults.length} chunks`);
      } catch (error) {
        console.error('Conversation speaker identification failed:', error);
      }
    }

    // Process each chunk
    for (const chunk of chunks) {
      if (!chunk.transcript || chunk.transcript.trim().length === 0) {
        analyzedChunks.push(chunk);
        continue;
      }

      const analyzedChunk = { ...chunk };

      // Apply speaker identification results
      if (options.enableSpeakerIdentification) {
        const speakerResult = speakerResults.find(s => s.chunkId === chunk.id);
        if (speakerResult) {
          analyzedChunk.speaker = speakerResult.speaker;
        } else {
          // Fallback to individual analysis
          try {
            analyzedChunk.speaker = await speakerIdentificationService.identifySpeakerType(
              chunk.transcript
            );
          } catch (error) {
            console.error(`Speaker identification failed for chunk ${chunk.id}:`, error);
          }
        }
      }

      // Sentiment analysis
      if (options.enableSentimentAnalysis) {
        try {
          analyzedChunk.sentiment = await sentimentAnalysisService.analyzeSentiment(
            chunk.transcript
          );
        } catch (error) {
          console.error(`Sentiment analysis failed for chunk ${chunk.id}:`, error);
        }
      }

      // Tone analysis
      if (options.enableToneAnalysis) {
        try {
          analyzedChunk.tone = await toneAnalysisService.analyzeTone(
            chunk.transcript
          );
        } catch (error) {
          console.error(`Tone analysis failed for chunk ${chunk.id}:`, error);
        }
      }

      analyzedChunks.push(analyzedChunk);
    }

    return analyzedChunks;
  }

  /**
   * Generate overall insights from analyzed chunks
   */
  private async generateOverallInsights(
    chunks: AudioChunk[],
    filename: string,
    duration: number,
    startTime: number,
    fileSize: number,
    options: Required<AudioAnalysisOptions>
  ): Promise<AudioInsights> {
    console.log(`Generating insights for ${chunks.length} chunks`);
    
    // Combine transcripts from all chunks
    const overallTranscript = chunks
      .map(chunk => chunk.transcript || '')
      .filter(text => text.trim().length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`Overall transcript length: ${overallTranscript.length}`);

    // Create timestamped transcript from all chunks
    const timestampedTranscript: Array<{
      text: string;
      start: number;
      end: number;
      chunkId: string;
    }> = [];

    chunks.forEach(chunk => {
      if (chunk.transcript) {
        // For now, we'll create a single timestamp entry per chunk
        // In a more sophisticated implementation, we could extract word-level timestamps
        timestampedTranscript.push({
          text: chunk.transcript,
          start: chunk.startTime,
          end: chunk.endTime,
          chunkId: chunk.id
        });
      }
    });

    // Analyze speakers and calculate speaking times
    const agentChunks = chunks.filter(chunk => chunk.speaker?.speakerType === 'agent');
    const userChunks = chunks.filter(chunk => chunk.speaker?.speakerType === 'user');
    
    const agentSpeakingTime = agentChunks.reduce((total, chunk) => total + chunk.duration, 0);
    const userSpeakingTime = userChunks.reduce((total, chunk) => total + chunk.duration, 0);
    const totalSpeakingTime = agentSpeakingTime + userSpeakingTime;
    
    const agentPercentage = totalSpeakingTime > 0 ? (agentSpeakingTime / totalSpeakingTime) * 100 : 0;
    const userPercentage = totalSpeakingTime > 0 ? (userSpeakingTime / totalSpeakingTime) * 100 : 0;

    // Analyze overall sentiment
    const sentiments = chunks
      .filter(chunk => chunk.sentiment)
      .map(chunk => chunk.sentiment!);
    
    const overallSentiment = sentimentAnalysisService.getOverallSentiment(sentiments);

    // Analyze tones
    const tones = chunks
      .filter(chunk => chunk.tone)
      .map(chunk => chunk.tone!);
    
    const dominantTone = toneAnalysisService.getOverallTone(tones);

    // Extract key topics
    const keyTopics = await this.extractKeyTopics(overallTranscript);

    // Generate conversation flow and key moments
    const conversationFlow = this.generateConversationFlow(chunks);
    const keyMoments = this.identifyKeyMoments(chunks);

    // Analyze conversation quality
    const conversationQuality = this.analyzeConversationQuality(chunks, overallSentiment, dominantTone);

    // Generate participant characteristics
    const agentCharacteristics = this.analyzeParticipantCharacteristics(agentChunks);
    const userCharacteristics = this.analyzeParticipantCharacteristics(userChunks);

    const insights = {
      id: randomUUID(),
      filename,
      duration,
      chunks,
      overallTranscript,
      timestampedTranscript,
      conversation: {
        participants: {
          agent: {
            speakingTime: agentSpeakingTime,
            percentage: Math.round(agentPercentage * 100) / 100,
            characteristics: agentCharacteristics
          },
          user: {
            speakingTime: userSpeakingTime,
            percentage: Math.round(userPercentage * 100) / 100,
            characteristics: userCharacteristics
          }
        },
        flow: conversationFlow,
        keyMoments
      },
      analysis: {
        overallSentiment,
        keyTopics,
        conversationQuality
      },
      metadata: {
        processingTime: Date.now() - startTime,
        createdAt: new Date(),
        fileSize,
        audioFormat: 'wav'
      }
    };
    
    console.log(`Generated insights with ${chunks.length} chunks and transcript length ${overallTranscript.length}`);
    return insights;
  }

  /**
   * Extract key topics from the overall transcript
   */
  private async extractKeyTopics(transcript: string): Promise<string[]> {
    try {
      // Simple keyword extraction - in a real implementation, you might use more sophisticated NLP
      const words = transcript.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(word => word.length > 3);

      const wordCount: {[key: string]: number} = {};
      words.forEach(word => {
        wordCount[word] = (wordCount[word] || 0) + 1;
      });

      // Filter out common words and get top topics
      const commonWords = new Set([
        'the', 'and', 'that', 'this', 'with', 'have', 'from', 'they', 'know', 'want',
        'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just',
        'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than', 'them', 'well',
        'were', 'what', 'your', 'said', 'each', 'which', 'their', 'will', 'about', 'out',
        'there', 'more', 'also', 'into', 'only', 'other', 'new', 'some', 'time', 'very',
        'when', 'come', 'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such'
      ]);

      const topics = Object.entries(wordCount)
        .filter(([word, count]) => !commonWords.has(word) && count > 1)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([word]) => word);

      return topics;
    } catch (error) {
      console.error('Key topic extraction failed:', error);
      return [];
    }
  }

  /**
   * Generate conversation flow from chunks
   */
  private generateConversationFlow(chunks: AudioChunk[]): Array<{
    timestamp: number;
    speaker: 'agent' | 'user' | 'unknown';
    text: string;
    sentiment: string;
    tone: string;
  }> {
    const flow: Array<{
      timestamp: number;
      speaker: 'agent' | 'user' | 'unknown';
      text: string;
      sentiment: string;
      tone: string;
    }> = [];
    
    // Create flow entries for each chunk
    chunks.forEach(chunk => {
      if (chunk.transcript && chunk.transcript.trim().length > 0) {
        flow.push({
          timestamp: chunk.startTime,
          speaker: chunk.speaker?.speakerType || 'unknown',
          text: chunk.transcript.substring(0, 100) + (chunk.transcript.length > 100 ? '...' : ''),
          sentiment: chunk.sentiment?.overall || 'neutral',
          tone: chunk.tone?.tone || 'neutral'
        });
      }
    });

    return flow.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Identify key moments in the conversation
   */
  private identifyKeyMoments(chunks: AudioChunk[]): Array<{
    timestamp: number;
    description: string;
    importance: 'high' | 'medium' | 'low';
  }> {
    const keyMoments: Array<{
      timestamp: number;
      description: string;
      importance: 'high' | 'medium' | 'low';
    }> = [];

    chunks.forEach(chunk => {
      if (!chunk.transcript) return;

      const text = chunk.transcript.toLowerCase();
      
      // High importance moments
      if (text.includes('price') || text.includes('cost') || text.includes('fee')) {
        keyMoments.push({
          timestamp: chunk.startTime,
          description: 'Pricing discussion',
          importance: 'high'
        });
      }
      
      if (text.includes('yes') && text.includes('interested')) {
        keyMoments.push({
          timestamp: chunk.startTime,
          description: 'Customer expressed interest',
          importance: 'high'
        });
      }

      // Medium importance moments
      if (text.includes('question') || text.includes('ask')) {
        keyMoments.push({
          timestamp: chunk.startTime,
          description: 'Customer asked questions',
          importance: 'medium'
        });
      }

      if (text.includes('thank') && chunk.speaker?.speakerType === 'user') {
        keyMoments.push({
          timestamp: chunk.startTime,
          description: 'Customer expressed gratitude',
          importance: 'medium'
        });
      }

      // Low importance moments
      if (text.includes('bye') || text.includes('goodbye')) {
        keyMoments.push({
          timestamp: chunk.startTime,
          description: 'Conversation ending',
          importance: 'low'
        });
      }
    });

    return keyMoments.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Analyze conversation quality
   */
  private analyzeConversationQuality(
    chunks: AudioChunk[], 
    overallSentiment: SentimentAnalysis, 
    dominantTone: ToneAnalysis
  ): {
    engagement: 'high' | 'medium' | 'low';
    professionalism: 'high' | 'medium' | 'low';
    outcome: 'positive' | 'neutral' | 'negative';
  } {
    const agentChunks = chunks.filter(chunk => chunk.speaker?.speakerType === 'agent');
    const userChunks = chunks.filter(chunk => chunk.speaker?.speakerType === 'user');
    
    // Engagement: based on user participation and sentiment
    const userEngagement = userChunks.length > 0 ? userChunks.length / chunks.length : 0;
    const engagement = userEngagement > 0.3 ? 'high' : userEngagement > 0.15 ? 'medium' : 'low';
    
    // Professionalism: based on agent tone and language
    const professionalTones = agentChunks.filter(chunk => 
      chunk.tone?.tone === 'professional' || chunk.tone?.tone === 'confident'
    ).length;
    const professionalism = professionalTones / agentChunks.length > 0.7 ? 'high' : 
                           professionalTones / agentChunks.length > 0.4 ? 'medium' : 'low';
    
    // Outcome: based on overall sentiment and conversation end
    const outcome = overallSentiment.overall === 'positive' ? 'positive' : 
                   overallSentiment.overall === 'negative' ? 'negative' : 'neutral';

    return { engagement, professionalism, outcome };
  }

  /**
   * Analyze participant characteristics
   */
  private analyzeParticipantCharacteristics(chunks: AudioChunk[]): {
    dominantTone: string;
    averageSentiment: string;
    confidence: number;
  } {
    if (chunks.length === 0) {
      return {
        dominantTone: 'unknown',
        averageSentiment: 'neutral',
        confidence: 0
      };
    }

    const tones = chunks.filter(chunk => chunk.tone).map(chunk => chunk.tone!);
    const sentiments = chunks.filter(chunk => chunk.sentiment).map(chunk => chunk.sentiment!);
    
    const dominantTone = tones.length > 0 ? 
      toneAnalysisService.getOverallTone(tones).tone : 'unknown';
    
    const averageSentiment = sentiments.length > 0 ? 
      sentimentAnalysisService.getOverallSentiment(sentiments).overall : 'neutral';
    
    const confidence = chunks.reduce((sum, chunk) => 
      sum + (chunk.speaker?.confidence || 0), 0) / chunks.length;

    return {
      dominantTone,
      averageSentiment,
      confidence: Math.round(confidence * 100) / 100
    };
  }

  /**
   * Get analysis statistics
   */
  getAnalysisStats(insights: AudioInsights): {
    totalChunks: number;
    averageChunkDuration: number;
    transcriptionCoverage: number;
    analysisCoverage: {
      speakerIdentification: number;
      sentimentAnalysis: number;
      toneAnalysis: number;
    };
  } {
    const totalChunks = insights.chunks.length;
    const averageChunkDuration = insights.duration / totalChunks;
    
    const transcribedChunks = insights.chunks.filter(chunk => chunk.transcript && chunk.transcript.trim().length > 0);
    const transcriptionCoverage = transcribedChunks.length / totalChunks;
    
    const speakerIdentified = insights.chunks.filter(chunk => chunk.speaker).length;
    const sentimentAnalyzed = insights.chunks.filter(chunk => chunk.sentiment).length;
    const toneAnalyzed = insights.chunks.filter(chunk => chunk.tone).length;
    
    return {
      totalChunks,
      averageChunkDuration,
      transcriptionCoverage,
      analysisCoverage: {
        speakerIdentification: speakerIdentified / totalChunks,
        sentimentAnalysis: sentimentAnalyzed / totalChunks,
        toneAnalysis: toneAnalyzed / totalChunks
      }
    };
  }

  /**
   * Export insights to different formats
   */
  exportInsights(insights: AudioInsights, format: 'json' | 'summary' = 'json'): any {
    if (format === 'summary') {
      return {
        filename: insights.filename,
        duration: insights.duration,
        conversation: insights.conversation,
        analysis: insights.analysis,
        metadata: insights.metadata
      };
    }
    
    return insights;
  }
}

export const audioInsightsService = new AudioInsightsService();