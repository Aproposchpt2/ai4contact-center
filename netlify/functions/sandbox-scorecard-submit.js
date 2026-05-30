'use strict';

// Sandbox scorecard submission endpoint.
// Called from a browser/curl after a test call to log quality ratings.
// POST { call_sid, profile_key, tester_name, scores:{...}, notes, scenario }

const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(statusCode, payload) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(payload) };
}

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

// Score dimensions (each 1–10)
const SCORE_KEYS = [
  'greeting_quality',
  'naturalness',
  'question_clarity',
  'information_collection',
  'escalation_handling',
  'closing_quality',
  'overall',
];

function validateScores(scores) {
  if (!scores || typeof scores !== 'object') return null;
  const result = {};
  for (const key of SCORE_KEYS) {
    const val = scores[key];
    if (val === undefined || val === null) continue;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 1 || n > 10) return null;
    result[key] = Math.round(n * 10) / 10;
  }
  return result;
}

function computeAggregate(scores) {
  const vals = SCORE_KEYS.map((k) => scores[k]).filter((v) => v !== undefined && v !== null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

// Test scenarios for reference — returned in GET /sandbox-scorecard-submit?scenarios=1
const TEST_SCENARIOS = [
  { id: 'new_lead', label: 'New lead intro', description: 'Caller provides name and basic service inquiry' },
  { id: 'repeat_caller', label: 'Repeat caller', description: 'Caller who has called before returns with follow-up' },
  { id: 'escalation', label: 'Escalation request', description: 'Caller asks to speak to a human mid-conversation' },
  { id: 'minimal_info', label: 'Minimal responder', description: 'Caller gives only yes/no or very short answers' },
  { id: 'complex_issue', label: 'Complex issue', description: 'Multi-part request requiring multiple clarifying questions' },
  { id: 'non_english', label: 'Non-native speaker', description: 'Caller with accent or unusual phrasing' },
  { id: 'silence_recovery', label: 'Silence recovery', description: 'Caller pauses or says nothing — agent must re-prompt gracefully' },
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // GET with ?scenarios=1 returns the test scenario list
  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (qs.scenarios) return json(200, { scenarios: TEST_SCENARIOS });
    return json(200, { score_keys: SCORE_KEYS, scenarios: TEST_SCENARIOS });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { success: false, error: 'Invalid JSON' });
  }

  const callSid    = clean(body.call_sid, 64);
  const profileKey = clean(body.profile_key, 40);
  const testerName = clean(body.tester_name, 80);
  const scenario   = clean(body.scenario, 60);
  const notes      = clean(body.notes, 1000);

  if (!callSid) return json(400, { success: false, error: 'call_sid is required' });

  const scores = validateScores(body.scores);
  if (!scores || Object.keys(scores).length === 0) {
    return json(400, { success: false, error: `scores must be an object with keys from: ${SCORE_KEYS.join(', ')} (each 1–10)` });
  }

  const aggregateScore = computeAggregate(scores);
  const corporateReady = aggregateScore !== null && aggregateScore >= 8.0;

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (e) {
    return json(500, { success: false, error: 'Service configuration error' });
  }

  // Fetch call session for context
  let sessionData = null;
  try {
    const { data } = await supabase
      .from('sandbox_call_sessions')
      .select('profile_key, profile_label, model, temperature, turn_count, lead_data, ai_metadata')
      .eq('call_sid', callSid)
      .maybeSingle();
    sessionData = data;
  } catch (e) {
    console.warn('SCORECARD SESSION LOOKUP FAILED:', e.message);
  }

  const { error: insertError } = await supabase.from('sandbox_scorecard_logs').insert({
    call_sid:        callSid,
    profile_key:     profileKey || sessionData?.profile_key || 'unknown',
    profile_label:   sessionData?.profile_label || null,
    model:           sessionData?.model || process.env.FLOWDESK_OPENAI_REALTIME_MODEL || 'gpt-4o-mini',
    temperature:     sessionData?.temperature || null,
    tester_name:     testerName || null,
    scenario:        scenario || null,
    scores:          scores,
    aggregate_score: aggregateScore,
    corporate_ready: corporateReady,
    notes:           notes || null,
    turn_count:      sessionData?.turn_count || null,
    ai_metadata:     sessionData?.ai_metadata || null,
    submitted_at:    new Date().toISOString(),
  });

  if (insertError) {
    console.error('SCORECARD INSERT ERROR:', insertError.message);
    return json(500, { success: false, error: 'Failed to save scorecard' });
  }

  console.log(`SCORECARD: call_sid=${callSid} aggregate=${aggregateScore} corporate_ready=${corporateReady} profile=${profileKey}`);

  return json(200, {
    success: true,
    aggregate_score: aggregateScore,
    corporate_ready: corporateReady,
    scores,
    message: corporateReady
      ? 'This agent configuration meets the 8/10 corporate-readiness threshold.'
      : `Score ${aggregateScore}/10 — below the 8.0 corporate-readiness threshold. Review notes and adjust profile or model.`,
  });
};
