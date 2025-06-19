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
      model: "gpt-4o",
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
