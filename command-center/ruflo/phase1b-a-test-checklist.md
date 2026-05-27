# Phase 1B-A Test Checklist - Twilio Voice Webhook Foundation

**Project:** FlowDesk Pro Conversational AI Agent / Contact Center
**Phase:** 1B-A
**Date:** 2026-05-26

---

## Pre-Test: File Existence

- [x] `netlify/functions/lib/flowdesk-twilio-utils.js` exists
- [x] `netlify/functions/lib/flowdesk-agent-records.js` exists
- [x] `netlify/functions/flowdesk-twilio-voice-webhook.js` exists
- [x] `netlify/functions/flowdesk-twilio-gather.js` exists
- [x] `netlify/functions/flowdesk-twilio-status.js` exists

---

## Pre-Test: Local Syntax Check

Run from project root:

```bash
node -e "require('./netlify/functions/lib/flowdesk-twilio-utils')"
node -e "require('./netlify/functions/lib/flowdesk-agent-records')"
node -e "require('./netlify/functions/flowdesk-twilio-voice-webhook')"
node -e "require('./netlify/functions/flowdesk-twilio-gather')"
node -e "require('./netlify/functions/flowdesk-twilio-status')"
```

- [x] No require errors on any file

---

## Pre-Test: Environment Variables

Confirm the following are set in the Netlify sandbox environment before draft testing:

- [x] `SUPABASE_URL` set
- [x] `SUPABASE_SERVICE_ROLE_KEY` set
- [x] `PHONE_HASH_SALT` set
- [x] `FLOWDESK_TWILIO_ALLOWED_TO_NUMBERS` set to `+17252010584`
- [x] `FLOWDESK_CONTACT_CENTER_NAME` set to `FlowDesk Pro Contact Center`
- [x] `FLOWDESK_PUBLIC_BASE_URL` set to `https://contact-center.aiflowdeskpro.com` for stable Contact Center action URLs
- [x] `FLOWDESK_TWILIO_VALIDATE_SIGNATURE` set to `false` for manual testing
- [x] `TWILIO_ACCOUNT_SID` set (for future use)
- [x] `TWILIO_AUTH_TOKEN` set (not printed, not logged)

---

## Draft Deploy Check

- [x] `netlify deploy` (without `--prod`) completes with no build errors
- [x] Draft deploy URL is accessible (HTTP 200 on any endpoint) - `https://6a15f3ef8088d8e3081c346e--ai4contact-center.netlify.app`

Replace `<DRAFT_URL>` below with the Netlify draft deploy URL.

---

## Test 1: Simulated Twilio Inbound POST - New Caller

```bash
curl -s -X POST \
  "<DRAFT_URL>/.netlify/functions/flowdesk-twilio-voice-webhook" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B15555550101&To=%2B17252010584&CallSid=CA_TEST_1BA_NEW_001&AccountSid=AC_TEST&CallStatus=ringing"
```

Expected:
- [x] HTTP 200
- [x] Response `Content-Type: text/xml`
- [x] Body contains `<?xml`
- [x] Body contains `<Gather`
- [x] Body contains `Thank you for calling FlowDesk Pro Contact Center`
- [x] Body contains `action=` pointing to `flowdesk-twilio-gather`

---

## Test 2: New Caller Record Created in Supabase

After Test 1:

- [x] Row exists in `flowdesk_callers` for the test phone (`phone_last4` = `0101`)
- [x] `call_count` = 1
- [x] `phone_hash` NOT visible in dashboard view (`flowdesk_dashboard_leads`)
- [x] `callback_phone` NOT visible in dashboard view

---

## Test 3: Session Creation Verified in Supabase

After Test 1:

- [x] Row exists in `flowdesk_call_sessions` with `twilio_call_sid = CA_TEST_1BA_NEW_001`
- [x] `status = in_progress`
- [x] `caller_id` matches the caller row from Test 2

---

## Test 4: Repeat Caller Greeting

Run Test 1 first (new caller), then run this with the same From number:

```bash
curl -s -X POST \
  "<DRAFT_URL>/.netlify/functions/flowdesk-twilio-voice-webhook" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B15555550101&To=%2B17252010584&CallSid=CA_TEST_REPEAT_001&AccountSid=AC_TEST&CallStatus=ringing"
```

Expected:
- [ ] HTTP 200
- [ ] Body contains `welcome back`
- [ ] `call_count` incremented to 2 in `flowdesk_callers`

---

## Test 5: Gather Speech Capture

Requires `caller_id` and `session_id` from earlier test rows.

