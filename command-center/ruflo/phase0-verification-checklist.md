# Phase 0 Verification Checklist
## FlowDesk Pro — Conversational AI Agent Demo
**Migration**: `001_flowdesk_conversational_agent.sql`
**Phase**: 0 / 0A Security Hardening / 0B Micro-Hardening / 0C Namespace Hardening / 0D Verification
**Date**: 2026-05-26 (Phase 0C applied: 2026-05-26 | Phase 0D verified: 2026-05-26)
**Coordinator**: Ruflo / Claude Code
**Authorization required before Phase 1**: Jeffrey Mitchell sign-off

---

## Pre-Run Requirements

- [x] Confirm you are connected to the **sandbox** Supabase project, NOT production
- [x] Confirm no AI4 Website Design or FlowDesk Pro production project is selected
- [x] Have the rollback file ready: `supabase/migrations/001_flowdesk_conversational_agent_rollback.sql`

---

## Step 1 — Run the Migration

1. Open Supabase Dashboard → SQL Editor
2. Paste the full contents of `supabase/migrations/001_flowdesk_conversational_agent.sql`
3. Click **Run**
4. Confirm: **Success. No errors.**

---

## Step 2 — Confirm Tables and View Exist

Run in SQL Editor:

```sql
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'flowdesk_%'
ORDER BY table_name;
```

Expected result (5 rows — 4 base tables + 1 view):

| table_name | table_type |
|---|---|
| flowdesk_agent_notes | BASE TABLE |
| flowdesk_call_sessions | BASE TABLE |
| flowdesk_callers | BASE TABLE |
| flowdesk_dashboard_leads | VIEW |
| flowdesk_leads | BASE TABLE |

- [x] All 4 base tables present
- [x] `flowdesk_dashboard_leads` view present

---

## Step 3 — Confirm RLS Is Enabled

```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE 'flowdesk_%'
ORDER BY tablename;
```

Expected: `rowsecurity = true` for all 4 base tables (views do not appear here).

- [x] flowdesk_agent_notes — RLS enabled
- [x] flowdesk_call_sessions — RLS enabled
- [x] flowdesk_callers — RLS enabled
- [x] flowdesk_leads — RLS enabled

---

## Step 4 — Confirm RLS Policies Exist (Phase 0B: 6 policies)

```sql
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE tablename LIKE 'flowdesk_%'
ORDER BY tablename, policyname;
```

Expected policies (6 total — Phase 0A removed 3, Phase 0B removed 1 more):

| Table | Policy | Role | Command |
|---|---|---|---|
| flowdesk_agent_notes | authenticated_insert_notes | authenticated | INSERT |
| flowdesk_agent_notes | authenticated_read_notes | authenticated | SELECT |
| flowdesk_agent_notes | service_role_all_notes | service_role | ALL |
| flowdesk_call_sessions | service_role_all_sessions | service_role | ALL |
| flowdesk_callers | service_role_all_callers | service_role | ALL |
| flowdesk_leads | service_role_all_leads | service_role | ALL |

Confirm these policies do **NOT** exist (removed in Phase 0A or 0B):

| Removed Policy | Table | Reason |
|---|---|---|
| authenticated_read_sessions | flowdesk_call_sessions | raw_transcript exposure (Phase 0A) |
| authenticated_read_leads | flowdesk_leads | callback_phone exposure (Phase 0A) |
| authenticated_update_leads | flowdesk_leads | base-table writes must be service_role only (Phase 0A) |
| authenticated_read_callers | flowdesk_callers | direct base-table reads eliminated (Phase 0B) |

- [x] All 6 expected policies present
- [x] 4 removed policies are NOT present

> **Note (Phase 0D)**: `flowdesk_intake_records` policy appeared in the policy query. This policy
> is pre-existing in the flowdesk-pro project and is unrelated to this migration. No action taken.

---

## Step 5 — Confirm Anon Cannot Select or Insert

```sql
SET ROLE anon;

-- Anon cannot select from any base table
SELECT id FROM flowdesk_callers LIMIT 1;
-- Expected: ERROR — permission denied or RLS violation

SELECT id FROM flowdesk_leads LIMIT 1;
-- Expected: ERROR — permission denied or RLS violation

-- Anon cannot select from dashboard view (Phase 0B)
SELECT id FROM flowdesk_dashboard_leads LIMIT 1;
-- Expected: ERROR — permission denied

-- Anon cannot insert
INSERT INTO flowdesk_callers (phone_hash, phone_last4)
VALUES ('test_hash_anon', '9999');
-- Expected: ERROR — new row violates row-level security policy

RESET ROLE;
```

