-- Migration script to add context missing functionality

-- Add new columns to chat_messages table
ALTER TABLE chat_messages 
ADD COLUMN IF NOT EXISTS is_context_missing BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS tags JSONB;

-- Create context_missing_queries table
CREATE TABLE IF NOT EXISTS context_missing_queries (
    id SERIAL PRIMARY KEY,
    chat_message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    detected_patterns JSONB,
    suggested_topics JSONB,
    category TEXT,
    priority TEXT DEFAULT 'medium',
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolution_notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_context_missing_queries_resolved ON context_missing_queries(resolved);
CREATE INDEX IF NOT EXISTS idx_context_missing_queries_category ON context_missing_queries(category);
CREATE INDEX IF NOT EXISTS idx_context_missing_queries_priority ON context_missing_queries(priority);
CREATE INDEX IF NOT EXISTS idx_context_missing_queries_created_at ON context_missing_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_context_missing ON chat_messages(is_context_missing);

-- Create a view for easy querying of context missing queries with message details
CREATE OR REPLACE VIEW context_missing_with_messages AS
SELECT 
    cmq.*,
    cm.message as original_message,
    cm.response as original_response,
    cm.created_at as message_created_at
FROM context_missing_queries cmq
JOIN chat_messages cm ON cmq.chat_message_id = cm.id; 