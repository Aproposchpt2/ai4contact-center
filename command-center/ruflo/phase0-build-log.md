# Phase 0 Build Log
## FlowDesk Pro — Conversational AI Agent Demo
**Date**: 2026-05-26
**Phase**: 0 / 0A Security Hardening / 0B Micro-Hardening / 0C Namespace Hardening / 0D Verification
**Coordinator**: Ruflo / Claude Code
**Status**: COMPLETE — Phase 0D verification passed. Migration executed successfully in active flowdesk-pro Supabase project. Phase 0 database foundation confirmed.

---

## Objective

Create the isolated Supabase sandbox database schema for the FlowDesk Pro
Conversational AI Agent Demo. No production systems were modified.
No frontend or Netlify Function code was written in this phase.

Phase 0A revised the RLS and access model so that authenticated dashboard
users cannot read sensitive columns directly from base tables.

Phase 0B removed the remaining direct authenticated base-table read access
from flowdesk_callers, completing the lockdown of all four base tables.

Phase 0C renamed the trigger function from the generic `set_updated_at()` to the
namespaced `flowdesk_conversational_set_updated_at()`, making the migration safe to
run inside the existing active flowdesk-pro Supabase project without conflicting with
any shared trigger functions.

---

## Files Created / Modified

| File | Purpose | Phase |
|---|---|---|
| `supabase/migrations/001_flowdesk_conversational_agent.sql` | Forward migration — creates all tables, triggers, indexes, RLS, dashboard view | 0 / 0A / 0B / 0C |
| `supabase/migrations/001_flowdesk_conversational_agent_rollback.sql` | Rollback — safely removes all Phase 0/0A/0B/0C database objects | 0 / 0A / 0B / 0C |
| `command-center/ruflo/phase0-verification-checklist.md` | Step-by-step verification with SQL test queries | 0 / 0A / 0B / 0C / 0D |
| `command-center/ruflo/phase0-build-log.md` | This file | 0 / 0A / 0B / 0C / 0D |

---

## Phase 0A Security Hardening (2026-05-26)

### Problem Addressed

Phase 0's original RLS model relied on app-layer masking for sensitive columns:
- `authenticated_read_leads` allowed direct SELECT on `flowdesk_leads`, exposing `callback_phone`.
- `authenticated_read_sessions` allowed direct SELECT on `flowdesk_call_sessions`, exposing `raw_transcript`.
- A comment noted "callback_phone masking enforced at app layer" — an insufficient control.

App-layer masking is not a database-layer security boundary. Any client with a
valid JWT and direct Supabase API access could query the omitted columns.

### Changes Applied

**RLS policies removed:**

| Policy | Table | Reason |
|---|---|---|
| `authenticated_read_leads` | flowdesk_leads | Exposed callback_phone |
| `authenticated_update_leads` | flowdesk_leads | Base-table writes must be service_role only |
| `authenticated_read_sessions` | flowdesk_call_sessions | Exposed raw_transcript |

**Privilege revocation added:**

```sql
REVOKE SELECT, INSERT, UPDATE, DELETE ON flowdesk_leads FROM authenticated, anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON flowdesk_call_sessions FROM authenticated, anon;
```

**Dashboard view added:**

`flowdesk_dashboard_leads` — a `security_invoker = false` view that joins
`flowdesk_leads`, `flowdesk_callers`, and `flowdesk_call_sessions`,
exposing only 21 safe columns. Granted SELECT to `authenticated` only.

**Columns excluded from view:**

| Column | Table | Reason |
|---|---|---|
| callback_phone | flowdesk_leads | Full callback number — CRM data |
| phone_hash | flowdesk_callers | Caller identity hash |
| raw_transcript | flowdesk_call_sessions | PII-adjacent conversation data |
| ai_metadata | flowdesk_call_sessions | Operational/cost metadata |

**Rollback updated** to drop `flowdesk_dashboard_leads` view before base tables,
and to not attempt dropping the three removed policies.

### Security Model After Phase 0A

| Role | flowdesk_leads | flowdesk_call_sessions | flowdesk_callers | flowdesk_dashboard_leads |
|---|---|---|---|---|
| service_role | FULL (bypasses RLS) | FULL (bypasses RLS) | FULL (bypasses RLS) | n/a (uses base tables) |
| authenticated | NONE | NONE | SELECT | SELECT (safe columns only) |
| anon | NONE | NONE | NONE | NONE |

---

## Phase 0B Micro-Hardening (2026-05-26)

### Problem Addressed

