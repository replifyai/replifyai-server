import { ToneAnalysis } from '../types/audioAnalysis.js';
import { openai } from './openai.js';
import { groq } from './groq.js';

export interface ToneAnalysisOptions {
  model?: 'openai' | 'groq';
  enableFormalityAnalysis?: boolean;
  enableEnergyAnalysis?: boolean;
  enablePolitenessAnalysis?: boolean;
  language?: string;
}

export interface ToneCharacteristics {
  formality: 'formal' | 'informal' | 'mixed';
  energy: 'low' | 'medium' | 'high';
  politeness: 'polite' | 'neutral' | 'rude';
  confidence: number;
}

export class ToneAnalysisService {
  private options: Required<ToneAnalysisOptions>;

  constructor(options: ToneAnalysisOptions = {}) {
    this.options = {
      model: options.model || 'openai',
      enableFormalityAnalysis: options.enableFormalityAnalysis ?? true,
      enableEnergyAnalysis: options.enableEnergyAnalysis ?? true,
      enablePolitenessAnalysis: options.enablePolitenessAnalysis ?? true,
      language: options.language || 'en'
    };
  }

  /**
   * Analyze tone of a single transcript
   */
  async analyzeTone(transcript: string, context?: string): Promise<ToneAnalysis> {
    try {
      const prompt = this.buildTonePrompt(transcript, context);
      
      let response: string;
      if (this.options.model === 'groq') {
        response = await this.analyzeWithGroq(prompt);
      } else {
        response = await this.analyzeWithOpenAI(prompt);
      }

      return this.parseToneResponse(response);
    } catch (error) {
      console.error('Tone analysis failed:', error);
      return {
        tone: 'neutral',
        confidence: 0,
        characteristics: {
          formality: 'mixed',
          energy: 'medium',
          politeness: 'neutral'
        }
      };
    }
  }

  /**
   * Analyze tone for multiple transcripts
   */
  async analyzeMultipleTones(transcripts: string[]): Promise<ToneAnalysis[]> {
    const tonePromises = transcripts.map(transcript => 
      this.analyzeTone(transcript)
    );
    
    return Promise.all(tonePromises);
  }

  /**
   * Get overall tone from multiple analyses
   */
  getOverallTone(analyses: ToneAnalysis[]): ToneAnalysis {
    if (analyses.length === 0) {
      return {
        tone: 'neutral',
        confidence: 0,
        characteristics: {
          formality: 'mixed',
          energy: 'medium',
          politeness: 'neutral'
        }
      };
    }

    // Calculate weighted averages for characteristics
    const totalConfidence = analyses.reduce((sum, analysis) => sum + analysis.confidence, 0);
    
    const formalityScores = analyses.map(a => {
      const score = a.characteristics.formality === 'formal' ? 1 : 
                   a.characteristics.formality === 'mixed' ? 0.5 : 0;
      return score * a.confidence;
    });
    const avgFormality = formalityScores.reduce((sum, score) => sum + score, 0) / totalConfidence;
    
    const energyScores = analyses.map(a => {
      const score = a.characteristics.energy === 'high' ? 1 : 
                   a.characteristics.energy === 'medium' ? 0.5 : 0;
      return score * a.confidence;
    });
    const avgEnergy = energyScores.reduce((sum, score) => sum + score, 0) / totalConfidence;
    
    const politenessScores = analyses.map(a => {
      const score = a.characteristics.politeness === 'polite' ? 1 : 
                   a.characteristics.politeness === 'neutral' ? 0.5 : 0;
      return score * a.confidence;
    });
    const avgPoliteness = politenessScores.reduce((sum, score) => sum + score, 0) / totalConfidence;

    // Determine overall tone based on characteristics
    let tone: 'professional' | 'friendly' | 'aggressive' | 'defensive' | 'confident' | 'uncertain' | 'neutral';
    
    if (avgFormality > 0.7 && avgPoliteness > 0.6) {
      tone = 'professional';
    } else if (avgFormality < 0.3 && avgPoliteness > 0.6) {
      tone = 'friendly';
    } else if (avgPoliteness < 0.3) {
      tone = 'aggressive';
    } else if (avgEnergy < 0.3) {
      tone = 'defensive';
    } else if (avgEnergy > 0.7 && avgFormality > 0.5) {
      tone = 'confident';
    } else if (avgEnergy < 0.4 && avgFormality < 0.5) {
      tone = 'uncertain';
    } else {
      tone = 'neutral';
    }

    // Calculate average confidence
    const avgConfidence = totalConfidence / analyses.length;

    return {
      tone,
      confidence: avgConfidence,
      characteristics: {
        formality: avgFormality > 0.6 ? 'formal' : avgFormality < 0.4 ? 'informal' : 'mixed',
        energy: avgEnergy > 0.6 ? 'high' : avgEnergy < 0.4 ? 'low' : 'medium',
        politeness: avgPoliteness > 0.6 ? 'polite' : avgPoliteness < 0.4 ? 'rude' : 'neutral'
      }
    };
  }

