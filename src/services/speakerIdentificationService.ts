import { SpeakerInfo } from '../types/audioAnalysis.js';
import { openai } from './openai.js';
import { groq } from './groq.js';

export interface SpeakerIdentificationOptions {
  model?: 'openai' | 'groq';
  enableGenderDetection?: boolean;
  enableAgeDetection?: boolean;
  enableAccentDetection?: boolean;
}

export interface SpeakerCharacteristics {
  gender?: 'male' | 'female' | 'unknown';
  ageRange?: 'young' | 'middle' | 'senior' | 'unknown';
  accent?: string;
  confidence: number;
}

export class SpeakerIdentificationService {
  private options: Required<SpeakerIdentificationOptions>;

  constructor(options: SpeakerIdentificationOptions = {}) {
    this.options = {
      model: options.model || 'openai',
      enableGenderDetection: options.enableGenderDetection ?? true,
      enableAgeDetection: options.enableAgeDetection ?? true,
      enableAccentDetection: options.enableAccentDetection ?? true
    };
  }

  /**
   * Identify speaker type (agent vs user) based on transcript content
   */
  async identifySpeakerType(transcript: string, context?: string): Promise<SpeakerInfo> {
    try {
      const prompt = this.buildSpeakerIdentificationPrompt(transcript, context);
      
      let response: string;
      if (this.options.model === 'groq') {
        response = await this.analyzeWithGroq(prompt);
      } else {
        response = await this.analyzeWithOpenAI(prompt);
      }

      const result = this.parseSpeakerIdentification(response);
      return result;
    } catch (error) {
      console.error('Speaker identification failed:', error);
      return {
        speakerId: 'unknown',
        speakerType: 'unknown',
        confidence: 0,
        characteristics: {
          gender: 'unknown',
          ageRange: 'unknown',
          accent: 'unknown'
        }
      };
    }
  }

  /**
   * Analyze conversation flow to identify speakers more accurately
   */
  async analyzeConversationSpeakers(
    chunks: Array<{id: string, transcript: string, startTime: number, endTime: number}>
  ): Promise<Array<{chunkId: string, speaker: SpeakerInfo}>> {
    try {
      // Create conversation context
      const conversationContext = chunks.map((chunk, index) => 
        `Chunk ${index + 1} (${chunk.startTime}s-${chunk.endTime}s): ${chunk.transcript}`
      ).join('\n\n');

      const prompt = this.buildConversationAnalysisPrompt(conversationContext);
      
      let response: string;
      if (this.options.model === 'groq') {
        response = await this.analyzeWithGroq(prompt);
      } else {
        response = await this.analyzeWithOpenAI(prompt);
      }

      return this.parseConversationAnalysis(response, chunks);
    } catch (error) {
      console.error('Conversation speaker analysis failed:', error);
      // Fallback to individual analysis
      const results = [];
      for (const chunk of chunks) {
        const speaker = await this.identifySpeakerType(chunk.transcript);
        results.push({ chunkId: chunk.id, speaker });
      }
      return results;
    }
  }

  /**
   * Analyze speaker characteristics (gender, age, accent)
   */
  async analyzeSpeakerCharacteristics(transcript: string): Promise<SpeakerCharacteristics> {
    if (!this.options.enableGenderDetection && 
        !this.options.enableAgeDetection && 
        !this.options.enableAccentDetection) {
      return { confidence: 0 };
    }

    try {
      const prompt = this.buildCharacteristicsPrompt(transcript);
      
      let response: string;
      if (this.options.model === 'groq') {
        response = await this.analyzeWithGroq(prompt);
      } else {
        response = await this.analyzeWithOpenAI(prompt);
      }

      return this.parseCharacteristics(response);
    } catch (error) {
      console.error('Speaker characteristics analysis failed:', error);
      return { confidence: 0 };
    }
  }

  /**
   * Identify multiple speakers in a conversation
   */
  async identifyMultipleSpeakers(transcripts: string[]): Promise<SpeakerInfo[]> {
    const speakerPromises = transcripts.map(transcript => 
      this.identifySpeakerType(transcript)
    );
    
    return Promise.all(speakerPromises);
  }

  /**
   * Build prompt for speaker type identification
   */
  private buildSpeakerIdentificationPrompt(transcript: string, context?: string): string {
    return `Analyze the following conversation transcript and determine if the speaker is a sales agent or a customer/user.

${context ? `Context: ${context}\n` : ''}
Transcript: "${transcript}"

Return your analysis in the following JSON format:
{
  "speakerType": "agent" | "user" | "unknown",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation of your decision"
}

Consider these indicators:
- Sales agents typically: ask qualifying questions, present features/benefits, discuss pricing, use professional language, guide the conversation
- Customers typically: ask questions about products, express needs/concerns, discuss their situation, respond to agent questions
- Look for sales terminology, product knowledge, and conversation flow patterns`;
  }

