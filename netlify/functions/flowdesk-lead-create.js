'use strict';

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { normalizePhone, getPhoneLast4 } = require('./lib/flowdesk-phone-utils');
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

  const {
    caller_id,
    session_id,
    business_name,
    contact_name,
    callback_phone,
    interest_area,
    priority,
    lead_status,
  } = body;

  if (!caller_id) {
    return error(400, 'MISSING_CALLER_ID', 'caller_id is required', corsHeaders);
  }

  let callbackPhoneLast4 = null;
  let normalizedCallback = null;

  if (callback_phone) {
    normalizedCallback = normalizePhone(callback_phone);
    if (!normalizedCallback) {
      return error(400, 'INVALID_CALLBACK_PHONE', 'callback_phone could not be normalized', corsHeaders);
    }
    callbackPhoneLast4 = getPhoneLast4(callback_phone);
  }

  const supabase = getSupabaseAdmin();
  const { data, error: dbErr } = await supabase
    .from('flowdesk_leads')
    .insert({
      caller_id,
      session_id: session_id || null,
      business_name: business_name || null,
      contact_name: contact_name || null,
      callback_phone: normalizedCallback,
      callback_phone_last4: callbackPhoneLast4,
      interest_area: interest_area || null,
      priority: priority || 'normal',
      lead_status: lead_status || 'new',
      source: 'conversational_ai_agent_demo',
    })
    .select('id, caller_id, session_id, business_name, contact_name, callback_phone_last4, interest_area, priority, lead_status, source, created_at')
    .single();

  if (dbErr) {
    return error(500, 'DB_ERROR', 'Lead creation failed', corsHeaders);
  }

  return json(201, { ok: true, lead: data }, corsHeaders);
};