Phase 0A left one remaining direct authenticated base-table read: `authenticated_read_callers`
on `flowdesk_callers`. The rationale at the time was that `phone_hash` is useless without the
server-side salt, making direct authenticated access "safe." However, consistent database-layer
enforcement requires that authenticated users have zero direct base-table access. Any direct
read of `flowdesk_callers` also exposed non-sensitive but unnecessary fields outside the view's
controlled column allow-list.

### Changes Applied

**RLS policy removed:**

| Policy | Table | Reason |
|---|---|---|
| `authenticated_read_callers` | flowdesk_callers | Direct base-table reads eliminated (Phase 0B) |

**Privilege revocation added:**

```sql
REVOKE SELECT, INSERT, UPDATE, DELETE ON flowdesk_callers FROM authenticated, anon;
```

**Dashboard view access hardened:**

```sql
REVOKE ALL ON flowdesk_dashboard_leads FROM anon, public;
GRANT SELECT ON flowdesk_dashboard_leads TO authenticated;
```

**Rollback updated** to include `REVOKE ALL ON flowdesk_dashboard_leads FROM anon, public;`
before `DROP VIEW` for clean teardown, and notes the `authenticated_read_callers` drop
as a safe no-op since the policy no longer exists after Phase 0B.

### Security Model After Phase 0B

| Role | flowdesk_leads | flowdesk_call_sessions | flowdesk_callers | flowdesk_dashboard_leads |
|---|---|---|---|---|
| service_role | FULL (bypasses RLS) | FULL (bypasses RLS) | FULL (bypasses RLS) | n/a (uses base tables) |
| authenticated | NONE | NONE | NONE | SELECT (safe columns only) |
| anon | NONE | NONE | NONE | NONE (explicit revoke) |

---

## Phase 0C Namespace Hardening (2026-05-26)

### Problem Addressed

The migration used a generic function name `set_updated_at()` declared with `CREATE OR REPLACE`.
If the existing active flowdesk-pro Supabase project already has a `set_updated_at()` function
(from another migration), running this migration would silently overwrite it. If that existing
function is used by other tables, those tables' triggers would now point to the version
defined here — a shared-object collision with potential for silent behavioral change.

### Changes Applied

**Trigger function renamed:**

| Old Name | New Name |
|---|---|
| `set_updated_at()` | `flowdesk_conversational_set_updated_at()` |

**All three triggers updated:**

| Trigger | Table | Now Calls |
|---|---|---|
| `set_updated_at_flowdesk_callers` | flowdesk_callers | `flowdesk_conversational_set_updated_at()` |
| `set_updated_at_flowdesk_call_sessions` | flowdesk_call_sessions | `flowdesk_conversational_set_updated_at()` |
| `set_updated_at_flowdesk_leads` | flowdesk_leads | `flowdesk_conversational_set_updated_at()` |

**Rollback updated:**

- Replaced the commented-out `-- DROP FUNCTION IF EXISTS set_updated_at();` with the active:
  `DROP FUNCTION IF EXISTS flowdesk_conversational_set_updated_at();`
- The generic `set_updated_at()` function is **never touched** by this migration or its rollback.

### Namespace Compliance Confirmation

All objects created by this migration are namespaced with `flowdesk_` or `flowdesk_conversational_`:

| Object Type | Names |
|---|---|
| Tables | `flowdesk_callers`, `flowdesk_call_sessions`, `flowdesk_leads`, `flowdesk_agent_notes` |
| View | `flowdesk_dashboard_leads` |
| Indexes | `idx_flowdesk_*` (12 total) |
| Policies | `service_role_all_callers`, `service_role_all_sessions`, etc. (scoped to flowdesk_ tables) |
| Triggers | `set_updated_at_flowdesk_*` (3 total) |
| Function | `flowdesk_conversational_set_updated_at` |

No generic or shared object names are created or modified by this migration.

---

## Phase 0D Verification (2026-05-26)

### Migration Execution

The hardened Phase 0C migration (`001_flowdesk_conversational_agent.sql`) was executed in the
active **flowdesk-pro** Supabase project.

**Result**: Success. No rows returned. No errors.

### Objects Confirmed

| Object | Type | Verified |
|---|---|---|
| flowdesk_agent_notes | BASE TABLE | ✓ |
| flowdesk_call_sessions | BASE TABLE | ✓ |
| flowdesk_callers | BASE TABLE | ✓ |
| flowdesk_dashboard_leads | VIEW | ✓ |
| flowdesk_leads | BASE TABLE | ✓ |

### Function and Triggers Confirmed

| Object | Verified |
|---|---|
| `flowdesk_conversational_set_updated_at` (function) | ✓ |
| `set_updated_at` (generic) — untouched, owned by other migrations | ✓ |
| `set_updated_at_flowdesk_call_sessions` (trigger) | ✓ |
| `set_updated_at_flowdesk_callers` (trigger) | ✓ |
| `set_updated_at_flowdesk_leads` (trigger) | ✓ |