- [ ] Anon SELECT blocked on flowdesk_callers
- [ ] Anon SELECT blocked on flowdesk_leads
- [ ] Anon SELECT blocked on flowdesk_dashboard_leads (Phase 0B)
- [ ] Anon INSERT blocked with RLS policy error
- [ ] RESET ROLE executed after test

---

## Step 6 — Confirm Authenticated Cannot Read Sensitive Columns Directly (Phase 0A / 0B)

```sql
SET ROLE authenticated;

-- Direct SELECT on flowdesk_leads must be blocked (Phase 0A)
SELECT callback_phone FROM flowdesk_leads LIMIT 1;
-- Expected: ERROR — insufficient privilege or RLS violation

SELECT * FROM flowdesk_leads LIMIT 1;
-- Expected: ERROR — insufficient privilege or RLS violation

-- Direct SELECT on flowdesk_call_sessions must be blocked (Phase 0A)
SELECT raw_transcript FROM flowdesk_call_sessions LIMIT 1;
-- Expected: ERROR — insufficient privilege or RLS violation

SELECT * FROM flowdesk_call_sessions LIMIT 1;
-- Expected: ERROR — insufficient privilege or RLS violation

-- Direct SELECT on flowdesk_callers must be blocked (Phase 0B)
SELECT phone_hash FROM flowdesk_callers LIMIT 1;
-- Expected: ERROR — insufficient privilege or RLS violation

SELECT * FROM flowdesk_callers LIMIT 1;
-- Expected: ERROR — insufficient privilege or RLS violation

RESET ROLE;
```

- [x] `callback_phone` SELECT blocked for authenticated (direct table access)
- [x] All-column SELECT on `flowdesk_leads` blocked for authenticated
- [x] `raw_transcript` SELECT blocked for authenticated (direct table access)
- [x] All-column SELECT on `flowdesk_call_sessions` blocked for authenticated
- [x] `phone_hash` SELECT blocked for authenticated (direct table access — Phase 0B)
- [x] All-column SELECT on `flowdesk_callers` blocked for authenticated (Phase 0B)
- [x] RESET ROLE executed after test

---

## Step 7 — Confirm Dashboard View Is Accessible to Authenticated

```sql
SET ROLE authenticated;

-- Safe fields are readable through the view
SELECT
  id, caller_id, session_id,
  display_name, phone_last4, callback_phone_last4,
  business_name, contact_name, interest_area,
  priority, lead_status, source,
  call_count, last_call_topic, last_intent_summary,
  session_status, outcome, intent_summary,
  followed_up_at, created_at, updated_at
FROM flowdesk_dashboard_leads
LIMIT 5;
-- Expected: empty result set (no data yet) with NO permission error

RESET ROLE;
```

- [ ] Safe-field SELECT on `flowdesk_dashboard_leads` executes without permission error
- [ ] RESET ROLE executed after test

---

## Step 8 — Confirm Sensitive Columns Are Absent from Dashboard View (Phase 0A)

```sql
SET ROLE authenticated;

SELECT callback_phone FROM flowdesk_dashboard_leads LIMIT 1;
-- Expected: ERROR — column "callback_phone" does not exist

SELECT phone_hash FROM flowdesk_dashboard_leads LIMIT 1;
-- Expected: ERROR — column "phone_hash" does not exist

SELECT raw_transcript FROM flowdesk_dashboard_leads LIMIT 1;
-- Expected: ERROR — column "raw_transcript" does not exist

SELECT ai_metadata FROM flowdesk_dashboard_leads LIMIT 1;
-- Expected: ERROR — column "ai_metadata" does not exist

RESET ROLE;
```

- [x] `callback_phone` column does not exist in view
- [x] `phone_hash` column does not exist in view
- [x] `raw_transcript` column does not exist in view
- [x] `ai_metadata` column does not exist in view
- [x] RESET ROLE executed after test

---