  /**
   * Build prompt for conversation analysis
   */
  private buildConversationAnalysisPrompt(conversationContext: string): string {
    return `Analyze this phone conversation between a sales agent and a potential customer. Identify which speaker is talking in each chunk.

Conversation:
${conversationContext}

Return your analysis in the following JSON format:
{
  "speakers": [
    {
      "chunkId": "chunk-id",
      "speakerType": "agent" | "user" | "unknown",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation"
    }
  ],
  "conversationPattern": {
    "agentCharacteristics": ["list of agent speech patterns"],
    "userCharacteristics": ["list of user speech patterns"],
    "turnTakingPattern": "description of how speakers alternate"
  }
}

Key indicators for identification:
- AGENT: Professional language, asks qualifying questions, presents company information, guides conversation flow, uses sales terminology
- USER: Responds to questions, shares personal information, asks about products/services, uses casual language
- Look for conversation flow patterns and speech characteristics that distinguish the two speakers`;
  }

  /**
   * Build prompt for speaker characteristics analysis
   */
  private buildCharacteristicsPrompt(transcript: string): string {
    const analysisTypes = [];
    if (this.options.enableGenderDetection) analysisTypes.push('gender');
    if (this.options.enableAgeDetection) analysisTypes.push('age range');
    if (this.options.enableAccentDetection) analysisTypes.push('accent/regional speech patterns');

    return `Analyze the following speech transcript for speaker characteristics.

Transcript: "${transcript}"

Analyze the following characteristics: ${analysisTypes.join(', ')}

Return your analysis in the following JSON format:
{
  "gender": "male" | "female" | "unknown",
  "ageRange": "young" | "middle" | "senior" | "unknown",
  "accent": "description of accent or 'unknown'",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation of your analysis"
}

Consider:
- Speech patterns, vocabulary choice, and linguistic features
- Formality level and communication style
- Any regional or cultural indicators in language use`;
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
          content: 'You are an expert in speech analysis and speaker identification. Always respond with valid JSON.'
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
          content: 'You are an expert in speech analysis and speaker identification. Always respond with valid JSON.'
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
   * Parse speaker identification response
   */
  private parseSpeakerIdentification(response: string): SpeakerInfo {
    try {
      const parsed = JSON.parse(response);
      return {
        speakerId: parsed.speakerType === 'agent' ? 'agent' : 
                  parsed.speakerType === 'user' ? 'user' : 'unknown',
        speakerType: parsed.speakerType || 'unknown',
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0))
      };
    } catch (error) {
      console.error('Failed to parse speaker identification:', error);
      return {
        speakerId: 'unknown',
        speakerType: 'unknown',
        confidence: 0
      };
    }
  }

  /**
   * Parse characteristics response
   */
  private parseCharacteristics(response: string): SpeakerCharacteristics {
    try {
      const parsed = JSON.parse(response);
      return {
        gender: parsed.gender || 'unknown',
        ageRange: parsed.ageRange || 'unknown',
        accent: parsed.accent || 'unknown',
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0))
      };
    } catch (error) {
      console.error('Failed to parse characteristics:', error);
      return { confidence: 0 };
    }
  }

  /**
   * Parse conversation analysis response
   */
  private parseConversationAnalysis(
    response: string, 
    chunks: Array<{id: string, transcript: string, startTime: number, endTime: number}>
  ): Array<{chunkId: string, speaker: SpeakerInfo}> {
    try {
      const parsed = JSON.parse(response);
      const results: Array<{chunkId: string, speaker: SpeakerInfo}> = [];
      
      if (parsed.speakers && Array.isArray(parsed.speakers)) {
        for (const speakerData of parsed.speakers) {
          const chunk = chunks.find(c => c.id === speakerData.chunkId);
          if (chunk) {
            results.push({
              chunkId: speakerData.chunkId,
              speaker: {
                speakerId: speakerData.speakerType === 'agent' ? 'agent' : 
                          speakerData.speakerType === 'user' ? 'user' : 'unknown',
                speakerType: speakerData.speakerType || 'unknown',
                confidence: Math.max(0, Math.min(1, speakerData.confidence || 0))
              }
            });
          }
        }
      }
      
      return results;
    } catch (error) {
      console.error('Failed to parse conversation analysis:', error);
      // Fallback to unknown speakers
      return chunks.map(chunk => ({
        chunkId: chunk.id,
        speaker: {
          speakerId: 'unknown',
          speakerType: 'unknown',
          confidence: 0
        }
      }));
    }
  }

  /**
   * Group speakers by type across multiple transcripts
   */
  groupSpeakersByType(speakers: SpeakerInfo[]): {agents: SpeakerInfo[], users: SpeakerInfo[], unknown: SpeakerInfo[]} {
    return speakers.reduce((groups, speaker) => {
      if (speaker.speakerType === 'agent') {
        groups.agents.push(speaker);
      } else if (speaker.speakerType === 'user') {
        groups.users.push(speaker);
      } else {
        groups.unknown.push(speaker);
      }
      return groups;
    }, { agents: [] as SpeakerInfo[], users: [] as SpeakerInfo[], unknown: [] as SpeakerInfo[] });
  }
}

export const speakerIdentificationService = new SpeakerIdentificationService();