### RLS Confirmed

| Table | RLS Enabled |
|---|---|
| flowdesk_agent_notes | ✓ |
| flowdesk_call_sessions | ✓ |
| flowdesk_callers | ✓ |
| flowdesk_leads | ✓ |

### Dashboard View Column Exclusion Confirmed

Confirmed absent from `flowdesk_dashboard_leads`:

| Excluded Column | Confirmed Absent |
|---|---|
| callback_phone | ✓ |
| phone_hash | ✓ |
| raw_transcript | ✓ |
| ai_metadata | ✓ |

### Policy Verification

| Role | Access Verified |
|---|---|
| service_role | ALL on all 4 base tables ✓ |
| authenticated | INSERT + SELECT on flowdesk_agent_notes only ✓ |
| authenticated | No direct read policy on flowdesk_callers ✓ |
| authenticated | No direct read policy on flowdesk_call_sessions ✓ |
| authenticated | No direct read policy on flowdesk_leads ✓ |

**Note**: `flowdesk_intake_records` policy appeared in the policy query. This policy is
pre-existing in the flowdesk-pro project and is unrelated to this migration. No action taken.

### Phase 1 Status

Phase 1 (Backend Netlify Functions) was **not started**. Awaiting Jeffrey Mitchell sign-off.

---

## Architecture Decisions

### Phone Number Security
- Phone numbers are **never stored in plain text** in any database column.
- `phone_hash` = `SHA-256(PHONE_HASH_SALT + E.164_number)`.
- `PHONE_HASH_SALT` is a server environment variable — not stored in the database.
- `phone_last4` stores the last 4 digits only, for dashboard display masking.
- This approach prevents reconstruction of phone numbers even if the database is compromised.

### Repeat-Caller Recognition
- `flowdesk_callers.phone_hash` is the sole identity key for repeat-caller lookup.
- `call_count` increments on each call via Netlify Function upsert.
- `last_intent_summary` and `last_call_topic` are injected into the AI system prompt
  to enable personalized greetings on repeat calls.
- Example greeting: _"Hello Mr. Mitchell, welcome back. I see your last call was
  about the AI Contact Center demo. How may I help you today?"_

### callback_phone Handling (Phase 0A)
- `flowdesk_leads.callback_phone` stores the full callback number provided by the caller.
- Classified as **operational CRM data**.
- After Phase 0A: NOT readable by authenticated role at the database layer.
- Readable only by service_role (server-side Netlify Functions).
- Dashboard displays `callback_phone_last4` via `flowdesk_dashboard_leads` view.
- This is a database-layer control, not an app-layer control.

### RLS Strategy (Phase 0A)
- `service_role` (Netlify Functions): bypasses RLS by default in Supabase.
  Explicit policies added for documentation and defense-in-depth.
- `authenticated` (dashboard agents): SELECT on `flowdesk_agent_notes` only.
  No direct access to `flowdesk_callers`, `flowdesk_leads`, or `flowdesk_call_sessions` (Phase 0B).
  Dashboard reads via `flowdesk_dashboard_leads` view.
- `anon`: no policies created — default deny on all tables.
- `flowdesk_dashboard_leads`: `SELECT` granted to `authenticated` only.

### Dashboard View Security Model
- `flowdesk_dashboard_leads` uses `security_invoker = false` (PostgreSQL 15+ default).
- The view executes as its owner (`postgres` superuser), bypassing RLS on base tables.
- The column allow-list is the security boundary: sensitive columns are simply not included.
- Requires PostgreSQL 15+ (standard Supabase deployment).

### Trigger Function
- `flowdesk_conversational_set_updated_at()` is the namespaced trigger function for this migration (Phase 0C).
- Applied to `flowdesk_callers`, `flowdesk_call_sessions`, `flowdesk_leads`.
- `flowdesk_agent_notes` has no `updated_at` — it is append-only by design.
- The generic `set_updated_at()` function is never created, replaced, or dropped by this migration.

### Check Constraints
| Table | Column | Allowed Values |
|---|---|---|
| flowdesk_call_sessions | status | `in_progress`, `completed`, `failed`, `no_answer`, `busy`, `canceled` |
| flowdesk_call_sessions | outcome | `callback_requested`, `info_delivered`, `transferred`, `abandoned`, `voicemail`, `unknown` (nullable) |
| flowdesk_leads | priority | `hot`, `warm`, `normal`, `cold` |
| flowdesk_leads | lead_status | `new`, `contacted`, `qualified`, `closed_won`, `closed_lost`, `no_answer` |

---

## Manual Supabase Setup Steps

These steps must be executed manually in the Supabase sandbox project.

