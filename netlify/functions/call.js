'use strict';

const {
  parseFormBody,
  xml,
  buildAbsoluteFunctionUrl,
  escapeXml,
  buildSayHangupTwiml,
  normalizeTwilioNumber,
  isAllowedToNumber,
  validateTwilioSignature,
} = require('./lib/flowdesk-twilio-utils');
const { upsertCallerFromTwilio, startOrReuseSession } = require('./lib/flowdesk-agent-records');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');

function ariaTwiml(message, gatherAction, timeoutUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(message)}</Say>
  <Gather input="speech" action="${escapeXml(gatherAction)}" method="POST"
          speechTimeout="3" speechModel="phone_call" enhanced="true" language="en-US">
  </Gather>
  <Redirect method="POST">${escapeXml(timeoutUrl)}</Redirect>
</Response>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return xml(405, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Method not allowed.</Say><Hangup/></Response>');
  }

  const body = parseFormBody(event);
  const qs = event.queryStringParameters || {};

  // Timeout retry path — Twilio redirects here when no speech captured
  if (qs.timeout === 'true') {
    const timeoutCount = parseInt(qs.timeout_count || '1', 10);
    const callSid = qs.call_sid || body.CallSid || '';
    if (timeoutCount >= 2) {
      return xml(200, `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">I'm sorry I wasn't able to assist you today. Please call back when you're ready. Goodbye.</Say><Hangup/></Response>`);
    }
    const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', { turn: 1, call_sid: callSid });
    const nextTimeout = buildAbsoluteFunctionUrl(event, 'call', { timeout: 'true', timeout_count: timeoutCount + 1, call_sid: callSid });
    return xml(200, ariaTwiml("I'm sorry, I didn't catch that. How can I help you today?", gatherAction, nextTimeout));
  }

  if (!validateTwilioSignature(event, body)) {
    return xml(403, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized.</Say><Hangup/></Response>');
  }

  const { From, To, CallSid } = body;

  const allowedNumbers = process.env.FLOWDESK_TWILIO_ALLOWED_TO_NUMBERS;
  if (allowedNumbers && !isAllowedToNumber(To, allowedNumbers)) {
    return xml(403, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured for this service.</Say><Hangup/></Response>');
  }

  const normalizedFrom = normalizeTwilioNumber(From);
  if (!normalizedFrom) {
    return xml(400, buildSayHangupTwiml('We could not identify your phone number. Please try again.'));
  }

  let caller = null;
  let isRepeat = false;
  let session = null;

  try {
    const result = await upsertCallerFromTwilio({ from: normalizedFrom });
    caller = result.caller;
    isRepeat = result.isRepeat;
  } catch {
    // New caller experience on error
  }

  try {
    const result = await startOrReuseSession({
      callerId: caller ? caller.id : null,
      callSid: CallSid || null,
      status: 'in_progress',
    });
    session = result.session;
  } catch {
    // Proceed without session
  }

  const centerName = process.env.FLOWDESK_CONTACT_CENTER_NAME || 'FlowDesk Pro Contact Center';

  let greeting;
  if (isRepeat && caller && caller.display_name) {
    const lastTopic = caller.last_call_topic || caller.last_intent_summary || 'a previous matter';
    greeting = `Welcome back ${caller.display_name}! It's great to hear from you again. Last time you called you were asking about ${lastTopic}. How can I help you today?`;
  } else {
    greeting = `Thank you for calling ${centerName}. I'm Aria. How can I help you today?`;
  }

  // Initialize conversation history
  try {
    const supabase = getSupabaseAdmin();
    await supabase
      .from('conversation_history')
      .upsert({
        call_sid: CallSid,
        caller_number: normalizedFrom,
        caller_id: caller ? caller.id : null,
        session_id: session ? session.id : null,
        history: [{ role: 'assistant', content: greeting }],
        turn_count: 1,
        is_complete: false,
      }, { onConflict: 'call_sid' });
  } catch (e) {
    console.error('CONV INIT ERROR:', e.message);
  }

  const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', {
    turn: 1,
    call_sid: CallSid || '',
  });
  const timeoutUrl = buildAbsoluteFunctionUrl(event, 'call', {
    timeout: 'true',
    call_sid: CallSid || '',
  });

  return xml(200, ariaTwiml(greeting, gatherAction, timeoutUrl));
};