```bash
curl -s -X POST \
  "<DRAFT_URL>/.netlify/functions/flowdesk-twilio-gather?caller_id=<CALLER_UUID>&session_id=<SESSION_UUID>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "SpeechResult=I%20am%20interested%20in%20the%20AI%20contact%20center%20demo&Confidence=0.92&From=%2B15555550101&To=%2B17252010584&CallSid=CA_TEST_1BA_NEW_001&AccountSid=AC_TEST"
```

Expected:
- [x] HTTP 200
- [x] Response `Content-Type: text/xml`
- [x] Body contains `Thank you. I captured your request`
- [x] Body contains `<Hangup/>`

---

## Test 6: Lead Creation Verified in Supabase

After Test 5:

- [x] Row exists in `flowdesk_leads`
- [x] `source = conversational_ai_agent_demo`
- [x] `interest_area` contains the speech text
- [x] `lead_status = new`
- [x] `priority = normal`
- [x] `callback_phone_last4 = 0101`
- [x] `callback_phone` NOT returned by dashboard view
- [x] `phone_hash` NOT returned by dashboard view

---

## Test 7: Empty SpeechResult Handling

```bash
curl -s -X POST \
  "<DRAFT_URL>/.netlify/functions/flowdesk-twilio-gather" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "SpeechResult=&From=%2B15555550101&To=%2B17252010584&CallSid=CA_TEST_EMPTY_001&AccountSid=AC_TEST"
```

Expected:
- [ ] HTTP 200
- [ ] Body contains `We did not capture your response`
- [ ] No lead row created for this call

---

## Test 8: Status Callback

```bash
curl -s -X POST \
  "<DRAFT_URL>/.netlify/functions/flowdesk-twilio-status" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_TEST_1BA_NEW_001&CallStatus=completed&CallDuration=45&From=%2B15555550101&To=%2B17252010584&AccountSid=AC_TEST"
```

Expected:
- [x] HTTP 200
- [x] Response body: `{"ok":true}`
- [x] `flowdesk_call_sessions` row for `CA_TEST_1BA_NEW_001` updated: `status = completed`, `ended_at` set, `updated_at` changed

---

## Test 9: Status Callback - Unknown CallSid (Graceful)

```bash
curl -s -X POST \
  "<DRAFT_URL>/.netlify/functions/flowdesk-twilio-status" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_DOESNT_EXIST&CallStatus=completed&CallDuration=10&From=%2B15555550000&To=%2B17252010584&AccountSid=AC_TEST"
```

Expected:
- [ ] HTTP 200
- [ ] Response body: `{"ok":true}`
- [ ] No error thrown

---

## Test 10: Disallowed To Number (when FLOWDESK_TWILIO_ALLOWED_TO_NUMBERS is set)

```bash
curl -s -X POST \
  "<DRAFT_URL>/.netlify/functions/flowdesk-twilio-voice-webhook" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B15555550101&To=%2B19999990000&CallSid=CA_TEST_WRONG_TO&AccountSid=AC_TEST&CallStatus=ringing"
```

Expected:
- [ ] HTTP 403
- [ ] Body contains `not configured for this service`

---

## Security Verification

- [x] `phone_hash` does NOT appear in any TwiML response
- [x] `phone_hash` does NOT appear in any JSON response
- [x] `callback_phone` does NOT appear in any TwiML response
- [x] `callback_phone` does NOT appear in any JSON response
- [x] `TWILIO_AUTH_TOKEN` does NOT appear in any response or log output
- [x] `SUPABASE_SERVICE_ROLE_KEY` does NOT appear in any response
- [x] `flowdesk_dashboard_leads` Supabase view: `callback_phone` column absent
- [x] `flowdesk_dashboard_leads` Supabase view: `phone_hash` column absent

---

## Approval Gates (Do Not Proceed Without Explicit Sign-Off)

- [ ] **GATE: Twilio Console Update** - Do not update Contact Center number webhook URL in Twilio console until manual testing above is complete and approved
  - _Status: Not yet updated. All draft tests passed. Awaiting explicit approval to update Twilio console._
- [ ] **GATE: Production Deploy** - Do not run `netlify deploy --prod` until all tests pass and explicit approval is given
  - _Status: Not yet deployed. Phase 1B-A is verified and ready for production cutover decision gate. No cutover has been performed._

---

## Phase 1B-A Closeout - 2026-05-26

All verifiable draft deploy tests PASSED. Protected assets (Lead Manager number, Lead Manager webhook) were not modified. Production deploy was not performed. Twilio console was not updated. Phase 1B-A is complete and ready for the production cutover decision gate.