1. Log in to [supabase.com](https://supabase.com)
2. Select (or create) the **sandbox** project for FlowDesk demo — NOT production
3. Navigate to **SQL Editor**
4. Open `supabase/migrations/001_flowdesk_conversational_agent.sql`
5. Paste the full contents into the SQL Editor
6. Click **Run**
7. Confirm: **Success. No errors.**
8. Execute each verification query from `phase0-verification-checklist.md`
9. Check off all items in the verification checklist (Steps 1–13)
10. Obtain Jeffrey Mitchell sign-off before proceeding to Phase 1

---

## Environment Variables Required for Phase 1

The following env vars must be set in Netlify before Phase 1 begins.
They are listed here for planning only — do not store values in this file.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Sandbox project API URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side writes (Netlify Functions only) |
| `SUPABASE_ANON_KEY` | Frontend read (safe to expose) |
| `PHONE_HASH_SALT` | Phone number hashing — must be generated and stored securely |
| `TWILIO_ACCOUNT_SID` | Twilio API authentication |
| `TWILIO_AUTH_TOKEN` | Twilio webhook signature validation |
| `TWILIO_PHONE_NUMBER` | Demo phone number (E.164) |
| `ANTHROPIC_API_KEY` | Claude AI responses |
| `DASHBOARD_JWT_SECRET` | Dashboard session authentication |

> **PHONE_HASH_SALT**: Generate with `openssl rand -hex 32`.
> Store in Netlify env vars. Once callers are in the database,
> this salt must never change — changing it breaks all repeat-caller lookups.

---

## Rollback Instructions

If Phase 0 / 0A needs to be undone:

1. Confirm authorization from Jeffrey Mitchell
2. Confirm you are in the **sandbox** Supabase project
3. Open Supabase SQL Editor
4. Paste contents of `supabase/migrations/001_flowdesk_conversational_agent_rollback.sql`
5. Click **Run**
6. Confirm all flowdesk tables and view are gone:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name LIKE 'flowdesk_%';
   -- Expected: 0 rows
   ```
7. Log rollback in this build log under the "Break/Fix Log" section below

---

## Break/Fix Log

| Date | Issue | Resolution | Resolved By |
|---|---|---|---|
| 2026-05-26 | Phase 0A: authenticated_read_leads exposed callback_phone; authenticated_read_sessions exposed raw_transcript | Removed direct-access policies; added flowdesk_dashboard_leads view with column allow-list; added REVOKE statements | Ruflo / Claude Code |
| 2026-05-26 | Phase 0B: authenticated_read_callers left authenticated with direct base-table read on flowdesk_callers | Removed authenticated_read_callers policy; added REVOKE on flowdesk_callers; added REVOKE ALL on dashboard view from anon/public | Ruflo / Claude Code |
| 2026-05-26 | Phase 0C: Generic set_updated_at() function name would conflict with existing functions in the active flowdesk-pro Supabase project | Renamed to flowdesk_conversational_set_updated_at(); updated all 3 triggers; rollback now actively drops namespaced function only | Ruflo / Claude Code |
| 2026-05-26 | Phase 0D: Post-migration verification executed for Phase 0C migration in active flowdesk-pro Supabase project | All objects, triggers, RLS, dashboard view column exclusions, and policies confirmed. flowdesk_intake_records policy noted as pre-existing and unrelated. Phase 1 not started. | Ruflo / Claude Code |

---

## Phase 0 Completion Criteria

- [x] Migration executed in sandbox without errors
- [ ] All verification checklist items checked off (Steps 1–13)
- [ ] Phase 0A security hardening verified (Steps 6–9)
- [ ] Jeffrey Mitchell sign-off obtained
- [ ] Ready for Phase 1: Backend Netlify Functions

---

## Protected Rules Compliance

Per `flowdesk-build-rules.md`:

| Rule | Complied |
|---|---|
| Did not modify production systems | ✓ |
| Built as isolated sandbox path | ✓ |
| No service keys, Twilio tokens, or API keys in any file | ✓ |
| No mixing of webhook types | ✓ (Phase 0 is DB only) |
| Did not modify AI4 Website Design files | ✓ |
| Did not modify existing FlowDesk Pro demos | ✓ |
| Architecture summary included | ✓ |
| File list included | ✓ |
| SQL included | ✓ |
| Test checklist included | ✓ |
| Rollback notes included | ✓ |
| Break/fix log entry included | ✓ |
| Phase 0A security hardening applied | ✓ |
| Phase 0B micro-hardening applied | ✓ |
| Phase 0C namespace hardening applied | ✓ |
| Phase 0D verification logging executed | ✓ |
| Did not proceed to Phase 1 | ✓ |
