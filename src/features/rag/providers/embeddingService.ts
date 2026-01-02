import OpenAI from "openai";
import { env } from "../../../env.js";

/**
 * Embedding Service
 * 
 * This service provides a unified interface for creating embeddings using different providers.
 * Currently supports:
 * - OpenAI: text-embedding-ada-002 (default) or text-embedding-3-large
 * - Nebius: Qwen/Qwen3-Embedding-8B
 * 
 * Usage:
 * - Set EMBEDDING_PROVIDER environment variable to 'openai' or 'nebius'
 * - Set NEBIUS_API_KEY and NEBIUS_BASE_URL for Nebius provider
 * - Set OPENAI_API_KEY for OpenAI provider
 * 
 * The service automatically uses the provider specified in EMBEDDING_PROVIDER,
 * or defaults to OpenAI if not set.
 * 
 * For text-embedding-3-large, you can optionally specify dimensions (256, 1024, or 3072):
 *   createEmbedding(text, { model: 'text-embedding-3-large', dimensions: 1024 })
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
  dimensions?: number; // For text-embedding-3-large: 256, 1024, or 3072 (default: 3072)
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
        return await createOpenAIEmbedding(text, options.model, options.dimensions);
    }
  } catch (error) {
    throw new Error(`Failed to create embedding with ${provider}: ${(error as Error).message}`);
  }
}

/**
 * Creates an embedding using OpenAI models
 * Supports text-embedding-ada-002 (default) and text-embedding-3-large
 */
async function createOpenAIEmbedding(text: string, model?: string, dimensions?: number): Promise<number[]> {
  const embeddingModel = model || "text-embedding-ada-002";
  const embeddingConfig: any = {
    model: embeddingModel,
    input: text,
  };

  // Add dimensions parameter for text-embedding-3-large model
  if (embeddingModel === "text-embedding-3-large" && dimensions !== undefined) {
    embeddingConfig.dimensions = dimensions;
  }

  const response = await openai.embeddings.create(embeddingConfig);

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
  if (!texts || texts.length === 0) {
    console.log('⚠️ Embedding Service: Received empty text array, skipping embedding creation.');
    return [];
  }

  const provider = options.provider || env.EMBEDDING_PROVIDER as EmbeddingProvider;
  console.log(`✨ Creating batch embeddings for ${texts.length} texts using ${provider}...`);
  
  try {
    let embeddings: number[][];
    switch (provider) {
      case 'nebius':
        embeddings = await createBatchNebiusEmbeddings(texts, options.model);
        break;
      case 'openai':
      default:
        embeddings = await createBatchOpenAIEmbeddings(texts, options.model, options.dimensions);
        break;
    }
    console.log(`✅ Successfully created ${embeddings.length} embeddings.`);
    return embeddings;
  } catch (error) {
    console.error(`❌ Failed to create batch embeddings with ${provider}:`, error);
    throw new Error(`Failed to create batch embeddings with ${provider}: ${(error as Error).message}`);
  }
}

/**
 * Creates batch embeddings using OpenAI models
 * Supports text-embedding-ada-002 (default) and text-embedding-3-large
 */
async function createBatchOpenAIEmbeddings(texts: string[], model?: string, dimensions?: number): Promise<number[][]> {
  const embeddingModel = model || "text-embedding-ada-002";
  const embeddingConfig: any = {
    model: embeddingModel,
    input: texts,
  };

  // Add dimensions parameter for text-embedding-3-large model
  if (embeddingModel === "text-embedding-3-large" && dimensions !== undefined) {
    embeddingConfig.dimensions = dimensions;
  }

  const response = await openai.embeddings.create(embeddingConfig);

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