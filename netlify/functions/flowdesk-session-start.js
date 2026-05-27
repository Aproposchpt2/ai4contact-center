'use strict';

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json, error, parseJsonBody } = require('./lib/flowdesk-response-utils');

exports.handler = async (event) => {
  const origin = event.headers && event.headers.origin;
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(origin);
  if (event.httpMethod !== 'POST') {
    return error(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported', corsHeaders);
  }

  const body = parseJsonBody(event);
  if (!body) {
    return error(400, 'INVALID_BODY', 'Request body must be valid JSON', corsHeaders);
  }

  const { caller_id, twilio_call_sid, status } = body;

  if (!caller_id) {
    return error(400, 'MISSING_CALLER_ID', 'caller_id is required', corsHeaders);
  }

  const supabase = getSupabaseAdmin();
  const { data, error: dbErr } = await supabase
    .from('flowdesk_call_sessions')
    .insert({
      caller_id,
      twilio_call_sid: twilio_call_sid || null,
      status: status || 'in_progress',
      started_at: new Date().toISOString(),
    })
    .select('id, caller_id, twilio_call_sid, status, started_at, created_at')
    .single();

  if (dbErr) {
    return error(500, 'DB_ERROR', 'Session creation failed', corsHeaders);
  }

  return json(201, { ok: true, session: data }, corsHeaders);
};
