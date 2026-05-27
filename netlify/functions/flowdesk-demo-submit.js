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

  const { business_name, contact_name, phone, email } = body;

  if (!phone) {
    return error(400, 'MISSING_PHONE', 'phone is required', corsHeaders);
  }

  const supabase = getSupabaseAdmin();
  const { data, error: dbErr } = await supabase
    .from('demo_requests')
    .insert({
      business_name: business_name || null,
      contact_name: contact_name || null,
      phone,
      email: email || null,
      created_at: new Date().toISOString(),
    })
    .select('id, business_name, contact_name, phone, email, created_at')
    .single();

  if (dbErr) {
    console.error('DEMO SUBMIT DB ERROR:', dbErr.message);
    return error(500, 'DB_ERROR', 'Failed to save demo request', corsHeaders);
  }

  return json(201, { ok: true, demo: data }, corsHeaders);
};
