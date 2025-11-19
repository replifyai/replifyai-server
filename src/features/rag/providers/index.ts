import { env } from "../../../env.js";
import { VectorStoreProvider } from "./types";
import { qdrantService } from "./qdrantHybrid";
import { googleRAGService } from "./googleRAG";

export * from "./types";
export * from "./qdrantHybrid";
export * from "./googleRAG";
export * from "./embeddingService";

export function getVectorStore(): VectorStoreProvider {
  const provider = env.RAG_PROVIDER || 'qdrant';
  
  console.log(`Using RAG Provider: ${provider}`);
  
  if (provider === 'google') {
    return googleRAGService;
  }
  
  return qdrantService;
}

export const vectorStore = getVectorStore();
