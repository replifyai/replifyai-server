#!/usr/bin/env tsx

import { config } from 'dotenv';

// Load environment variables
config();

interface QdrantIndexCreationResult {
  success: boolean;
  message: string;
  error?: string;
}

interface IndexConfig {
  fieldName: string;
  fieldSchema: string;
  description: string;
}

class QdrantIndexCreator {
  private baseUrl: string;
  private collectionName: string;
  private apiKey: string | undefined;

  // Define the indexes to create
  private indexes: IndexConfig[] = [
    {
      fieldName: "metadata.keyTopics",
      fieldSchema: "keyword",
      description: "Index for filtering chunks by key topics (array field)"
    },
    {
      fieldName: "metadata.docMetadata.key_entities.product_name",
      fieldSchema: "keyword",
      description: "Index for filtering chunks by product name"
    },
    {
      fieldName: "metadata.docMetadata.topics",
      fieldSchema: "keyword",
      description: "Index for filtering chunks by topics"
    }
  ];

  constructor() {
    this.baseUrl = process.env.QDRANT_URL || "";
    this.collectionName = process.env.QDRANT_COLLECTION_NAME || "documents";
    this.apiKey = process.env.QDRANT_API_KEY;

    if (!this.baseUrl) {
      throw new Error("QDRANT_URL environment variable is required");
    }
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (this.apiKey) {
      headers["api-key"] = this.apiKey;
    }

    console.log(`Making request to: ${url}`);
    console.log(`Method: ${options.method || 'GET'}`);
    if (options.body) {
      console.log(`Body: ${options.body}`);
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      let errorDetails = '';
      try {
        const errorBody = await response.text();
        errorDetails = errorBody ? ` - ${errorBody}` : '';
      } catch (e) {
        // If we can't read the response body, that's ok
      }
      throw new Error(`Qdrant request failed: ${response.status} ${response.statusText}${errorDetails}`);
    }

    return response.json();
  }

  async checkCollectionExists(): Promise<boolean> {
    try {
      console.log(`Checking if collection '${this.collectionName}' exists...`);
      await this.request(`/collections/${this.collectionName}`);
      console.log(`✓ Collection '${this.collectionName}' exists.`);
      return true;
    } catch (error) {
      console.log(`✗ Collection '${this.collectionName}' does not exist.`);
      return false;
    }
  }

  async checkIndexExists(fieldName: string): Promise<boolean> {
    try {
      console.log(`Checking if index for '${fieldName}' exists...`);
      await this.request(`/collections/${this.collectionName}/index/${fieldName}`);
      console.log(`✓ Index for '${fieldName}' already exists.`);
      return true;
    } catch (error) {
      console.log(`✗ Index for '${fieldName}' does not exist.`);
      return false;
    }
  }

  async createIndex(fieldName: string, fieldSchema: string): Promise<QdrantIndexCreationResult> {
    try {
      console.log(`Creating index for '${fieldName}' with schema '${fieldSchema}'...`);
      
      const response = await this.request(`/collections/${this.collectionName}/index`, {
        method: "PUT",
        body: JSON.stringify({
          field_name: fieldName,
          field_schema: fieldSchema
        }),
      });

      console.log(`✓ Index for '${fieldName}' created successfully.`);
      console.log(`Response:`, JSON.stringify(response, null, 2));
      
      return {
        success: true,
        message: `Index for '${fieldName}' created successfully.`
      };
    } catch (error) {
      console.error(`✗ Failed to create index for '${fieldName}':`, error);
      return {
        success: false,
        message: `Failed to create index for '${fieldName}'.`,
        error: (error as Error).message
      };
    }
  }

  async listIndexes(): Promise<void> {
    try {
      console.log(`Listing all indexes for collection '${this.collectionName}'...`);
      const response = await this.request(`/collections/${this.collectionName}`);
      
      const indexes = response.result?.config?.params?.index || {};
      console.log(`Current indexes:`, JSON.stringify(indexes, null, 2));
    } catch (error) {
      console.error(`Failed to list indexes:`, error);
    }
  }

  async run(): Promise<void> {
    console.log("=== Qdrant Index Creation Script ===");
    console.log(`Collection: ${this.collectionName}`);
    console.log(`Base URL: ${this.baseUrl}`);
    console.log(`API Key: ${this.apiKey ? '[CONFIGURED]' : '[NOT SET]'}`);
    console.log("");

    console.log("Indexes to create:");
    this.indexes.forEach((index, i) => {
      console.log(`${i + 1}. ${index.fieldName} (${index.fieldSchema}) - ${index.description}`);
    });
    console.log("");

    // Check if collection exists
    const collectionExists = await this.checkCollectionExists();
    if (!collectionExists) {
      console.error("❌ Collection does not exist. Please create the collection first.");
      return;
    }

    // List current indexes
    await this.listIndexes();
    console.log("");

    let allSuccessful = true;
    const results: { index: IndexConfig; success: boolean; message: string }[] = [];

    // Process each index
    for (const index of this.indexes) {
      console.log(`\n--- Processing ${index.fieldName} ---`);
      
      // Check if index already exists
      const indexExists = await this.checkIndexExists(index.fieldName);
      if (indexExists) {
        console.log(`✅ Index for '${index.fieldName}' already exists. Skipping.`);
        results.push({
          index,
          success: true,
          message: "Already exists"
        });
        continue;
      }

      // Create the index
      console.log(`Creating index for ${index.fieldName}...`);
      const result = await this.createIndex(index.fieldName, index.fieldSchema);
      
      results.push({
        index,
        success: result.success,
        message: result.success ? "Created successfully" : result.error || "Failed"
      });

      if (!result.success) {
        allSuccessful = false;
        console.error(`❌ Failed to create index for '${index.fieldName}': ${result.error}`);
      } else {
        console.log(`✅ Index for '${index.fieldName}' created successfully!`);
      }
    }

    // Summary
    console.log("\n=== Summary ===");
    results.forEach(({ index, success, message }) => {
      const status = success ? "✅" : "❌";
      console.log(`${status} ${index.fieldName}: ${message}`);
    });

    if (allSuccessful) {
      console.log("\n✅ All indexes processed successfully!");
      
      // List indexes again to confirm
      console.log("\nUpdated indexes:");
      await this.listIndexes();
    } else {
      console.error("\n❌ Some indexes failed to create. Check the errors above.");
      process.exit(1);
    }
  }
}

// Main execution
async function main() {
  try {
    const indexCreator = new QdrantIndexCreator();
    await indexCreator.run();
  } catch (error) {
    console.error("Script failed:", error);
    process.exit(1);
  }
}

// Run the script
main().catch(console.error); 