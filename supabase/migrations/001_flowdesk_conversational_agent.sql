-- ============================================================
-- FlowDesk Pro — Conversational AI Agent Demo
-- Migration: 001_flowdesk_conversational_agent.sql
-- Purpose:   Sandbox database foundation for repeat-caller
--            recognition, personalized greetings, and lead capture.
-- Coordinator: Ruflo / Claude Code — Phase 0 / Phase 0A / Phase 0B micro-hardening / Phase 0C namespace hardening
-- Date:      2026-05-26 (Phase 0A applied: 2026-05-26; Phase 0B applied: 2026-05-26; Phase 0C applied: 2026-05-26)
-- ============================================================
-- SECURITY SUMMARY (Phase 0A hardened 2026-05-26; Phase 0B micro-hardened 2026-05-26)
--   - Phone numbers are NEVER stored in plain text.
--   - phone_hash = SHA-256(PHONE_HASH_SALT + E.164_number)
--   - PHONE_HASH_SALT lives in server env var only — never in DB.
--   - callback_phone is server-side CRM data — NOT readable by authenticated role.
--   - raw_transcript is PII-adjacent — NOT readable by authenticated role.
--   - phone_hash is NOT directly readable by authenticated role (Phase 0B).
--   - Service-role key (Netlify Functions) performs all base-table reads and writes.
--   - Authenticated role (dashboard) reads ONLY via flowdesk_dashboard_leads view.
--   - flowdesk_dashboard_leads excludes: callback_phone, phone_hash,
--       raw_transcript, ai_metadata.
--   - Anon role has no access to any table or view (Phase 0B: explicit revoke applied).
-- ============================================================

