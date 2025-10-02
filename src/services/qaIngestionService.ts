import { createEmbedding } from "./embeddingService.js";
import { extractDocumentMetadata } from "./openai.js";
import { qdrantService } from "./qdrantHybrid.js";

export interface QAPairInput {
  query: string;
  answer: string;
  productName: string;
}

export interface QAIngestionResult {
  totalChunks: number;
  processedPairs: number;
  errors: Array<{ index: number; message: string }>;
}

class QAIngestionService {
  /**
   * Ingest a list of QA pairs into the knowledge base, creating intelligent metadata
   * and embeddings for retrieval. The productName must be provided per pair.
   */
  async ingestQAPairs(pairs: QAPairInput[], options?: { filename?: string }): Promise<QAIngestionResult> {
    if (!pairs || pairs.length === 0) {
      throw new Error("qaPairs is required and cannot be empty");
    }

    // Validate inputs early
    pairs.forEach((p, i) => {
      if (!p.query || !p.answer || !p.productName) {
        throw new Error(`QA pair at index ${i} is missing query, answer, or productName`);
      }
    });

    // Grouping identity for this ingestion batch (not persisted)
    const now = Date.now();
    const filename = options?.filename || `qa_pairs_${now}.txt`;

    const vectorPoints: Array<{
      id: number;
      vector: number[];
      payload: any;
    }> = [];

    const errors: Array<{ index: number; message: string }> = [];

    let createdChunks = 0;
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index];
      try {
        // 1) Generate intelligent metadata using existing function (same as PDFs)
        const combinedText = `Question: ${pair.query}\n\nAnswer: ${pair.answer}`;
        const aiMetadata = await extractDocumentMetadata(combinedText, `qa_pair_${index}.txt`);

        // 2) Build chunk metadata matching retrieval indexes
        const chunkMetadata = {
          filename,
          productName: pair.productName, // critical for filtering
          title: aiMetadata.title || `QA Entry ${index + 1}`,
          summary: aiMetadata.document_summary || aiMetadata.summary || undefined,
          keyTopics: aiMetadata.topics || [], // critical for filtering
          importance: 8,
          chunkType: "general",
          chunkLength: pair.answer.length,
          strategy: "qa-manual-input",
          docMetadata: aiMetadata,
          documentSummary: aiMetadata.documentSummary || undefined,
          documentType: aiMetadata.documentType || "qa",
          uploadType: "qa_pairs",
        };

        // 3) Embed the ANSWER content for semantic retrieval
        const embedding = await createEmbedding(pair.answer);

        // 4) Prepare vector point for Qdrant (no DB storage)
        const ephemeralDocumentId = now; // single batch id for grouping
        const ephemeralPointId = now + index; // any numeric id; Qdrant client will override with UUID

        vectorPoints.push({
          id: ephemeralPointId,
          vector: embedding,
          payload: {
            documentId: ephemeralDocumentId,
            chunkIndex: index,
            content: pair.answer,
            filename,
            metadata: chunkMetadata,
            uploadTimestamp: Date.now(),
          },
        });

        createdChunks++;
      } catch (e: any) {
        errors.push({ index, message: e?.message || "Unknown error" });
      }
    }

    // Upsert to Qdrant in one go
    if (vectorPoints.length > 0) {
      await qdrantService.addPoints(vectorPoints);
    }

    return {
      totalChunks: createdChunks,
      processedPairs: pairs.length,
      errors,
    };
  }
}

export const qaIngestionService = new QAIngestionService();

