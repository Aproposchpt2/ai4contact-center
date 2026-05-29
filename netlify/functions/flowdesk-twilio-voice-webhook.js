'use strict';

const {
  parseFormBody,
  xml,
  buildAbsoluteFunctionUrl,
  buildGatherTwiml,
  buildSayHangupTwiml,
  normalizeTwilioNumber,
  isAllowedToNumber,
  validateTwilioSignature,
} = require('./lib/flowdesk-twilio-utils');
const {
  upsertCallerFromTwilio,
  startOrReuseSession,
} = require('./lib/flowdesk-agent-records');

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

  const { From, To, CallSid } = body;

  // Confirm call is for the dedicated Contact Center number when configured
  const allowedNumbers = process.env.FLOWDESK_TWILIO_ALLOWED_TO_NUMBERS;
  if (allowedNumbers && !isAllowedToNumber(To, allowedNumbers)) {
    return xml(
      403,
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured for this service.</Say><Hangup/></Response>'
    );
  }

  const normalizedFrom = normalizeTwilioNumber(From);
  if (!normalizedFrom) {
    return xml(
      400,
      buildSayHangupTwiml(
        'We could not identify your phone number. Please try again.'
      )
    );
  }

  let caller = null;
  let isRepeat = false;
  let session = null;

  try {
    const result = await upsertCallerFromTwilio({ from: normalizedFrom });
    caller = result.caller;
    isRepeat = result.isRepeat;
  } catch {
    // Proceed with new-caller experience if upsert fails
  }

  try {
    const result = await startOrReuseSession({
      callerId: caller ? caller.id : null,
      callSid: CallSid || null,
      status: 'in_progress',
    });
    session = result.session;
  } catch {
    // Proceed without session — gather will still work
  }

  const centerName =
    process.env.FLOWDESK_CONTACT_CENTER_NAME || 'FlowDesk Pro Contact Center';

  let greeting;
  if (isRepeat && caller && caller.display_name) {
    if (caller.last_call_topic) {
      greeting =
        `Hello ${caller.display_name}, welcome back to ${centerName}. ` +
        `I see your last call was about ${caller.last_call_topic}. ` +
        `Please briefly tell me the reason for your call.`;
    } else {
      greeting =
        `Hello ${caller.display_name}, welcome back to ${centerName}. ` +
        `Please briefly tell me the reason for your call.`;
    }
  } else {
    greeting =
      'Hello, you’ve reached FlowDesk Pro. ' +
      'May I have your first and last name and the reason for your call?';
  }

  const gatherAction = buildAbsoluteFunctionUrl(
    event,
    'flowdesk-twilio-gather',
    {
      caller_id: caller ? caller.id : '',
      session_id: session ? session.id : '',
    }
  );

  return xml(200, buildGatherTwiml(greeting, gatherAction));
};