  /**
   * Build tone analysis prompt
   */
  private buildTonePrompt(transcript: string, context?: string): string {
    const formalityAnalysis = this.options.enableFormalityAnalysis ? 
      'Analyze the formality level (formal, informal, mixed). ' : '';
    
    const energyAnalysis = this.options.enableEnergyAnalysis ?
      'Analyze the energy level (low, medium, high). ' : '';
    
    const politenessAnalysis = this.options.enablePolitenessAnalysis ?
      'Analyze the politeness level (polite, neutral, rude). ' : '';

    return `Analyze the tone and communication style in the following conversation transcript.

${context ? `Context: ${context}\n` : ''}
Transcript: "${transcript}"

${formalityAnalysis}${energyAnalysis}${politenessAnalysis}Consider the speaker's communication style, word choice, and overall approach.

Return your analysis in the following JSON format:
{
  "tone": "professional" | "friendly" | "aggressive" | "defensive" | "confident" | "uncertain" | "neutral",
  "confidence": 0.0-1.0,
  "characteristics": {
    "formality": "formal" | "informal" | "mixed",
    "energy": "low" | "medium" | "high",
    "politeness": "polite" | "neutral" | "rude"
  },
  "reasoning": "brief explanation of your analysis"
}

Consider:
- Professional: formal language, structured approach, business-like
- Friendly: casual language, warm approach, personal connection
- Aggressive: confrontational, demanding, forceful
- Defensive: protective, guarded, reactive
- Confident: assertive, decisive, self-assured
- Uncertain: hesitant, questioning, unsure
- Neutral: balanced, factual, objective`;
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
          content: 'You are an expert in communication analysis and tone detection. Always respond with valid JSON.'
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
          content: 'You are an expert in communication analysis and tone detection. Always respond with valid JSON.'
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
   * Parse tone analysis response
   */
  private parseToneResponse(response: string): ToneAnalysis {
    try {
      const parsed = JSON.parse(response);
      
      return {
        tone: parsed.tone || 'neutral',
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
        characteristics: {
          formality: parsed.characteristics?.formality || 'mixed',
          energy: parsed.characteristics?.energy || 'medium',
          politeness: parsed.characteristics?.politeness || 'neutral'
        }
      };
    } catch (error) {
      console.error('Failed to parse tone response:', error);
      return {
        tone: 'neutral',
        confidence: 0,
        characteristics: {
          formality: 'mixed',
          energy: 'medium',
          politeness: 'neutral'
        }
      };
    }
  }

  /**
   * Detect tone changes over time
   */
  detectToneChanges(analyses: ToneAnalysis[]): {
    changes: Array<{index: number, from: ToneAnalysis, to: ToneAnalysis, significance: number}>;
    overallShift: 'positive' | 'negative' | 'neutral';
  } {
    const changes: Array<{index: number, from: ToneAnalysis, to: ToneAnalysis, significance: number}> = [];
    
    for (let i = 1; i < analyses.length; i++) {
      const from = analyses[i-1];
      const to = analyses[i];
      
      // Calculate significance of change
      const toneChange = this.calculateToneChangeSignificance(from, to);
      
      if (toneChange > 0.3) { // Threshold for significant change
        changes.push({
          index: i,
          from,
          to,
          significance: toneChange
        });
      }
    }

    // Determine overall shift
    let positiveShifts = 0;
    let negativeShifts = 0;
    
    changes.forEach(change => {
      const fromScore = this.getToneScore(change.from.tone);
      const toScore = this.getToneScore(change.to.tone);
      
      if (toScore > fromScore) {
        positiveShifts++;
      } else if (toScore < fromScore) {
        negativeShifts++;
      }
    });

    let overallShift: 'positive' | 'negative' | 'neutral';
    if (positiveShifts > negativeShifts) {
      overallShift = 'positive';
    } else if (negativeShifts > positiveShifts) {
      overallShift = 'negative';
    } else {
      overallShift = 'neutral';
    }

    return { changes, overallShift };
  }

  /**
   * Calculate significance of tone change
   */
  private calculateToneChangeSignificance(from: ToneAnalysis, to: ToneAnalysis): number {
    let significance = 0;
    
    // Tone change
    if (from.tone !== to.tone) {
      significance += 0.4;
    }
    
    // Formality change
    if (from.characteristics.formality !== to.characteristics.formality) {
      significance += 0.2;
    }
    
    // Energy change
    if (from.characteristics.energy !== to.characteristics.energy) {
      significance += 0.2;
    }
    
    // Politeness change
    if (from.characteristics.politeness !== to.characteristics.politeness) {
      significance += 0.2;
    }
    
    return Math.min(1, significance);
  }

  /**
   * Get numerical score for tone (for comparison)
   */
  private getToneScore(tone: string): number {
    const scores: {[key: string]: number} = {
      'aggressive': 1,
      'defensive': 2,
      'uncertain': 3,
      'neutral': 4,
      'friendly': 5,
      'professional': 6,
      'confident': 7
    };
    
    return scores[tone] || 4;
  }
}

export const toneAnalysisService = new ToneAnalysisService();