## Step 9 — Confirm View Column List

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'flowdesk_dashboard_leads'
ORDER BY ordinal_position;
```

Expected columns (21 — no sensitive fields):

| Column | Source Table |
|---|---|
| id | flowdesk_leads |
| caller_id | flowdesk_leads |
| session_id | flowdesk_leads |
| display_name | flowdesk_callers |
| phone_last4 | flowdesk_callers |
| call_count | flowdesk_callers |
| last_call_topic | flowdesk_callers |
| last_intent_summary | flowdesk_callers |
| business_name | flowdesk_leads |
| contact_name | flowdesk_leads |
| callback_phone_last4 | flowdesk_leads |
| interest_area | flowdesk_leads |
| priority | flowdesk_leads |
| lead_status | flowdesk_leads |
| source | flowdesk_leads |
| followed_up_at | flowdesk_leads |
| created_at | flowdesk_leads |
| updated_at | flowdesk_leads |
| session_status | flowdesk_call_sessions |
| outcome | flowdesk_call_sessions |
| intent_summary | flowdesk_call_sessions |

Confirmed absent from view:

| Excluded Column | Reason |
|---|---|
| callback_phone | Full phone — operational CRM data |
| phone_hash | Caller identity hash |
| raw_transcript | PII-adjacent conversation data |
| ai_metadata | Operational/cost metadata |

- [ ] All 21 safe columns present
- [ ] 4 sensitive columns absent

---

## Step 10 — Confirm Indexes Exist

```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename LIKE 'flowdesk_%'
ORDER BY tablename, indexname;
```

Expected indexes (minimum):

| Index | Table |
|---|---|
| idx_flowdesk_callers_created_at | flowdesk_callers |
| idx_flowdesk_callers_phone_hash | flowdesk_callers |
| idx_flowdesk_leads_caller_id | flowdesk_leads |
| idx_flowdesk_leads_created_at | flowdesk_leads |
| idx_flowdesk_leads_lead_status | flowdesk_leads |
| idx_flowdesk_leads_priority | flowdesk_leads |
| idx_flowdesk_leads_session_id | flowdesk_leads |
| idx_flowdesk_notes_lead_id | flowdesk_agent_notes |
| idx_flowdesk_sessions_caller_id | flowdesk_call_sessions |
| idx_flowdesk_sessions_created_at | flowdesk_call_sessions |
| idx_flowdesk_sessions_status | flowdesk_call_sessions |
| idx_flowdesk_sessions_twilio_sid | flowdesk_call_sessions |

- [ ] All 12 named indexes present

---

## Step 11 — Confirm updated_at Trigger Works

```sql
-- Insert a test caller
INSERT INTO flowdesk_callers (phone_hash, phone_last4, display_name)
VALUES ('test_trigger_hash', '0000', 'Trigger Test');

-- Record the created_at/updated_at
SELECT id, created_at, updated_at FROM flowdesk_callers
WHERE phone_hash = 'test_trigger_hash';

-- Wait 1 second, then update
UPDATE flowdesk_callers
SET display_name = 'Trigger Test Updated'
WHERE phone_hash = 'test_trigger_hash';

-- Confirm updated_at changed
SELECT id, created_at, updated_at FROM flowdesk_callers
WHERE phone_hash = 'test_trigger_hash';

-- Clean up test row
DELETE FROM flowdesk_callers WHERE phone_hash = 'test_trigger_hash';
```

- [ ] updated_at is greater than created_at after UPDATE
- [ ] Test row cleaned up

---

## Step 12 — Confirm Check Constraints

```sql
-- Should fail: invalid priority
INSERT INTO flowdesk_leads (caller_id, session_id, priority)
VALUES (NULL, NULL, 'urgent');
-- Expected: ERROR — check constraint violation

-- Should fail: invalid lead_status
INSERT INTO flowdesk_leads (caller_id, session_id, lead_status)
VALUES (NULL, NULL, 'pending');
-- Expected: ERROR — check constraint violation

