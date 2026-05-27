-- ============================================================
-- FlowDesk Pro — Contact Center Dashboard
-- Migration: 003_dashboard_anon_access.sql
-- Purpose:   Grant anon role SELECT on flowdesk_dashboard_leads
--            so the client-side dashboard can read lead data
--            using the publishable (anon) key.
--            All sensitive fields (callback_phone, phone_hash,
--            raw_transcript, ai_metadata) remain excluded by the
--            view definition in migration 001.
-- Date:      2026-05-26
-- ============================================================

-- Allow anon (publishable key) to read the dashboard view.
-- The column allow-list in the view is the security boundary.
GRANT SELECT ON flowdesk_dashboard_leads TO anon;

-- ============================================================
-- END OF MIGRATION 003
-- ============================================================
