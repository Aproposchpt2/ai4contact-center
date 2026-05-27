'use strict';

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { normalizePhone, hashPhone } = require('./lib/flowdesk-phone-utils');
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

  const { phone } = body;
  if (!phone) {
    return error(400, 'MISSING_PHONE', 'phone is required', corsHeaders);
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    return error(400, 'INVALID_PHONE', 'Phone number could not be normalized', corsHeaders);
  }

  let phoneHash;
  try {
    phoneHash = hashPhone(phone);
  } catch (e) {
    return error(500, 'HASH_ERROR', 'Phone hashing failed', corsHeaders);
  }

  const supabase = getSupabaseAdmin();
  const { data, error: dbErr } = await supabase
    .from('flowdesk_callers')
    .select(
      'id, phone_last4, display_name, first_name, last_name, business_name, call_count, last_intent_summary, last_call_topic, first_seen_at, last_seen_at'
    )
    .eq('phone_hash', phoneHash)
    .maybeSingle();

  if (dbErr) {
    return error(500, 'DB_ERROR', 'Caller lookup failed', corsHeaders);
  }

  if (!data) {
    return json(200, { ok: true, found: false, caller: null }, corsHeaders);
  }

  return json(200, { ok: true, found: true, caller: data }, corsHeaders);
};
