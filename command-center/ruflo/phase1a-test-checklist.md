# Phase 1A Test Checklist
**Project:** FlowDesk Pro Conversational AI Agent
**Phase:** 1A â€” Netlify Functions Backend Foundation
**Date:** 2026-05-26

---

## Pre-Deploy Checks

### Phase 1A-Config Files (added 2026-05-26)
- [ ] `package.json` exists at repo root
- [ ] `package.json` includes `@supabase/supabase-js` in `dependencies`
- [ ] `package.json` includes `ws` in `dependencies`
- [ ] `package.json` `engines.node` is `>=22.0.0`
- [ ] `netlify.toml` exists at repo root
- [ ] `netlify.toml` `[functions] directory` is `netlify/functions`
- [ ] `netlify.toml` `NODE_VERSION` is `"22"`
- [ ] `npm install` (or Netlify CI build) completes without errors

### Local File Existence
- [ ] `netlify/functions/lib/flowdesk-cors.js`
- [ ] `netlify/functions/lib/flowdesk-supabase-admin.js`
- [ ] `netlify/functions/lib/flowdesk-phone-utils.js`
- [ ] `netlify/functions/lib/flowdesk-response-utils.js`
- [ ] `netlify/functions/flowdesk-agent-health.js`
- [ ] `netlify/functions/flowdesk-caller-lookup.js`
- [ ] `netlify/functions/flowdesk-caller-upsert.js`
- [ ] `netlify/functions/flowdesk-session-start.js`
- [ ] `netlify/functions/flowdesk-lead-create.js`

### Netlify Deploy Check
- [ ] `netlify deploy --build` succeeds with no errors
- [ ] All 5 functions appear in Netlify dashboard under Functions tab
- [ ] No build warnings about missing modules

### Environment Variable Check (Netlify Dashboard â†’ Site Settings â†’ Environment Variables)
- [ ] `SUPABASE_URL` is set
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set
- [ ] `PHONE_HASH_SALT` is set
- [ ] `FLOWDESK_ALLOWED_ORIGINS` is set (optional â€” set to your frontend domain if needed)

---

## Function Tests

Replace `YOUR_NETLIFY_URL` with your deployed site URL or `http://localhost:8888` for local dev via `netlify dev`.

### Health Endpoint

```bash
curl -s -X GET "YOUR_NETLIFY_URL/.netlify/functions/flowdesk-agent-health" | jq .
```

Expected response:
```json
{
  "ok": true,
  "service": "flowdesk-conversational-agent",
  "checks": {
    "supabaseUrl": true,
    "supabaseServiceRoleKey": true,
    "phoneHashSalt": true,
    "supabaseConnection": true
  }
}
```

- [x] `ok` is `true`
- [x] All 4 checks are `true`
- [x] No env var values are exposed in the response

---

### Caller Lookup â€” Not Found

```bash
curl -s -X POST "YOUR_NETLIFY_URL/.netlify/functions/flowdesk-caller-lookup" \
  -H "Content-Type: application/json" \
  -d '{"phone": "+17025550000"}' | jq .
```

Expected:
```json
{
  "ok": true,
  "found": false,
  "caller": null
}
```

- [x] `ok` is `true`
- [x] `found` is `false`
- [x] `phone_hash` is NOT present in response
- [x] `callback_phone` is NOT present in response

---

### Caller Upsert â€” First Call (New Caller)

```bash
curl -s -X POST "YOUR_NETLIFY_URL/.netlify/functions/flowdesk-caller-upsert" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+17025551212",
    "first_name": "Jeffrey",
    "last_name": "Mitchell",
    "display_name": "Mr. Mitchell",
    "business_name": "Apropos Group LLC",
    "last_intent_summary": "Asked about the AI Contact Center demo",
    "last_call_topic": "AI Contact Center demo"
  }' | jq .
```

Expected:
```json
{
  "ok": true,
  "caller": {
    "id": "<uuid>",
    "phone_last4": "1212",
    "display_name": "Mr. Mitchell",
    "first_name": "Jeffrey",
    "last_name": "Mitchell",
    "business_name": "Apropos Group LLC",
    "call_count": 1,
    "last_intent_summary": "Asked about the AI Contact Center demo",
    "last_call_topic": "AI Contact Center demo",
    "first_seen_at": "<timestamp>",
    "last_seen_at": "<timestamp>"
  }
}
```

- [x] `ok` is `true`
- [x] `call_count` is `1`
- [x] `phone_last4` is `”1212”`
- [x] `phone_hash` is NOT present in response
- [x] Supabase row exists in `flowdesk_callers` — verify in dashboard

---

### Caller Upsert â€” Repeat Call (Existing Caller)

Run the same command a second time. Expected changes:

