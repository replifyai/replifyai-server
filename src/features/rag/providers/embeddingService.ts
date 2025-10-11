import OpenAI from "openai";
import { env } from "../../../env.js";

/**
 * Embedding Service
 * 
 * This service provides a unified interface for creating embeddings using different providers.
 * Currently supports:
 * - OpenAI: text-embedding-ada-002 (default)
 * - Nebius: Qwen/Qwen3-Embedding-8B
 * 
 * Usage:
 * - Set EMBEDDING_PROVIDER environment variable to 'openai' or 'nebius'
 * - Set NEBIUS_API_KEY and NEBIUS_BASE_URL for Nebius provider
 * - Set OPENAI_API_KEY for OpenAI provider
 * 
 * The service automatically uses the provider specified in EMBEDDING_PROVIDER,
 * or defaults to OpenAI if not set.
 */

// OpenAI client for embeddings
const openai = new OpenAI({ 
  apiKey: env.OPENAI_API_KEY,
  timeout: env.API_TIMEOUT,
});

// Nebius client for embeddings (OpenAI-compatible)
const nebius = new OpenAI({
  apiKey: env.NEBIUS_API_KEY,
  baseURL: env.NEBIUS_BASE_URL || "https://studio.nebius.com/api/openai",
  timeout: env.API_TIMEOUT,
});

export type EmbeddingProvider = 'openai' | 'nebius';

export interface EmbeddingOptions {
  provider?: EmbeddingProvider;
  model?: string;
}

/**
 * Creates an embedding for the given text using the specified provider
 * @param text The text to embed
 * @param options Optional configuration for provider and model
 * @returns Promise<number[]> The embedding vector
 */
export async function createEmbedding(
  text: string, 
  options: EmbeddingOptions = {}
): Promise<number[]> {
  const provider = options.provider || env.EMBEDDING_PROVIDER as EmbeddingProvider;
  
  try {
    switch (provider) {
      case 'nebius':
        return await createNebiusEmbedding(text, options.model);
      case 'openai':
      default:
        return await createOpenAIEmbedding(text, options.model);
    }
  } catch (error) {
    throw new Error(`Failed to create embedding with ${provider}: ${(error as Error).message}`);
  }
}

/**
 * Creates an embedding using OpenAI's text-embedding-ada-002 model
 */
async function createOpenAIEmbedding(text: string, model?: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: model || "text-embedding-ada-002",
    input: text,
  });

  return response.data[0].embedding;
}

/**
 * Creates an embedding using Nebius Qwen embedding model
 */
async function createNebiusEmbedding(text: string, model?: string): Promise<number[]> {
  const response = await nebius.embeddings.create({
    model: model || env.NEBIUS_EMBEDDING_MODEL,
    input: text,
  });

  return response.data[0].embedding;
}

/**
 * Creates embeddings for multiple texts in batch
 * @param texts Array of texts to embed
 * @param options Optional configuration for provider and model
 * @returns Promise<number[][]> Array of embedding vectors
 */
export async function createBatchEmbeddings(
  texts: string[], 
  options: EmbeddingOptions = {}
): Promise<number[][]> {
  const provider = options.provider || env.EMBEDDING_PROVIDER as EmbeddingProvider;
  
  try {
    switch (provider) {
      case 'nebius':
        return await createBatchNebiusEmbeddings(texts, options.model);
      case 'openai':
      default:
        return await createBatchOpenAIEmbeddings(texts, options.model);
    }
  } catch (error) {
    throw new Error(`Failed to create batch embeddings with ${provider}: ${(error as Error).message}`);
  }
}

/**
 * Creates batch embeddings using OpenAI
 */
async function createBatchOpenAIEmbeddings(texts: string[], model?: string): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: model || "text-embedding-ada-002",
    input: texts,
  });

  return response.data.map(item => item.embedding);
}

/**
 * Creates batch embeddings using Nebius
 */
async function createBatchNebiusEmbeddings(texts: string[], model?: string): Promise<number[][]> {
  const response = await nebius.embeddings.create({
    model: model || env.NEBIUS_EMBEDDING_MODEL,
    input: texts,
  });

  return response.data.map(item => item.embedding);
}

export { openai, nebius };