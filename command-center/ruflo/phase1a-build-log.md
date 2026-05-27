# Phase 1A Build Log
**Project:** FlowDesk Pro Conversational AI Agent
**Phase:** 1A â€” Netlify Functions Backend Foundation
**Date:** 2026-05-26
**Coordinator:** Ruflo (internal command-layer)

---

## Phase Context

Phase 0 Supabase foundation was completed, verified, and committed prior to this phase.

Active Supabase project: `flowdesk-pro`

Verified Phase 0 tables:
- `flowdesk_callers`
- `flowdesk_call_sessions`
- `flowdesk_leads`
- `flowdesk_agent_notes`
- `flowdesk_dashboard_leads` (view)

---

## Files Created

### Library Files (`netlify/functions/lib/`)

| File | Purpose |
|------|---------|
| `flowdesk-cors.js` | Reusable CORS headers; supports OPTIONS preflight; reads `FLOWDESK_ALLOWED_ORIGINS` |
| `flowdesk-supabase-admin.js` | Singleton Supabase admin client; validates env vars on init |
| `flowdesk-phone-utils.js` | `normalizePhone`, `getPhoneLast4`, `hashPhone` (SHA-256 with salt) |
| `flowdesk-response-utils.js` | `json`, `error`, `parseJsonBody` helpers |

### Function Files (`netlify/functions/`)

| File | Method | Purpose |
|------|--------|---------|
| `flowdesk-agent-health.js` | GET | Env var checks + lightweight Supabase connection test |
| `flowdesk-caller-lookup.js` | POST | Normalize phone â†’ hash â†’ query `flowdesk_callers` |
| `flowdesk-caller-upsert.js` | POST | Insert or update caller; increment `call_count` on repeat |
| `flowdesk-session-start.js` | POST | Insert into `flowdesk_call_sessions` |
| `flowdesk-lead-create.js` | POST | Insert into `flowdesk_leads`; store `callback_phone` server-side only |

### Documentation Files (`command-center/ruflo/`)

| File | Purpose |
|------|---------|
| `phase1a-test-checklist.md` | Step-by-step manual test plan with curl commands |
| `phase1a-build-log.md` | This file |

---

## Architecture Decisions

**CJS (`require`) over ESM (`import`)**
Netlify Functions Node.js runtime defaults to CommonJS. Using `require` avoids ESM/CJS interop issues with `@supabase/supabase-js` in this environment.

**Singleton Supabase client**
`flowdesk-supabase-admin.js` caches the client in module scope. Netlify function containers are reused across warm invocations, so this avoids creating redundant connections.

**`maybeSingle()` for caller lookup**
Returns `null` instead of an error when no row is found, enabling clean `found: false` responses without error handling noise.

**No `phone_hash` in responses**
`phone_hash` is computed server-side and used only for DB queries. It is never included in any JSON response payload, satisfying security requirement #5.

**`callback_phone` stored but not returned**
Full normalized `callback_phone` is written to `flowdesk_leads.callback_phone` server-side. The response returns only `callback_phone_last4`, satisfying security requirement #6.

**Conservative CORS when `FLOWDESK_ALLOWED_ORIGINS` is absent**
No `Access-Control-Allow-Origin` header is sent if the env var is not configured, preventing unintended cross-origin access during development.

---

## Environment Variables Required

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service-role key (never expose to frontend) |
| `PHONE_HASH_SALT` | Yes | Secret salt for SHA-256 phone hashing |
| `FLOWDESK_ALLOWED_ORIGINS` | No | Comma-separated allowed CORS origins |

---

## Phase Boundary â€” What Was NOT Built

| Item | Status |
|------|--------|
| Twilio voice webhook / TwiML | NOT started |
| AI conversation logic | NOT started |
| Frontend HTML/CSS/JS files | NOT created |
| Dashboard files | NOT created |
| Existing FlowDesk Pro production demo files | NOT modified |
| AI4 Website Design files | NOT modified |
| Stripe integration | NOT started |
| Existing webhook files | NOT modified |
| `src/` folder | NOT created |
| Supabase schema changes | NOT applied |

---

## Phase 1A-Config — Dependency & Runtime Configuration (2026-05-26)

### Files Added

| File | Purpose |
|------|---------|
| `package.json` | CommonJS project manifest; declares `@supabase/supabase-js` and `ws` dependencies; pins Node ≥22 engine |
| `netlify.toml` | Sets functions directory to `netlify/functions`; aligns Node 22 runtime via `NODE_VERSION`; uses esbuild bundler |

### Why `ws`

`ws` is required for Netlify/Supabase WebSocket compatibility. The Supabase JS client uses WebSocket connections for real-time and some auth flows; providing `ws` explicitly avoids bundling issues on the Netlify Lambda runtime.

### Node 22 Alignment

`package.json` `engines.node` set to `>=22.0.0`.
`netlify.toml` `[functions.environment]` sets `NODE_VERSION = "22"` to ensure function runtime matches.

### Environment Variables Still Required (Netlify Dashboard → Site Settings → Environment Variables)

| Variable | Required | Notes |
|----------|----------|-------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service-role key — never expose to frontend |
| `PHONE_HASH_SALT` | Yes | Secret salt for SHA-256 phone hashing |
| `FLOWDESK_ALLOWED_ORIGINS` | No | Comma-separated allowed CORS origins |

These variables must be set in Netlify before any function will respond successfully. They are not committed to the repo.

---

## Phase 1A Deployment Verification (2026-05-26)

Netlify draft deploy completed. All Phase 1A endpoints tested and passed.

| Test | Result |
|------|--------|
| Health endpoint | PASSED |
| Caller lookup (not found) | PASSED |
| Caller upsert (first call) | PASSED |
| Repeat caller lookup (found) | PASSED |
| Second caller upsert — `call_count` incremented to 2 | PASSED |
| Session start | PASSED |
| Lead create | PASSED |
| Supabase dashboard-safe view verification | PASSED |

---

## Phase 1A-S — Source Standardization (2026-05-26)

**Change:** `flowdesk-lead-create.js` inserted source value updated from `conversational-agent` to `conversational_ai_agent_demo` to match the database column default and dashboard reporting convention.

**File modified:** `netlify/functions/flowdesk-lead-create.js` (line 61)

No other files were modified. Response shape is unchanged except `lead.source` now returns `conversational_ai_agent_demo`.

**Phase 1B was not started.**

---

## Next Phase

**Phase 1B** will add Twilio voice flow integration:
- Twilio webhook handler (`/flowdesk-twilio-voice`)
- TwiML `<Gather>` flow for caller interaction
- Integration with `flowdesk-caller-lookup` and `flowdesk-caller-upsert`
- Call session lifecycle management

Phase 1B should not begin until Phase 1A functions are deployed and all checklist items in `phase1a-test-checklist.md` are verified green.
