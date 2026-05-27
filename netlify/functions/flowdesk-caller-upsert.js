'use strict';

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { normalizePhone, getPhoneLast4, hashPhone } = require('./lib/flowdesk-phone-utils');
const { json, error, parseJsonBody } = require('./lib/flowdesk-response-utils');

const SAFE_CALLER_FIELDS =
  'id, phone_last4, display_name, first_name, last_name, business_name, call_count, last_intent_summary, last_call_topic, first_seen_at, last_seen_at';

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

  const { phone, first_name, last_name, display_name, business_name, last_intent_summary, last_call_topic } = body;

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
  } catch {
    return error(500, 'HASH_ERROR', 'Phone hashing failed', corsHeaders);
  }

  const phoneLast4 = getPhoneLast4(phone);
  const supabase = getSupabaseAdmin();

  const { data: existing, error: lookupErr } = await supabase
    .from('flowdesk_callers')
    .select(SAFE_CALLER_FIELDS + ', call_count')
    .eq('phone_hash', phoneHash)
    .maybeSingle();

  if (lookupErr) {
    return error(500, 'DB_ERROR', 'Caller lookup failed', corsHeaders);
  }

  const updateFields = {};
  if (first_name !== undefined) updateFields.first_name = first_name;
  if (last_name !== undefined) updateFields.last_name = last_name;
  if (display_name !== undefined) updateFields.display_name = display_name;
  if (business_name !== undefined) updateFields.business_name = business_name;
  if (last_intent_summary !== undefined) updateFields.last_intent_summary = last_intent_summary;
  if (last_call_topic !== undefined) updateFields.last_call_topic = last_call_topic;

  let savedCaller;

  if (existing) {
    const { data: updated, error: updateErr } = await supabase
      .from('flowdesk_callers')
      .update({
        ...updateFields,
        call_count: (existing.call_count || 0) + 1,
        last_seen_at: new Date().toISOString(),
      })
      .eq('phone_hash', phoneHash)
      .select(SAFE_CALLER_FIELDS)
      .single();

    if (updateErr) {
      return error(500, 'DB_ERROR', 'Caller update failed', corsHeaders);
    }
    savedCaller = updated;
  } else {
    const { data: inserted, error: insertErr } = await supabase
      .from('flowdesk_callers')
      .insert({
        phone_hash: phoneHash,
        phone_last4: phoneLast4,
        call_count: 1,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        ...updateFields,
      })
      .select(SAFE_CALLER_FIELDS)
      .single();

    if (insertErr) {
      return error(500, 'DB_ERROR', 'Caller insert failed', corsHeaders);
    }
    savedCaller = inserted;
  }

  return json(200, { ok: true, caller: savedCaller }, corsHeaders);
};
