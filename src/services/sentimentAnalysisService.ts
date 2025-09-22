import { SentimentAnalysis } from '../types/audioAnalysis.js';
import { openai } from './openai.js';
import { groq } from './groq.js';

export interface SentimentAnalysisOptions {
  model?: 'openai' | 'groq';
  enableEmotionDetection?: boolean;
  enableIntensityAnalysis?: boolean;
  language?: string;
}

export interface EmotionScores {
  joy: number;
  anger: number;
  fear: number;
  sadness: number;
  surprise: number;
  disgust: number;
}

export class SentimentAnalysisService {
  private options: Required<SentimentAnalysisOptions>;

  constructor(options: SentimentAnalysisOptions = {}) {
    this.options = {
      model: options.model || 'openai',
      enableEmotionDetection: options.enableEmotionDetection ?? true,
      enableIntensityAnalysis: options.enableIntensityAnalysis ?? true,
      language: options.language || 'en'
    };
  }

  /**
   * Analyze sentiment of a single transcript
   */
  async analyzeSentiment(transcript: string, context?: string): Promise<SentimentAnalysis> {
    try {
      const prompt = this.buildSentimentPrompt(transcript, context);
      
      let response: string;
      if (this.options.model === 'groq') {
        response = await this.analyzeWithGroq(prompt);
      } else {
        response = await this.analyzeWithOpenAI(prompt);
      }

      return this.parseSentimentResponse(response);
    } catch (error) {
      console.error('Sentiment analysis failed:', error);
      return {
        overall: 'neutral',
        confidence: 0,
        emotions: {
          joy: 0,
          anger: 0,
          fear: 0,
          sadness: 0,
          surprise: 0,
          disgust: 0
        },
        intensity: 'low'
      };
    }
  }

  /**
   * Analyze sentiment for multiple transcripts
   */
  async analyzeMultipleSentiments(transcripts: string[]): Promise<SentimentAnalysis[]> {
    const sentimentPromises = transcripts.map(transcript => 
      this.analyzeSentiment(transcript)
    );
    
    return Promise.all(sentimentPromises);
  }

  /**
   * Get overall sentiment from multiple analyses
   */
  getOverallSentiment(analyses: SentimentAnalysis[]): SentimentAnalysis {
    if (analyses.length === 0) {
      return {
        overall: 'neutral',
        confidence: 0,
        emotions: {
          joy: 0,
          anger: 0,
          fear: 0,
          sadness: 0,
          surprise: 0,
          disgust: 0
        },
        intensity: 'low'
      };
    }

    // Calculate weighted averages
    const totalConfidence = analyses.reduce((sum, analysis) => sum + analysis.confidence, 0);
    const weightedEmotions = analyses.reduce((acc, analysis) => {
      const weight = analysis.confidence / totalConfidence;
      acc.joy += analysis.emotions.joy * weight;
      acc.anger += analysis.emotions.anger * weight;
      acc.fear += analysis.emotions.fear * weight;
      acc.sadness += analysis.emotions.sadness * weight;
      acc.surprise += analysis.emotions.surprise * weight;
      acc.disgust += analysis.emotions.disgust * weight;
      return acc;
    }, { joy: 0, anger: 0, fear: 0, sadness: 0, surprise: 0, disgust: 0 });

    // Determine overall sentiment
    const positiveScore = weightedEmotions.joy + weightedEmotions.surprise;
    const negativeScore = weightedEmotions.anger + weightedEmotions.fear + weightedEmotions.sadness + weightedEmotions.disgust;
    
    let overall: 'positive' | 'negative' | 'neutral';
    if (positiveScore > negativeScore + 0.1) {
      overall = 'positive';
    } else if (negativeScore > positiveScore + 0.1) {
      overall = 'negative';
    } else {
      overall = 'neutral';
    }

    // Calculate average confidence
    const avgConfidence = totalConfidence / analyses.length;

    // Determine intensity
    const maxEmotion = Math.max(...Object.values(weightedEmotions));
    let intensity: 'low' | 'medium' | 'high';
    if (maxEmotion > 0.7) {
      intensity = 'high';
    } else if (maxEmotion > 0.4) {
      intensity = 'medium';
    } else {
      intensity = 'low';
    }

    return {
      overall,
      confidence: avgConfidence,
      emotions: weightedEmotions,
      intensity
    };
  }

