// Add fetch polyfill for Node.js compatibility
import fetch, { Headers, Request, Response } from 'node-fetch';

if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = fetch as any;
  globalThis.Headers = Headers as any;
  globalThis.Request = Request as any;
  globalThis.Response = Response as any;
}

// Add AbortController polyfill if not available
if (typeof globalThis.AbortController === 'undefined') {
  globalThis.AbortController = class AbortController {
    signal: AbortSignal;
    
    constructor() {
      this.signal = new AbortSignal();
    }
    
    abort() {
      // Simple implementation - in a real scenario you'd trigger the abort
      (this.signal as any).aborted = true;
    }
  } as any;
  
  globalThis.AbortSignal = class AbortSignal {
    aborted: boolean = false;
    
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  } as any;
}

// Add FormData polyfill if not available
if (typeof globalThis.FormData === 'undefined') {
  globalThis.FormData = class FormData {
    private data: Map<string, any> = new Map();
    
    append(name: string, value: any) {
      this.data.set(name, value);
    }
    
    get(name: string) {
      return this.data.get(name);
    }
    
    has(name: string) {
      return this.data.has(name);
    }
  } as any;
}

// Add Blob polyfill if not available
if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = class Blob {
    constructor(chunks?: any[], options?: any) {
      // Simple blob implementation for Node.js
      this.size = 0;
      this.type = options?.type || '';
    }
    size: number;
    type: string;
  } as any;
}

import OpenAI from "openai";
import { env } from "../env";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR || "default_key",
  timeout: env.API_TIMEOUT, // Use environment variable for timeout
});

export async function createEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: text,
    });

    return response.data[0].embedding;
  } catch (error) {
    throw new Error(`Failed to create embedding: ${(error as Error).message}`);
  }
}

export async function generateChatResponse(prompt: string, context: string[]): Promise<string> {
  try {
    const systemPrompt = `You are a helpful AI assistant that answers questions based ONLY on the provided context from uploaded documents. 

IMPORTANT RULES:
1. Only use information from the provided context
2. If the context doesn't contain enough information to answer the question, say "I don't have enough information in the uploaded documents to answer this question."
3. Always cite which document(s) your answer comes from
4. Be concise but thorough
5. Do not make up or infer information not present in the context

Context from uploaded documents:
${context.join('\n\n---\n\n')}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 1000,
    });

    return response.choices[0].message.content || "I couldn't generate a response.";
  } catch (error) {
    throw new Error(`Failed to generate chat response: ${(error as Error).message}`);
  }
}

export async function extractDocumentMetadata(text: string, filename: string): Promise<any> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "Extract metadata from the document text and provide a JSON response with categories, topics, document_type, and key_entities."
        },
        {
          role: "user",
          content: `Extract metadata from this document named "${filename}":\n\n${text.substring(0, 2000)}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    return JSON.parse(response.choices[0].message.content || "{}");
  } catch (error) {
    console.error("Failed to extract metadata:", error);
    return { categories: [], topics: [], document_type: "unknown", key_entities: [] };
  }
}

export async function cleanAndFormatText(noisyText: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a text cleaning specialist. Your job is to clean and format noisy text extracted from PDFs. 

RULES:
1. Fix scattered characters (e.g., "B a r e f o o t" → "Barefoot")
2. Remove excessive whitespace and fix spacing
3. Correct obvious OCR errors and garbled text
4. Maintain the original meaning and structure
5. Keep important formatting like bullet points, numbers, and sections
6. Remove redundant characters and fix word breaks
7. Ensure proper sentence structure and punctuation
8. Preserve technical terms, product names, and specific data
9. Return ONLY the cleaned text, no explanations or comments

The text may contain product information, specifications, or other structured data - preserve the logical structure while cleaning the formatting.`
        },
        {
          role: "user",
          content: `Clean and format this noisy text:\n\n${noisyText}`
        }
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });

    const cleanedText = response.choices[0].message.content || noisyText;
    return cleanedText.trim();
  } catch (error) {
    console.error("Failed to clean text:", error);
    // Return original text if cleaning fails
    return noisyText;
  }
}
