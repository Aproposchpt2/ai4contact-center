'use strict';

const {
  parseFormBody,
  validateTwilioSignature,
} = require('./lib/flowdesk-twilio-utils');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');

// Map Twilio CallStatus values to the session status CHECK constraint values
const TWILIO_STATUS_MAP = {
  completed: 'completed',
  failed: 'failed',
  'no-answer': 'no_answer',
  busy: 'busy',
  canceled: 'canceled',
};

exports.handler = async (event) => {
  const safeOk = {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false }),
    };
  }

  const body = parseFormBody(event);

  if (!validateTwilioSignature(event, body)) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false }),
    };
  }

  const { CallSid, CallStatus, CallDuration } = body;

  if (!CallSid) return safeOk;

  const mappedStatus = TWILIO_STATUS_MAP[CallStatus] || null;
  if (!mappedStatus) return safeOk;

  try {
    const supabase = getSupabaseAdmin();

    const updateFields = {
      status: mappedStatus,
      ended_at: new Date().toISOString(),
    };

    if (CallDuration) {
      const dur = parseInt(CallDuration, 10);
      if (!isNaN(dur)) updateFields.duration_sec = dur;
    }

    // Best-effort update — do not fail if session is not found
    await supabase
      .from('flowdesk_call_sessions')
      .update(updateFields)
      .eq('twilio_call_sid', CallSid);
  } catch {
    // Status callbacks are best-effort; never surface errors to Twilio
  }

  return safeOk;
};