  /**
   * Build sentiment analysis prompt
   */
  private buildSentimentPrompt(transcript: string, context?: string): string {
    const emotionAnalysis = this.options.enableEmotionDetection ? 
      'Analyze the following emotions: joy, anger, fear, sadness, surprise, disgust. ' : '';
    
    const intensityAnalysis = this.options.enableIntensityAnalysis ?
      'Determine the emotional intensity level. ' : '';

    return `Analyze the sentiment and emotions in the following conversation transcript.

${context ? `Context: ${context}\n` : ''}
Transcript: "${transcript}"

${emotionAnalysis}${intensityAnalysis}Consider the speaker's tone, word choice, and emotional indicators.

Return your analysis in the following JSON format:
{
  "overall": "positive" | "negative" | "neutral",
  "confidence": 0.0-1.0,
  "emotions": {
    "joy": 0.0-1.0,
    "anger": 0.0-1.0,
    "fear": 0.0-1.0,
    "sadness": 0.0-1.0,
    "surprise": 0.0-1.0,
    "disgust": 0.0-1.0
  },
  "intensity": "low" | "medium" | "high",
  "reasoning": "brief explanation of your analysis"
}

Consider:
- Positive indicators: enthusiasm, satisfaction, agreement, excitement, gratitude
- Negative indicators: frustration, disappointment, anger, concern, disagreement
- Neutral indicators: factual statements, questions, neutral responses
- Emotional intensity based on word choice, punctuation, and context`;
  }

  /**
   * Analyze with OpenAI
   */
  private async analyzeWithOpenAI(prompt: string): Promise<string> {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert in sentiment analysis and emotion detection. Always respond with valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    });

    return response.choices[0]?.message?.content || '{}';
  }

  /**
   * Analyze with Groq
   */
  private async analyzeWithGroq(prompt: string): Promise<string> {
    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content: 'You are an expert in sentiment analysis and emotion detection. Always respond with valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    });

    return response.choices[0]?.message?.content || '{}';
  }

  /**
   * Parse sentiment analysis response
   */
  private parseSentimentResponse(response: string): SentimentAnalysis {
    try {
      const parsed = JSON.parse(response);
      
      return {
        overall: parsed.overall || 'neutral',
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
        emotions: {
          joy: Math.max(0, Math.min(1, parsed.emotions?.joy || 0)),
          anger: Math.max(0, Math.min(1, parsed.emotions?.anger || 0)),
          fear: Math.max(0, Math.min(1, parsed.emotions?.fear || 0)),
          sadness: Math.max(0, Math.min(1, parsed.emotions?.sadness || 0)),
          surprise: Math.max(0, Math.min(1, parsed.emotions?.surprise || 0)),
          disgust: Math.max(0, Math.min(1, parsed.emotions?.disgust || 0))
        },
        intensity: parsed.intensity || 'low'
      };
    } catch (error) {
      console.error('Failed to parse sentiment response:', error);
      return {
        overall: 'neutral',
        confidence: 0,
        emotions: {
          joy: 0,
          anger: 0,
          fear: 0,
          sadness: 0,
          surprise: 0,
          disgust: 0
        },
        intensity: 'low'
      };
    }
  }

  /**
   * Detect sentiment trends over time
   */
  detectSentimentTrends(analyses: SentimentAnalysis[]): {
    trend: 'improving' | 'declining' | 'stable';
    change: number; // -1 to 1
    keyMoments: Array<{index: number, sentiment: SentimentAnalysis, reason: string}>
  } {
    if (analyses.length < 2) {
      return {
        trend: 'stable',
        change: 0,
        keyMoments: []
      };
    }

    // Calculate sentiment scores over time
    const scores = analyses.map(analysis => {
      const positive = analysis.emotions.joy + analysis.emotions.surprise;
      const negative = analysis.emotions.anger + analysis.emotions.fear + 
                     analysis.emotions.sadness + analysis.emotions.disgust;
      return positive - negative;
    });

    // Calculate trend
    const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
    const secondHalf = scores.slice(Math.floor(scores.length / 2));
    
    const firstAvg = firstHalf.reduce((sum, score) => sum + score, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, score) => sum + score, 0) / secondHalf.length;
    
    const change = secondAvg - firstAvg;
    let trend: 'improving' | 'declining' | 'stable';
    
    if (change > 0.1) {
      trend = 'improving';
    } else if (change < -0.1) {
      trend = 'declining';
    } else {
      trend = 'stable';
    }

    // Find key moments (significant changes)
    const keyMoments: Array<{index: number, sentiment: SentimentAnalysis, reason: string}> = [];
    for (let i = 1; i < scores.length; i++) {
      const change = Math.abs(scores[i] - scores[i-1]);
      if (change > 0.5) {
        keyMoments.push({
          index: i,
          sentiment: analyses[i],
          reason: `Significant sentiment change: ${scores[i-1].toFixed(2)} → ${scores[i].toFixed(2)}`
        });
      }
    }

    return {
      trend,
      change: Math.max(-1, Math.min(1, change)),
      keyMoments
    };
  }
}

export const sentimentAnalysisService = new SentimentAnalysisService();