-- Enable pgcrypto for gen_random_uuid() (safe no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- TRIGGER FUNCTION: flowdesk_conversational_set_updated_at
-- Stamps updated_at = now() on any row update.
-- Namespaced to this migration — does not conflict with any
-- existing set_updated_at() function in the shared project.
-- ============================================================
CREATE OR REPLACE FUNCTION flowdesk_conversational_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- TABLE: flowdesk_callers
-- One row per unique caller, identified by phone_hash.
-- Supports repeat-caller recognition and personalized greetings.
-- Example greeting: "Hello Mr. Mitchell, welcome back. I see your
--   last call was about the AI Contact Center demo."
-- ============================================================
CREATE TABLE IF NOT EXISTS flowdesk_callers (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (no plain-text phone ever)
  phone_hash          text        UNIQUE NOT NULL,
  phone_last4         text,

  -- Personalization fields for AI greeting
  first_name          text,
  last_name           text,
  display_name        text,       -- e.g. "Mr. Mitchell" — used in greeting
  business_name       text,

  -- Call history
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  call_count          integer     NOT NULL DEFAULT 1,
  last_intent_summary text,       -- AI summary from most recent call
  last_call_topic     text,       -- Short topic tag, e.g. "AI Contact Center demo"

  -- Audit
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE flowdesk_callers IS
  'Persistent caller profiles for the FlowDesk Conversational AI Agent Demo. '
  'Identified by phone_hash (SHA-256 of salted E.164 number — plain-text phone never stored). '
  'Drives repeat-caller recognition and personalized AI greetings.';

COMMENT ON COLUMN flowdesk_callers.phone_hash IS
  'SHA-256(PHONE_HASH_SALT + E.164_number). '
  'Used for repeat-caller lookup. '
  'Salt is stored only in the server environment variable PHONE_HASH_SALT.';

COMMENT ON COLUMN flowdesk_callers.phone_last4 IS
  'Last 4 digits of caller phone number. Safe for dashboard masking display. '
  'Cannot be used to reconstruct the full number.';

COMMENT ON COLUMN flowdesk_callers.display_name IS
  'Preferred greeting name used by the AI agent. '
  'Example: "Mr. Mitchell". Set by AI name extraction or manual dashboard update.';

COMMENT ON COLUMN flowdesk_callers.last_intent_summary IS
  'AI-generated summary of the most recent call intent. '
  'Injected into AI system prompt for repeat-caller personalization.';

COMMENT ON COLUMN flowdesk_callers.last_call_topic IS
  'Short topic tag from most recent call, e.g. "AI Contact Center pricing". '
  'Used in personalized greeting: "I see your last call was about [topic]."';

-- ============================================================
-- TABLE: flowdesk_call_sessions
-- One row per individual Twilio inbound call.
-- Linked to flowdesk_callers for repeat-caller context.
-- ============================================================
CREATE TABLE IF NOT EXISTS flowdesk_call_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id        uuid        REFERENCES flowdesk_callers(id) ON DELETE SET NULL,
  twilio_call_sid  text        UNIQUE NOT NULL,

  -- Call timing
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  duration_sec     integer,

  -- Call state
  status           text        NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN (
                       'in_progress',
                       'completed',
                       'failed',
                       'no_answer',
                       'busy',
                       'canceled'
                     )),

  outcome          text
                     CHECK (outcome IS NULL OR outcome IN (
                       'callback_requested',
                       'info_delivered',
                       'transferred',
                       'abandoned',
                       'voicemail',
                       'unknown'
                     )),

  -- AI content
  intent_summary   text,       -- AI-generated 1-2 sentence call summary
  raw_transcript   jsonb,      -- [{role: "assistant"|"user", text: "...", ts: "ISO8601"}]
  ai_metadata      jsonb,      -- {model_id, input_tokens, output_tokens, latency_ms}

  -- Audit
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE flowdesk_call_sessions IS
  'One row per Twilio inbound call for the FlowDesk demo. '
  'Stores full transcript, AI metadata, and call outcome. '
  'Linked to flowdesk_callers to provide repeat-caller context to the AI.';

COMMENT ON COLUMN flowdesk_call_sessions.twilio_call_sid IS
  'Twilio canonical call identifier (e.g. CA1234...). Unique per call.';

COMMENT ON COLUMN flowdesk_call_sessions.raw_transcript IS
  'JSONB array of conversation turns. '
  'Format: [{role: "assistant"|"user", text: "...", ts: "2026-05-26T10:00:00Z"}]. '
  'PII-adjacent: may contain spoken names, business details. '
  'NOT accessible to authenticated role (Phase 0A). Service-role only.';

COMMENT ON COLUMN flowdesk_call_sessions.ai_metadata IS
  'Operational metadata for cost tracking and performance analysis. '
  'Example: {model_id: "claude-sonnet-4-6", input_tokens: 420, output_tokens: 85, latency_ms: 1200}';

-- ============================================================
-- TABLE: flowdesk_leads
-- Actionable lead records extracted from call sessions.
-- callback_phone is sensitive — server-side/service-role only (Phase 0A).
-- ============================================================
CREATE TABLE IF NOT EXISTS flowdesk_leads (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id            uuid        REFERENCES flowdesk_callers(id) ON DELETE SET NULL,
  session_id           uuid        REFERENCES flowdesk_call_sessions(id) ON DELETE SET NULL,

  -- Contact info
  business_name        text,
  contact_name         text,

  -- SECURITY: callback_phone — server-side only (Phase 0A)
  callback_phone       text,
  callback_phone_last4 text,

  -- Lead classification
  interest_area        text,

  priority             text        NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('hot', 'warm', 'normal', 'cold')),

  lead_status          text        NOT NULL DEFAULT 'new'
                         CHECK (lead_status IN (
                           'new',
                           'contacted',
                           'qualified',
                           'closed_won',
                           'closed_lost',
                           'no_answer'
                         )),

  source               text        NOT NULL DEFAULT 'conversational_ai_agent_demo',

  -- Audit & follow-up
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  followed_up_at       timestamptz
);

COMMENT ON TABLE flowdesk_leads IS
  'Actionable leads captured by the FlowDesk Conversational AI Agent. '
  'Each lead is linked to a caller profile and the originating call session. '
  'Surfaced in the agent dashboard via flowdesk_dashboard_leads view (safe fields only).';

COMMENT ON COLUMN flowdesk_leads.callback_phone IS
  'SECURITY — OPERATIONAL CRM DATA (Phase 0A): '
  'Full callback number provided by caller during AI conversation. '
  'NOT accessible by authenticated role at the database layer. '
  'Readable only by service_role (server-side Netlify Functions). '
  'Dashboard displays callback_phone_last4 via flowdesk_dashboard_leads view. '
  'Must never be returned in unauthenticated API responses.';

COMMENT ON COLUMN flowdesk_leads.callback_phone_last4 IS
  'Last 4 digits of callback_phone. Exposed in flowdesk_dashboard_leads view.';

COMMENT ON COLUMN flowdesk_leads.source IS
  'Origin tag. Default is "conversational_ai_agent_demo". '
  'Allows future multi-source lead tracking.';

