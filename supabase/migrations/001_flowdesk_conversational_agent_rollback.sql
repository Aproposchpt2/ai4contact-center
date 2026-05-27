-- ============================================================
-- FlowDesk Pro — Conversational AI Agent Demo
-- Rollback: 001_flowdesk_conversational_agent_rollback.sql
-- Purpose:  Safely undo migration 001 (including Phase 0A, Phase 0B, and Phase 0C hardening).
-- ============================================================
-- WARNING: THIS SCRIPT PERMANENTLY DELETES ALL DATA
--          IN THE FLOWDESK DEMO TABLES.
--
-- Authorization required before execution.
-- Jeffrey Mitchell (Founder / Systems Architect) must approve.
-- Run ONLY in the sandbox Supabase project.
-- NEVER run against a production Supabase project.
-- ============================================================

-- ---- Drop Phase 0A / 0B objects first ----

-- Dashboard view must be dropped before its underlying tables.
-- Revoke all grants before dropping so the operation is clean.
REVOKE ALL ON flowdesk_dashboard_leads FROM anon, public;
REVOKE SELECT ON flowdesk_dashboard_leads FROM authenticated;
DROP VIEW IF EXISTS flowdesk_dashboard_leads;

-- ---- Drop RLS policies ----

-- flowdesk_callers
DROP POLICY IF EXISTS "service_role_all_callers"       ON flowdesk_callers;
-- Note: authenticated_read_callers was removed in Phase 0B (DROP IF EXISTS is safe no-op)
DROP POLICY IF EXISTS "authenticated_read_callers"     ON flowdesk_callers;

-- flowdesk_call_sessions
DROP POLICY IF EXISTS "service_role_all_sessions"      ON flowdesk_call_sessions;
-- Note: authenticated_read_sessions was removed in Phase 0A

-- flowdesk_leads
DROP POLICY IF EXISTS "service_role_all_leads"         ON flowdesk_leads;
-- Note: authenticated_read_leads and authenticated_update_leads removed in Phase 0A

-- flowdesk_agent_notes
DROP POLICY IF EXISTS "service_role_all_notes"         ON flowdesk_agent_notes;
DROP POLICY IF EXISTS "authenticated_read_notes"       ON flowdesk_agent_notes;
DROP POLICY IF EXISTS "authenticated_insert_notes"     ON flowdesk_agent_notes;

-- ---- Disable RLS (before table drop, for safety) ----
ALTER TABLE IF EXISTS flowdesk_agent_notes   DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS flowdesk_leads         DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS flowdesk_call_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS flowdesk_callers       DISABLE ROW LEVEL SECURITY;

-- ---- Drop triggers ----
DROP TRIGGER IF EXISTS set_updated_at_flowdesk_leads         ON flowdesk_leads;
DROP TRIGGER IF EXISTS set_updated_at_flowdesk_call_sessions ON flowdesk_call_sessions;
DROP TRIGGER IF EXISTS set_updated_at_flowdesk_callers       ON flowdesk_callers;

-- ---- Drop indexes (auto-dropped with tables, listed for explicitness) ----
DROP INDEX IF EXISTS idx_flowdesk_callers_phone_hash;
DROP INDEX IF EXISTS idx_flowdesk_callers_created_at;
DROP INDEX IF EXISTS idx_flowdesk_sessions_caller_id;
DROP INDEX IF EXISTS idx_flowdesk_sessions_twilio_sid;
DROP INDEX IF EXISTS idx_flowdesk_sessions_created_at;
DROP INDEX IF EXISTS idx_flowdesk_sessions_status;
DROP INDEX IF EXISTS idx_flowdesk_leads_caller_id;
DROP INDEX IF EXISTS idx_flowdesk_leads_session_id;
DROP INDEX IF EXISTS idx_flowdesk_leads_priority;
DROP INDEX IF EXISTS idx_flowdesk_leads_lead_status;
DROP INDEX IF EXISTS idx_flowdesk_leads_created_at;
DROP INDEX IF EXISTS idx_flowdesk_notes_lead_id;

-- ---- Drop tables (child-first to respect foreign keys) ----
DROP TABLE IF EXISTS flowdesk_agent_notes   CASCADE;
DROP TABLE IF EXISTS flowdesk_leads         CASCADE;
DROP TABLE IF EXISTS flowdesk_call_sessions CASCADE;
DROP TABLE IF EXISTS flowdesk_callers       CASCADE;

-- ---- Drop trigger function ----
-- Only drops the namespaced function created by this migration.
-- The generic set_updated_at() function (if it exists in the project) is NOT touched.
DROP FUNCTION IF EXISTS flowdesk_conversational_set_updated_at();

-- ============================================================
-- END OF ROLLBACK 001 (includes Phase 0A, Phase 0B micro-hardening, Phase 0C namespace hardening)
-- ============================================================
