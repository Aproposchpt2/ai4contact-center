'use strict';

const {
  parseFormBody,
  xml,
  buildSayHangupTwiml,
  normalizeTwilioNumber,
  validateTwilioSignature,
} = require('./lib/flowdesk-twilio-utils');
const { createLeadFromSpeech } = require('./lib/flowdesk-agent-records');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return xml(
      405,
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Method not allowed.</Say><Hangup/></Response>'
    );
  }

  const body = parseFormBody(event);

  if (!validateTwilioSignature(event, body)) {
    return xml(
      403,
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized.</Say><Hangup/></Response>'
    );
  }

  const { SpeechResult, From } = body;

  // caller_id and session_id are passed as query params from the voice webhook gather action
  const qs = event.queryStringParameters || {};
  const callerId = qs.caller_id || null;
  const sessionId = qs.session_id || null;

  if (!SpeechResult || !SpeechResult.trim()) {
    return xml(
      200,
      buildSayHangupTwiml(
        'We did not capture your response. Please call again and briefly describe your request. Goodbye.'
      )
    );
  }

  const normalizedFrom = normalizeTwilioNumber(From) || From;

  try {
    await createLeadFromSpeech({
      callerId: callerId || null,
      sessionId: sessionId || null,
      from: normalizedFrom,
      speechResult: SpeechResult.trim(),
    });
  } catch {
    // Non-fatal: still confirm to the caller
  }

  return xml(
    200,
    buildSayHangupTwiml(
      'Thank you. I captured your request. A member of our team will review it and follow up. Goodbye.'
    )
  );
};