-- ============================================================
-- TABLE: flowdesk_agent_notes
-- Append-only agent annotations on lead records.
-- Notes are never edited — add a new note to correct.
-- ============================================================
CREATE TABLE IF NOT EXISTS flowdesk_agent_notes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid        REFERENCES flowdesk_leads(id) ON DELETE CASCADE,
  note_text  text        NOT NULL,
  agent_id   text,       -- Auth user ID (uuid as text) or agent display name
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE flowdesk_agent_notes IS
  'Append-only agent annotations on FlowDesk lead records. '
  'No updated_at — notes are never edited. Add a new note to amend.';

COMMENT ON COLUMN flowdesk_agent_notes.agent_id IS
  'Identifier of the agent who wrote the note. '
  'Typically the Supabase auth.uid() stored as text.';

-- ============================================================
-- TRIGGERS: updated_at auto-stamp
-- Applied to tables that have an updated_at column.
-- flowdesk_agent_notes is excluded (append-only).
-- ============================================================

DROP TRIGGER IF EXISTS set_updated_at_flowdesk_callers ON flowdesk_callers;
CREATE TRIGGER set_updated_at_flowdesk_callers
  BEFORE UPDATE ON flowdesk_callers
  FOR EACH ROW EXECUTE FUNCTION flowdesk_conversational_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_flowdesk_call_sessions ON flowdesk_call_sessions;
CREATE TRIGGER set_updated_at_flowdesk_call_sessions
  BEFORE UPDATE ON flowdesk_call_sessions
  FOR EACH ROW EXECUTE FUNCTION flowdesk_conversational_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_flowdesk_leads ON flowdesk_leads;
CREATE TRIGGER set_updated_at_flowdesk_leads
  BEFORE UPDATE ON flowdesk_leads
  FOR EACH ROW EXECUTE FUNCTION flowdesk_conversational_set_updated_at();

-- ============================================================
-- INDEXES
-- ============================================================

-- flowdesk_callers
CREATE UNIQUE INDEX IF NOT EXISTS idx_flowdesk_callers_phone_hash
  ON flowdesk_callers (phone_hash);

CREATE INDEX IF NOT EXISTS idx_flowdesk_callers_created_at
  ON flowdesk_callers (created_at DESC);

