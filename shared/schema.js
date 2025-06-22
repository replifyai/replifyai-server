import { pgTable, text, serial, integer, timestamp, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const documents = pgTable("documents", {
    id: serial("id").primaryKey(),
    filename: text("filename").notNull(),
    originalName: text("original_name").notNull(),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    status: text("status").notNull().default("uploading"), // uploading, processing, indexed, error
    chunkCount: integer("chunk_count").default(0),
    metadata: jsonb("metadata"),
});
export const documentChunks = pgTable("document_chunks", {
    id: serial("id").primaryKey(),
    documentId: integer("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: real("embedding").array(),
    metadata: jsonb("metadata"), // page numbers, section headers, etc.
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const chatMessages = pgTable("chat_messages", {
    id: serial("id").primaryKey(),
    message: text("message").notNull(),
    response: text("response").notNull(),
    sources: jsonb("sources"), // array of source chunks with document info
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const settings = pgTable("settings", {
    id: serial("id").primaryKey(),
    key: text("key").notNull().unique(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertDocumentSchema = createInsertSchema(documents).omit({
    id: true,
    uploadedAt: true,
    processedAt: true,
    chunkCount: true,
});
export const insertChunkSchema = createInsertSchema(documentChunks).omit({
    id: true,
    createdAt: true,
});
export const insertMessageSchema = createInsertSchema(chatMessages).omit({
    id: true,
    createdAt: true,
});
export const insertSettingSchema = createInsertSchema(settings).omit({
    id: true,
    updatedAt: true,
});
//# sourceMappingURL=schema.js.map