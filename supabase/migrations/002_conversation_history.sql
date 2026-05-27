-- ============================================================
-- FlowDesk Pro — Aria Conversational AI Agent
-- Migration: 002_conversation_history.sql
-- Purpose:   Transient conversation state for multi-turn Aria
--            calls, and demo_requests table for lead capture
--            form on the landing page.
-- Date:      2026-05-26
-- ============================================================
-- SECURITY NOTES:
--   - conversation_history is a transient operational table.
--     caller_number is stored temporarily to support lead
--     creation fallback. It is service_role access only.
--   - demo_requests contains contact data. Service_role only.
--   - Authenticated and anon roles have no access to either table.
-- ============================================================

-- ============================================================
-- TABLE: conversation_history
-- One row per active call (keyed by twilio call_sid).
-- Stores the rolling Claude messages array for multi-turn Aria.
-- Completed rows have is_complete = true.
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_history (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid       text        UNIQUE NOT NULL,

  -- Caller context (caller_number is transient — operational use only)
  caller_number  text,
  caller_id      uuid        REFERENCES flowdesk_callers(id) ON DELETE SET NULL,
  session_id     uuid        REFERENCES flowdesk_call_sessions(id) ON DELETE SET NULL,

  -- Conversation state
  history        jsonb       NOT NULL DEFAULT '[]',
  turn_count     integer     NOT NULL DEFAULT 0,
  is_complete    boolean     NOT NULL DEFAULT false,

  -- Audit
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE conversation_history IS
  'Transient multi-turn conversation state for active Aria calls. '
  'Keyed by Twilio call_sid. history is the Claude messages array. '
  'Marked is_complete=true when Aria finalizes the lead. '
  'Service_role access only — not exposed to dashboard.';

COMMENT ON COLUMN conversation_history.caller_number IS
  'E.164 caller phone number. Operational/transient use only. '
  'Used as fallback callback_phone when lead is created. '
  'Service_role access only — never returned in public responses.';

COMMENT ON COLUMN conversation_history.history IS
  'JSONB array of Claude messages: [{role:"user"|"assistant", content:"..."}]. '
  'Passed directly to Claude API on each gather turn.';

DROP TRIGGER IF EXISTS set_updated_at_conversation_history ON conversation_history;
CREATE TRIGGER set_updated_at_conversation_history
  BEFORE UPDATE ON conversation_history
  FOR EACH ROW EXECUTE FUNCTION flowdesk_conversational_set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_history_call_sid
  ON conversation_history (call_sid);

CREATE INDEX IF NOT EXISTS idx_conv_history_caller_id
  ON conversation_history (caller_id);

CREATE INDEX IF NOT EXISTS idx_conv_history_is_complete
  ON conversation_history (is_complete);

CREATE INDEX IF NOT EXISTS idx_conv_history_created_at
  ON conversation_history (created_at DESC);

ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_conv_history"
  ON conversation_history FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE SELECT, INSERT, UPDATE, DELETE
  ON conversation_history
  FROM authenticated, anon;

-- ============================================================
-- TABLE: demo_requests
-- Lead capture from the demo-request.html landing page form.
-- ============================================================
CREATE TABLE IF NOT EXISTS demo_requests (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name  text,
  contact_name   text,
  phone          text        NOT NULL,
  email          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE demo_requests IS
  'Demo request submissions from the FlowDesk Pro landing page form. '
  'Service_role access only.';

DROP TRIGGER IF EXISTS set_updated_at_demo_requests ON demo_requests;
CREATE TRIGGER set_updated_at_demo_requests
  BEFORE UPDATE ON demo_requests
  FOR EACH ROW EXECUTE FUNCTION flowdesk_conversational_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_demo_requests_created_at
  ON demo_requests (created_at DESC);

ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_demo_requests"
  ON demo_requests FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE SELECT, INSERT, UPDATE, DELETE
  ON demo_requests
  FROM authenticated, anon;

-- ============================================================
-- END OF MIGRATION 002
-- ============================================================