-- flowdesk_call_sessions
CREATE INDEX IF NOT EXISTS idx_flowdesk_sessions_caller_id
  ON flowdesk_call_sessions (caller_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flowdesk_sessions_twilio_sid
  ON flowdesk_call_sessions (twilio_call_sid);

CREATE INDEX IF NOT EXISTS idx_flowdesk_sessions_created_at
  ON flowdesk_call_sessions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_flowdesk_sessions_status
  ON flowdesk_call_sessions (status);

-- flowdesk_leads
CREATE INDEX IF NOT EXISTS idx_flowdesk_leads_caller_id
  ON flowdesk_leads (caller_id);

CREATE INDEX IF NOT EXISTS idx_flowdesk_leads_session_id
  ON flowdesk_leads (session_id);

CREATE INDEX IF NOT EXISTS idx_flowdesk_leads_priority
  ON flowdesk_leads (priority);

CREATE INDEX IF NOT EXISTS idx_flowdesk_leads_lead_status
  ON flowdesk_leads (lead_status);

CREATE INDEX IF NOT EXISTS idx_flowdesk_leads_created_at
  ON flowdesk_leads (created_at DESC);

-- flowdesk_agent_notes
CREATE INDEX IF NOT EXISTS idx_flowdesk_notes_lead_id
  ON flowdesk_agent_notes (lead_id);

-- ============================================================
-- ROW LEVEL SECURITY
--
-- Supabase service_role bypasses RLS by default.
-- Explicit service_role policies below are for documentation
-- and defense-in-depth only.
--
-- Phase 0A hardening:
--   authenticated has NO policies on flowdesk_leads or
--   flowdesk_call_sessions — default deny applies.
--   Dashboard reads go through flowdesk_dashboard_leads view only.
--
-- All server-side Netlify Functions connect with service_role key.
-- The anon role has NO policy — default deny applies to all tables.
-- ============================================================

ALTER TABLE flowdesk_callers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE flowdesk_call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flowdesk_leads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE flowdesk_agent_notes   ENABLE ROW LEVEL SECURITY;

-- ---- flowdesk_callers ----

CREATE POLICY "service_role_all_callers"
  ON flowdesk_callers FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Phase 0B: authenticated_read_callers removed — direct base-table reads eliminated.
-- Dashboard reads flowdesk_callers fields via flowdesk_dashboard_leads view only.

-- ---- flowdesk_call_sessions ----

CREATE POLICY "service_role_all_sessions"
  ON flowdesk_call_sessions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Phase 0A: No direct authenticated SELECT on flowdesk_call_sessions.
-- raw_transcript is PII-adjacent. Access via flowdesk_dashboard_leads view only.

-- ---- flowdesk_leads ----

CREATE POLICY "service_role_all_leads"
  ON flowdesk_leads FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Phase 0A: No direct authenticated SELECT or UPDATE on flowdesk_leads.
-- callback_phone must not be accessible at the database layer.
-- All base-table access is service_role only.
-- Dashboard reads via flowdesk_dashboard_leads view (safe fields only).

-- ---- flowdesk_agent_notes ----

CREATE POLICY "service_role_all_notes"
  ON flowdesk_agent_notes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "authenticated_read_notes"
  ON flowdesk_agent_notes FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated agents may add notes (append-only)
CREATE POLICY "authenticated_insert_notes"
  ON flowdesk_agent_notes FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ============================================================
-- PHASE 0A / 0B: PRIVILEGE REVOCATION
-- Belt-and-suspenders with RLS: revoke any default or previously
-- granted direct table privileges from authenticated and anon
-- on all base tables.
-- ============================================================

REVOKE SELECT, INSERT, UPDATE, DELETE
  ON flowdesk_leads
  FROM authenticated, anon;

REVOKE SELECT, INSERT, UPDATE, DELETE
  ON flowdesk_call_sessions
  FROM authenticated, anon;

-- Phase 0B: Eliminates the last remaining direct base-table read for authenticated.
-- All caller data must be accessed via flowdesk_dashboard_leads view.
REVOKE SELECT, INSERT, UPDATE, DELETE
  ON flowdesk_callers
  FROM authenticated, anon;

-- ============================================================
-- PHASE 0A: DASHBOARD VIEW — flowdesk_dashboard_leads
--
-- Safe column projection for dashboard consumption.
-- Joins flowdesk_leads + flowdesk_callers + flowdesk_call_sessions.
-- Excludes all sensitive columns.
--
-- Excluded: callback_phone, phone_hash, raw_transcript, ai_metadata
-- Included: all safe identification, CRM, and classification fields
--
-- security_invoker = false (default, stated explicitly):
--   The view executes as its owner (postgres superuser), which bypasses
--   RLS on the underlying base tables. The column allow-list is the
--   security boundary — not the caller's RLS policies.
--
-- Requires PostgreSQL 15+ (standard Supabase deployment).
-- ============================================================

CREATE OR REPLACE VIEW flowdesk_dashboard_leads
WITH (security_invoker = false)
AS
SELECT
  -- Lead identification
  l.id,
  l.caller_id,
  l.session_id,

  -- Caller fields (phone_hash excluded)
  c.display_name,
  c.phone_last4,
  c.call_count,
  c.last_call_topic,
  c.last_intent_summary,

  -- Lead contact and CRM (callback_phone excluded)
  l.business_name,
  l.contact_name,
  l.callback_phone_last4,
  l.interest_area,
  l.priority,
  l.lead_status,
  l.source,
  l.followed_up_at,
  l.created_at,
  l.updated_at,

  -- Session context (raw_transcript and ai_metadata excluded)
  s.status    AS session_status,
  s.outcome,
  s.intent_summary

FROM  flowdesk_leads          l
LEFT JOIN flowdesk_callers       c ON c.id = l.caller_id
LEFT JOIN flowdesk_call_sessions s ON s.id = l.session_id;

COMMENT ON VIEW flowdesk_dashboard_leads IS
  'Dashboard-safe view over flowdesk_leads with caller and session context. '
  'Excluded columns: callback_phone, phone_hash, raw_transcript, ai_metadata. '
  'Granted SELECT to authenticated role only. '
  'security_invoker = false: view owner (postgres) accesses base tables; '
  'column allow-list enforces the security boundary.';

-- Phase 0B: Explicit revocation before granting — closes any default or inherited access.
REVOKE ALL ON flowdesk_dashboard_leads FROM anon, public;
GRANT SELECT ON flowdesk_dashboard_leads TO authenticated;

-- ============================================================
-- END OF MIGRATION 001 (Phase 0A / 0B security hardening / Phase 0C namespace hardening applied)
-- ============================================================
