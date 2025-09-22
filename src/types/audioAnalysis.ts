export interface AudioChunk {
  id: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  duration: number; // in seconds
  audioData: Buffer;
  transcript?: string;
  speaker?: SpeakerInfo;
  sentiment?: SentimentAnalysis;
  tone?: ToneAnalysis;
}

export interface SpeakerInfo {
  speakerId: string;
  speakerType: 'agent' | 'user' | 'unknown';
  confidence: number; // 0-1
  characteristics?: {
    gender?: 'male' | 'female' | 'unknown';
    ageRange?: 'young' | 'middle' | 'senior' | 'unknown';
    accent?: string;
  };
}

export interface SentimentAnalysis {
  overall: 'positive' | 'negative' | 'neutral';
  confidence: number; // 0-1
  emotions: {
    joy?: number;
    anger?: number;
    fear?: number;
    sadness?: number;
    surprise?: number;
    disgust?: number;
  };
  intensity: 'low' | 'medium' | 'high';
}

export interface ToneAnalysis {
  tone: 'professional' | 'friendly' | 'aggressive' | 'defensive' | 'confident' | 'uncertain' | 'neutral';
  confidence: number; // 0-1
  characteristics: {
    formality: 'formal' | 'informal' | 'mixed';
    energy: 'low' | 'medium' | 'high';
    politeness: 'polite' | 'neutral' | 'rude';
  };
}

export interface AudioInsights {
  id: string;
  filename: string;
  duration: number; // total duration in seconds
  chunks: AudioChunk[];
  overallTranscript: string;
  timestampedTranscript: Array<{
    text: string;
    start: number;
    end: number;
    chunkId: string;
  }>;
  conversation: {
    participants: {
      agent: {
        speakingTime: number;
        percentage: number;
        characteristics: {
          dominantTone: string;
          averageSentiment: string;
          confidence: number;
        };
      };
      user: {
        speakingTime: number;
        percentage: number;
        characteristics: {
          dominantTone: string;
          averageSentiment: string;
          confidence: number;
        };
      };
    };
    flow: Array<{
      timestamp: number;
      speaker: 'agent' | 'user' | 'unknown';
      text: string;
      sentiment: string;
      tone: string;
    }>;
    keyMoments: Array<{
      timestamp: number;
      description: string;
      importance: 'high' | 'medium' | 'low';
    }>;
  };
  analysis: {
    overallSentiment: SentimentAnalysis;
    keyTopics: string[];
    conversationQuality: {
      engagement: 'high' | 'medium' | 'low';
      professionalism: 'high' | 'medium' | 'low';
      outcome: 'positive' | 'neutral' | 'negative';
    };
  };
  metadata: {
    processingTime: number; // in milliseconds
    createdAt: Date;
    fileSize: number;
    audioFormat: string;
  };
}

export interface ConversationFlow {
  timestamp: number;
  speaker: 'agent' | 'user' | 'unknown';
  action: 'speaking' | 'listening' | 'interrupting' | 'pausing';
  context?: string;
}

export interface AudioAnalysisOptions {
  chunkDuration?: number; // in seconds, default 45
  enableSpeakerIdentification?: boolean;
  enableSentimentAnalysis?: boolean;
  enableToneAnalysis?: boolean;
  language?: string;
  model?: string;
  provider?: 'openai' | 'deepgram';
}

export interface AudioAnalysisResult {
  success: boolean;
  insights?: AudioInsights;
  error?: string;
  processingTime?: number;
}