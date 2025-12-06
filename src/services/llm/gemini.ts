/**
 * Google Gemini LLM Provider
 * High-quality response generation using Gemini 2.5 Pro/Flash
 */
import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { env } from "../../env.js";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

// Model instances
let geminiPro: GenerativeModel | null = null;
let geminiFlash: GenerativeModel | null = null;

/**
 * Get or create Gemini Pro model instance
 */
function getGeminiPro(): GenerativeModel {
    if (!geminiPro) {
        geminiPro = genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 2048,
            }
        });
    }
    return geminiPro;
}

/**
 * Get or create Gemini Flash model instance (faster, for quick tasks)
 */
function getGeminiFlash(): GenerativeModel {
    if (!geminiFlash) {
        geminiFlash = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 1500,
            }
        });
    }
    return geminiFlash;
}

export interface GeminiChatOptions {
    model?: 'pro' | 'flash';
    temperature?: number;
    maxTokens?: number;
}

/**
 * Generate a chat response using Gemini
 * @param systemPrompt System instructions
 * @param userPrompt User's message
 * @param options Configuration options
 * @returns Generated response text
 */
export async function generateGeminiChatResponse(
    systemPrompt: string,
    userPrompt: string,
    options: GeminiChatOptions = {}
): Promise<string> {
    const { model = 'pro', temperature, maxTokens } = options;

    try {
        const geminiModel = model === 'flash' ? getGeminiFlash() : getGeminiPro();

        // Combine system prompt and user prompt
        const combinedPrompt = `${systemPrompt}\n\nUser Query: ${userPrompt}`;

        // Generate content with optional overrides
        const generationConfig: any = {};
        if (temperature !== undefined) generationConfig.temperature = temperature;
        if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;

        const result = await geminiModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: combinedPrompt }] }],
            ...(Object.keys(generationConfig).length > 0 && { generationConfig })
        });

        const response = result.response;
        const text = response.text();

        if (!text) {
            throw new Error('Empty response from Gemini');
        }

        return text;
    } catch (error) {
        console.error('❌ Gemini generation error:', error);
        throw new Error(`Gemini generation failed: ${(error as Error).message}`);
    }
}

/**
 * Generate a structured JSON response using Gemini
 * @param systemPrompt System instructions
 * @param userPrompt User's message
 * @param options Configuration options
 * @returns Parsed JSON object
 */
export async function generateGeminiJsonResponse<T = any>(
    systemPrompt: string,
    userPrompt: string,
    options: GeminiChatOptions = {}
): Promise<T> {
    const jsonSystemPrompt = `${systemPrompt}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown, no code blocks, just the JSON object.`;

    const response = await generateGeminiChatResponse(jsonSystemPrompt, userPrompt, {
        ...options,
        temperature: options.temperature ?? 0.2, // Lower temperature for structured output
    });

    try {
        // Clean response of any markdown artifacts
        let cleanedResponse = response.trim();
        if (cleanedResponse.startsWith('```json')) {
            cleanedResponse = cleanedResponse.slice(7);
        }
        if (cleanedResponse.startsWith('```')) {
            cleanedResponse = cleanedResponse.slice(3);
        }
        if (cleanedResponse.endsWith('```')) {
            cleanedResponse = cleanedResponse.slice(0, -3);
        }
        cleanedResponse = cleanedResponse.trim();

        return JSON.parse(cleanedResponse) as T;
    } catch (parseError) {
        console.error('❌ Failed to parse Gemini JSON response:', response);
        throw new Error(`Failed to parse Gemini JSON response: ${(parseError as Error).message}`);
    }
}

export { genAI };
