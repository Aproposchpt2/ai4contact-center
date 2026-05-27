'use strict';

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json, error } = require('./lib/flowdesk-response-utils');

exports.handler = async (event) => {
  const origin = event.headers && event.headers.origin;
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(origin);
  if (event.httpMethod !== 'GET') {
    return error(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported', corsHeaders);
  }

  const checks = {
    supabaseUrl: Boolean(process.env.SUPABASE_URL),
    supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    phoneHashSalt: Boolean(process.env.PHONE_HASH_SALT),
    supabaseConnection: false,
  };

  try {
    const supabase = getSupabaseAdmin();
    const { error: dbErr } = await supabase
      .from('flowdesk_dashboard_leads')
      .select('id')
      .limit(1);
    checks.supabaseConnection = !dbErr;
  } catch {
    checks.supabaseConnection = false;
  }

  const allPassed = Object.values(checks).every(Boolean);

  return json(allPassed ? 200 : 503, {
    ok: allPassed,
    service: 'flowdesk-conversational-agent',
    checks,
  }, corsHeaders);
};