- [x] `call_count` increments to `2`
- [x] `last_seen_at` is updated
- [x] `phone_hash` is NOT present in response
- [x] Only one row exists in `flowdesk_callers` for this phone (no duplicate)

---

### Caller Lookup â€” Found (after upsert)

```bash
curl -s -X POST "YOUR_NETLIFY_URL/.netlify/functions/flowdesk-caller-lookup" \
  -H "Content-Type: application/json" \
  -d '{"phone": "+17025551212"}' | jq .
```

Expected:
```json
{
  "ok": true,
  "found": true,
  "caller": {
    "id": "<same uuid>",
    "phone_last4": "1212",
    ...
  }
}
```

- [x] `found` is `true`
- [x] `id` matches the upserted caller
- [x] `phone_hash` is NOT present in response

---

### Session Start

Copy the `caller.id` from the upsert response.

```bash
curl -s -X POST "YOUR_NETLIFY_URL/.netlify/functions/flowdesk-session-start" \
  -H "Content-Type: application/json" \
  -d '{
    "caller_id": "<caller_id_from_upsert>",
    "twilio_call_sid": "CA00000000000000000000000000000001",
    "status": "in_progress"
  }' | jq .
```

Expected:
```json
{
  "ok": true,
  "session": {
    "id": "<uuid>",
    "caller_id": "<caller_id>",
    "twilio_call_sid": "CA00000000000000000000000000000001",
    "status": "in_progress",
    "started_at": "<timestamp>",
    "created_at": "<timestamp>"
  }
}
```

- [x] `ok` is `true`
- [x] `raw_transcript` is NOT present in response
- [x] `ai_metadata` is NOT present in response
- [x] Row exists in `flowdesk_call_sessions` in Supabase

---

### Lead Create

Copy both `caller.id` and `session.id` from previous steps.

```bash
curl -s -X POST "YOUR_NETLIFY_URL/.netlify/functions/flowdesk-lead-create" \
  -H "Content-Type: application/json" \
  -d '{
    "caller_id": "<caller_id>",
    "session_id": "<session_id>",
    "business_name": "Apropos Group LLC",
    "contact_name": "Jeffrey Mitchell",
    "callback_phone": "+17025551212",
    "interest_area": "AI Voice Attendant",
    "priority": "normal",
    "lead_status": "new"
  }' | jq .
```

Expected:
```json
{
  "ok": true,
  "lead": {
    "id": "<uuid>",
    "caller_id": "<caller_id>",
    "session_id": "<session_id>",
    "business_name": "Apropos Group LLC",
    "contact_name": "Jeffrey Mitchell",
    "callback_phone_last4": "1212",
    "interest_area": "AI Voice Attendant",
    "priority": "normal",
    "lead_status": "new",
    "source": "conversational_ai_agent_demo",
    "created_at": "<timestamp>"
  }
}
```

- [x] `ok` is `true`
- [x] `callback_phone` is NOT present in response (only `callback_phone_last4`)
- [x] `source` is `"conversational_ai_agent_demo"`
- [x] Row exists in `flowdesk_leads` in Supabase

---

## Supabase Row Verification

Open Supabase dashboard â†’ Table Editor for `flowdesk-pro`:

- [x] `flowdesk_callers`: 1 row for test phone (+1 7025551212)
- [x] `flowdesk_callers`: `phone_hash` column has a value (internal only)
- [x] `flowdesk_call_sessions`: 1 row linked to caller
- [x] `flowdesk_leads`: 1 row linked to caller and session
- [x] `flowdesk_leads`: `callback_phone` column stores full phone (server-side only)
- [x] `flowdesk_leads`: `callback_phone_last4` is `"1212"`
- [x] No rows modified in any non-Phase-0 table

---

## Security Checks

- [ ] `phone_hash` is NOT returned in any function response
- [ ] `callback_phone` is NOT returned in `flowdesk-lead-create` response
- [ ] `SUPABASE_URL` value is NOT visible in any response
- [ ] `SUPABASE_SERVICE_ROLE_KEY` value is NOT visible in any response
- [ ] `PHONE_HASH_SALT` value is NOT visible in any response
- [ ] No stack traces exposed in error responses
- [ ] OPTIONS preflight returns 204 with CORS headers for each function
- [ ] Invalid method returns 405 error
- [ ] Invalid JSON body returns 400 error

---

## Phase Boundary Confirmation

- [x] No Twilio voice webhook files were created
- [x] No TwiML or voice flow logic was created
- [x] No AI conversation logic was created
- [x] No frontend HTML/CSS/JS files were created
- [x] No dashboard files were created
- [x] No existing FlowDesk Pro production demo files were modified
- [x] No Supabase schema migrations were added
- [x] No Stripe integration files were created
