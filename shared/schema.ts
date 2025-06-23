import { pgTable, text, serial, integer, boolean, timestamp, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

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
  isContextMissing: boolean("is_context_missing").default(false).notNull(),
  tags: jsonb("tags"), // array of tags for categorizing queries
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const contextMissingQueries = pgTable("context_missing_queries", {
  id: serial("id").primaryKey(),
  chatMessageId: integer("chat_message_id").references(() => chatMessages.id, { onDelete: "cascade" }).notNull(),
  query: text("query").notNull(),
  detectedPatterns: jsonb("detected_patterns"), // patterns that indicate missing context
  suggestedTopics: jsonb("suggested_topics"), // AI-suggested topics for this query
  category: text("category"), // manual or AI categorization
  priority: text("priority").default("medium"), // low, medium, high
  resolved: boolean("resolved").default(false).notNull(),
  resolutionNotes: text("resolution_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
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

export const insertContextMissingQuerySchema = createInsertSchema(contextMissingQueries).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});

export const insertSettingSchema = createInsertSchema(settings).omit({
  id: true,
  updatedAt: true,
});

export type Document = typeof documents.$inferSelect;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type DocumentChunk = typeof documentChunks.$inferSelect;
export type InsertChunk = z.infer<typeof insertChunkSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type ContextMissingQuery = typeof contextMissingQueries.$inferSelect;
export type InsertContextMissingQuery = z.infer<typeof insertContextMissingQuerySchema>;
export type Setting = typeof settings.$inferSelect;
export type InsertSetting = z.infer<typeof insertSettingSchema>;
