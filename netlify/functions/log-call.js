'use strict';

// POST /.netlify/functions/log-call
// Called by ElevenLabs voice agent Alex after each conversation.
// Inserts a row into call_logs with caller_phone and optional metadata.
//
// Body (JSON): { caller_phone, call_sid?, called_number?, call_status?, duration_seconds?, outcome?, is_demo? }
// Optional auth: set ELEVENLABS_SECRET env var; caller must send matching X-Agent-Secret header.

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json, error, parseJsonBody } = require('./lib/flowdesk-response-utils');

function clean(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : null;
}

exports.handler = async (event) => {
  const origin = event.headers && event.headers.origin;
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(origin);
  if (event.httpMethod !== 'POST') {
    return error(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported', corsHeaders);
  }

  // Optional shared-secret check for ElevenLabs agent calls
  const secret = process.env.ELEVENLABS_SECRET;
  if (secret) {
    const provided = event.headers['x-agent-secret'] || event.headers['X-Agent-Secret'] || '';
    if (provided !== secret) {
      return error(401, 'UNAUTHORIZED', 'Invalid or missing agent secret', corsHeaders);
    }
  }

  const body = parseJsonBody(event);
  if (!body) {
    return error(400, 'INVALID_BODY', 'Request body must be valid JSON', corsHeaders);
  }

  const callerPhone = clean(body.caller_phone, 30);
  if (!callerPhone) {
    return error(400, 'MISSING_CALLER_PHONE', 'caller_phone is required', corsHeaders);
  }

  const callSid         = clean(body.call_sid, 64)      || null;
  const calledNumber    = clean(body.called_number, 30)  || null;
  const callStatus      = clean(body.call_status, 40)    || 'completed';
  const outcome         = clean(body.outcome, 80)        || null;
  const durationSeconds = Number.isFinite(Number(body.duration_seconds)) ? Math.round(Number(body.duration_seconds)) : null;
  const isDemo          = body.is_demo === true || body.is_demo === 'true';

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (e) {
    return error(500, 'CONFIG_ERROR', 'Service configuration error', corsHeaders);
  }

  const { data, error: dbErr } = await supabase
    .from('call_logs')
    .insert({
      caller_phone:     callerPhone,
      call_sid:         callSid,
      called_number:    calledNumber,
      call_status:      callStatus,
      duration_seconds: durationSeconds,
      outcome:          outcome,
      is_demo:          isDemo,
      lead_created:     false,
      created_at:       new Date().toISOString(),
    })
    .select('id, caller_phone, call_status, created_at')
    .single();

  if (dbErr) {
    console.error('LOG-CALL DB ERROR:', dbErr.message);
    return error(500, 'DB_ERROR', 'Failed to log call', corsHeaders);
  }

  console.log(`LOG-CALL: id=${data.id} phone=***${callerPhone.slice(-4)} status=${callStatus}`);
  return json(201, { ok: true, log: data }, corsHeaders);
};
