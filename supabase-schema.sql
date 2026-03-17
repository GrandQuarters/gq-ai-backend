-- ==========================================
-- GQ-AI Supabase Database Schema (Updated)
-- Run this FRESH on a new Supabase project,
-- or drop all existing tables first.
-- ==========================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- Drop existing objects (safe re-run)
-- ==========================================
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
DROP FUNCTION IF EXISTS get_unanswered_messages(UUID) CASCADE;
DROP FUNCTION IF EXISTS get_or_supersede_pending_ai_response(UUID) CASCADE;

DROP TABLE IF EXISTS ai_responses CASCADE;
DROP TABLE IF EXISTS processed_messages CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;

-- ==========================================
-- CONTACTS TABLE
-- ==========================================
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  platform VARCHAR(50) NOT NULL CHECK (platform IN ('airbnb', 'expedia', 'booking', 'fewo', 'whatsapp', 'unknown')),
  email VARCHAR(255),
  phone_number VARCHAR(50),
  avatar TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_phone ON contacts(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX idx_contacts_platform ON contacts(platform);
CREATE INDEX idx_contacts_name_platform ON contacts(name, platform);
CREATE INDEX idx_contacts_last_message ON contacts(last_message_at DESC);

-- ==========================================
-- CONVERSATIONS TABLE
-- ==========================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL CHECK (platform IN ('airbnb', 'expedia', 'booking', 'fewo', 'whatsapp', 'unknown')),
  email_thread_id VARCHAR(255),
  platform_conversation_hash VARCHAR(255),
  property_name VARCHAR(255),
  last_message TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  action_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_conversations_thread ON conversations(email_thread_id);
CREATE UNIQUE INDEX idx_conversations_hash ON conversations(platform_conversation_hash);
CREATE INDEX idx_conversations_contact ON conversations(contact_id);
CREATE INDEX idx_conversations_platform ON conversations(platform);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conversations_action_required ON conversations(action_required) WHERE action_required = TRUE;
CREATE INDEX idx_conversations_contact_property ON conversations(contact_id, property_name) WHERE property_name IS NOT NULL;

-- ==========================================
-- MESSAGES TABLE
-- ==========================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  original_content TEXT,
  raw_email_data TEXT,
  sender_id VARCHAR(255) NOT NULL,
  sender_name VARCHAR(255) NOT NULL,
  sender_avatar TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_own BOOLEAN NOT NULL DEFAULT FALSE,
  external_message_id VARCHAR(255),
  read_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_messages_external ON messages(external_message_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, sent_at);
CREATE INDEX idx_messages_is_own ON messages(conversation_id, is_own);

-- ==========================================
-- AI_RESPONSES TABLE
-- Track AI-generated responses including pending and sent
-- ==========================================
CREATE TABLE ai_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'superseded', 'discarded')),
  source_message_ids UUID[] NOT NULL DEFAULT '{}',
  unanswered_message_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  model VARCHAR(50),
  tokens_used INTEGER,
  generation_time_ms INTEGER
);

CREATE INDEX idx_ai_responses_conversation ON ai_responses(conversation_id, created_at DESC);
CREATE INDEX idx_ai_responses_status ON ai_responses(conversation_id, status) WHERE status = 'pending';
CREATE INDEX idx_ai_responses_source ON ai_responses USING GIN(source_message_ids);

-- ==========================================
-- PROCESSED_MESSAGES TABLE
-- Prevents duplicate processing of external messages
-- ==========================================
CREATE TABLE processed_messages (
  external_message_id VARCHAR(255) PRIMARY KEY,
  platform VARCHAR(50) NOT NULL CHECK (platform IN ('gmail', 'whatsapp')),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_processed_messages_platform ON processed_messages(platform);

-- ==========================================
-- FUNCTIONS & TRIGGERS
-- ==========================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ai_responses_updated_at
  BEFORE UPDATE ON ai_responses
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Get unanswered messages (guest messages since last admin reply)
CREATE OR REPLACE FUNCTION get_unanswered_messages(p_conversation_id UUID)
RETURNS TABLE (
  id UUID,
  content TEXT,
  sender_name VARCHAR,
  sent_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH last_admin_message AS (
    SELECT m.sent_at
    FROM messages m
    WHERE m.conversation_id = p_conversation_id
      AND m.is_own = TRUE
    ORDER BY m.sent_at DESC
    LIMIT 1
  )
  SELECT m.id, m.content, m.sender_name, m.sent_at
  FROM messages m
  WHERE m.conversation_id = p_conversation_id
    AND m.is_own = FALSE
    AND (
      NOT EXISTS (SELECT 1 FROM last_admin_message)
      OR m.sent_at > (SELECT lam.sent_at FROM last_admin_message lam)
    )
  ORDER BY m.sent_at ASC;
END;
$$ LANGUAGE plpgsql;

-- Supersede pending AI response and return its ID
CREATE OR REPLACE FUNCTION get_or_supersede_pending_ai_response(p_conversation_id UUID)
RETURNS UUID AS $$
DECLARE
  v_pending_response_id UUID;
BEGIN
  SELECT ar.id INTO v_pending_response_id
  FROM ai_responses ar
  WHERE ar.conversation_id = p_conversation_id
    AND ar.status = 'pending'
  ORDER BY ar.created_at DESC
  LIMIT 1;

  IF v_pending_response_id IS NOT NULL THEN
    UPDATE ai_responses
    SET status = 'superseded',
        superseded_at = NOW()
    WHERE id = v_pending_response_id;
  END IF;

  RETURN v_pending_response_id;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- ROW LEVEL SECURITY (RLS)
-- ==========================================

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON contacts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for service role" ON conversations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for service role" ON messages
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for service role" ON ai_responses
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for service role" ON processed_messages
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ==========================================
-- TABLE COMMENTS
-- ==========================================

COMMENT ON TABLE contacts IS 'Guest/customer contact info from all platforms';
COMMENT ON TABLE conversations IS 'Individual conversation threads with guests';
COMMENT ON TABLE messages IS 'All messages (sent and received) in conversations';
COMMENT ON TABLE ai_responses IS 'AI-generated responses: pending, sent, superseded, discarded';
COMMENT ON TABLE processed_messages IS 'Prevents duplicate processing of Gmail/WhatsApp messages';

COMMENT ON COLUMN conversations.property_name IS 'Property name for safe conversation merging when platform creates new threads';
COMMENT ON COLUMN messages.original_content IS 'Original untranslated content (set when message was auto-translated)';
COMMENT ON COLUMN messages.raw_email_data IS 'Full raw email data as JSON for debugging (from, to, subject, body, hashes, etc.)';
COMMENT ON COLUMN messages.is_own IS 'TRUE = sent by admin, FALSE = received from guest';
COMMENT ON COLUMN ai_responses.status IS 'pending: awaiting send, sent: admin sent it, superseded: replaced by newer response, discarded: admin wrote custom reply';
COMMENT ON COLUMN ai_responses.source_message_ids IS 'Array of message UUIDs this AI response addresses';
