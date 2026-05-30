'use strict';

// Sandbox voice entry point — Twilio calls this when a call arrives on the sandbox number.
// Security: blocks the protected Lead Manager number (+17253305102) and validates allowed-to list.
// Profile-driven greeting via FLOWDESK_AGENT_PROFILE env var.

const {
  parseFormBody,
  escapeXml,
  xml,
  buildAbsoluteFunctionUrl,
  normalizeTwilioNumber,
  isAllowedToNumber,
} = require('./lib/flowdesk-twilio-utils');

const { getProfile, getProfileKey } = require('./lib/sandbox-profiles');

const PROTECTED_NUMBERS = ['+17253305102'];

function sandboxGreetTwiml(message, gatherAction, timeoutUrl, voice) {
  const safeMsg = escapeXml(message);
  const safeGather = escapeXml(gatherAction);
  const safeTimeout = escapeXml(timeoutUrl);
  const safeVoice = escapeXml(voice || 'Polly.Matthew-Neural');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${safeVoice}">${safeMsg}</Say>
  <Gather input="speech" action="${safeGather}" method="POST"
          speechTimeout="auto" actionOnEmptyResult="true"
          speechModel="phone_call" enhanced="true" language="en-US">
  </Gather>
  <Redirect method="POST">${safeTimeout}</Redirect>
</Response>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return xml(405, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Method not allowed.</Say><Hangup/></Response>');
  }

  const body = parseFormBody(event);
  const { To, From, CallSid } = body;

  // Block protected Lead Manager number — never route through sandbox
  const normalizedTo = normalizeTwilioNumber(To) || To || '';
  if (PROTECTED_NUMBERS.includes(normalizedTo)) {
    console.error(`SANDBOX BLOCKED: call to protected number ${normalizedTo}`);
    return xml(403, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not available.</Say><Hangup/></Response>');
  }

  // Optional allowed-to list check
  const allowedEnv = process.env.FLOWDESK_SANDBOX_ALLOWED_TO_NUMBERS;
  if (allowedEnv && !isAllowedToNumber(To, allowedEnv)) {
    console.error(`SANDBOX BLOCKED: To number not in allowed list: ${normalizedTo}`);
    return xml(403, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured for sandbox testing.</Say><Hangup/></Response>');
  }

  const profileKey = getProfileKey();
  const profile = getProfile(profileKey);
  const callSid = CallSid || '';
  const normalizedFrom = normalizeTwilioNumber(From) || From || '';

  console.log(`SANDBOX CALL: call_sid=${callSid} from=${normalizedFrom ? '***' + normalizedFrom.slice(-4) : 'unknown'} profile=${profileKey}`);

  // Log session start to Supabase (non-fatal)
  try {
    const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
    const supabase = getSupabaseAdmin();
    await supabase.from('sandbox_call_sessions').insert({
      call_sid: callSid,
      profile_key: profileKey,
      profile_label: profile.label,
      model: process.env.FLOWDESK_OPENAI_REALTIME_MODEL || 'gpt-4o-mini',
      temperature: parseFloat(process.env.FLOWDESK_AGENT_TEMPERATURE || '0.4'),
      status: 'active',
      started_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('SANDBOX SESSION LOG FAILED:', e.message);
  }

  const gatherAction = buildAbsoluteFunctionUrl(event, 'sandbox-agent-gather', {
    call_sid: callSid,
    turn: 1,
    profile: profileKey,
  });
  const timeoutUrl = buildAbsoluteFunctionUrl(event, 'sandbox-voice-webhook', {
    timeout: 'true',
    call_sid: callSid,
  });

  return xml(200, sandboxGreetTwiml(profile.greeting, gatherAction, timeoutUrl, profile.voice));
};