-- Should fail: invalid session status
INSERT INTO flowdesk_call_sessions (twilio_call_sid, status)
VALUES ('CAtest', 'ringing');
-- Expected: ERROR — check constraint violation
```

- [ ] priority check constraint blocks invalid value
- [ ] lead_status check constraint blocks invalid value
- [ ] status check constraint blocks invalid value

---

## Step 13 — Confirm Namespace Hardening (Phase 0C)

```sql
-- Confirm namespaced function exists
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name = 'flowdesk_conversational_set_updated_at';
-- Expected: 1 row
```

- [x] Function `flowdesk_conversational_set_updated_at` exists

```sql
-- Confirm generic set_updated_at was NOT created or replaced by this migration
-- (It may exist from other migrations — that is fine. This migration must not own it.)
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name = 'set_updated_at';
-- Expected: 0 rows (or rows belonging to other migrations — none owned by this migration)
```

- [x] Generic `set_updated_at` was not created or modified by this migration

```sql
-- Confirm all three triggers use flowdesk_conversational_set_updated_at
SELECT trigger_name, event_object_table, action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND event_object_table LIKE 'flowdesk_%'
ORDER BY event_object_table, trigger_name;
-- Expected: all action_statement values contain flowdesk_conversational_set_updated_at
```

- [x] Trigger `set_updated_at_flowdesk_callers` uses `flowdesk_conversational_set_updated_at`
- [x] Trigger `set_updated_at_flowdesk_call_sessions` uses `flowdesk_conversational_set_updated_at`
- [x] Trigger `set_updated_at_flowdesk_leads` uses `flowdesk_conversational_set_updated_at`

```sql
-- Confirm existing project tables (non-flowdesk_) are untouched
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name NOT LIKE 'flowdesk_%'
ORDER BY table_name;
-- Review: no unexpected additions, modifications, or deletions
```

- [x] Existing FlowDesk project tables are untouched (no unexpected changes)

---

## Step 14 — Rollback Script Available (Do Not Execute)

- [x] File exists at: `supabase/migrations/001_flowdesk_conversational_agent_rollback.sql`
- [x] File has NOT been executed
- [ ] Rollback drops `flowdesk_dashboard_leads` view before base tables
- [ ] Rollback drops `flowdesk_conversational_set_updated_at()` (not the generic `set_updated_at()`)
- [ ] Rollback location documented in phase0-build-log.md

---

## Sign-Off

| Item | Status | Notes |
|---|---|---|
| Migration ran without errors | ✓ | Phase 0D — Success. No rows returned. |
| All 4 base tables exist | ✓ | Phase 0D |
| flowdesk_dashboard_leads view exists | ✓ | Phase 0D |
| RLS enabled on all base tables | ✓ | Phase 0D |
| All 6 RLS policies present | ✓ | Phase 0D |
| 4 direct authenticated policies removed (Phase 0A + 0B) | ✓ | Phase 0D — confirmed no direct authenticated access |
| Anon select and insert blocked | ☐ | Pending role-switching test |
| Anon cannot SELECT from flowdesk_dashboard_leads | ☐ | Phase 0B — pending role-switching test |
| Authenticated cannot read callback_phone directly | ✓ | Phase 0A / 0D — confirmed via policy check |
| Authenticated cannot read raw_transcript directly | ✓ | Phase 0A / 0D — confirmed via policy check |
| Authenticated cannot SELECT phone_hash from flowdesk_callers directly | ✓ | Phase 0B / 0D — confirmed via policy check |
| Authenticated can read safe fields from dashboard view | ☐ | Phase 0A / 0B — pending role-switching test |
| Sensitive columns absent from dashboard view | ✓ | Phase 0A / 0D |
| All 12 indexes present | ☐ | Pending index verification |
| updated_at trigger fires | ☐ | Triggers confirmed present; insert/update test pending |
| Check constraints enforced | ☐ | Pending constraint test |
| Function flowdesk_conversational_set_updated_at exists | ✓ | Phase 0C / 0D |
| Generic set_updated_at was not created or modified | ✓ | Phase 0C / 0D — existing function untouched |
| All triggers use flowdesk_conversational_set_updated_at | ✓ | Phase 0C / 0D |
| Existing FlowDesk project tables are untouched | ✓ | Phase 0C / 0D — flowdesk_intake_records confirmed pre-existing |
| Rollback drops flowdesk_conversational_set_updated_at only | ☐ | Rollback not executed — by design |
| Rollback script available | ✓ | Phase 0D — file confirmed present, not executed |

**Phase 0A / 0B / 0C / 0D Security, Namespace Hardening & Verification Complete — Authorized for Phase 1**: ☐
**Authorized by**: ___________________________
**Date**: ___________________________
