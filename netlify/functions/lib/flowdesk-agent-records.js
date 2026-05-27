'use strict';

const { getSupabaseAdmin } = require('./flowdesk-supabase-admin');
const { normalizePhone, getPhoneLast4, hashPhone } = require('./flowdesk-phone-utils');

const SAFE_CALLER_FIELDS =
  'id, phone_last4, display_name, first_name, last_name, business_name, ' +
  'call_count, last_intent_summary, last_call_topic, first_seen_at, last_seen_at';

// Look up a caller by phone without modifying any records
async function lookupCallerByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { caller: null, isRepeat: false };

  const phoneHash = hashPhone(phone);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('flowdesk_callers')
    .select(SAFE_CALLER_FIELDS + ', call_count')
    .eq('phone_hash', phoneHash)
    .maybeSingle();

  if (error) throw new Error('Caller lookup failed: ' + error.message);
  return { caller: data || null, isRepeat: !!data };
}

// Upsert a caller from a Twilio inbound call.
// Increments call_count and updates last_seen_at for existing callers.
// phone_hash is never returned.
async function upsertCallerFromTwilio({ from, intentSummary, topic }) {
  const normalized = normalizePhone(from);
  if (!normalized) throw new Error('Invalid from number');

  const phoneHash = hashPhone(from);
  const phoneLast4 = getPhoneLast4(from);
  const supabase = getSupabaseAdmin();

  const { data: existing, error: lookupErr } = await supabase
    .from('flowdesk_callers')
    .select(SAFE_CALLER_FIELDS + ', call_count')
    .eq('phone_hash', phoneHash)
    .maybeSingle();

  if (lookupErr) throw new Error('Caller lookup failed: ' + lookupErr.message);

  const extraFields = {};
  if (intentSummary !== undefined) extraFields.last_intent_summary = intentSummary;
  if (topic !== undefined) extraFields.last_call_topic = topic;

  if (existing) {
    const { data: updated, error: updateErr } = await supabase
      .from('flowdesk_callers')
      .update({
        ...extraFields,
        call_count: (existing.call_count || 0) + 1,
        last_seen_at: new Date().toISOString(),
      })
      .eq('phone_hash', phoneHash)
      .select(SAFE_CALLER_FIELDS)
      .single();

    if (updateErr) throw new Error('Caller update failed: ' + updateErr.message);
    return { caller: updated, isRepeat: true };
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('flowdesk_callers')
    .insert({
      phone_hash: phoneHash,
      phone_last4: phoneLast4,
      call_count: 1,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      ...extraFields,
    })
    .select(SAFE_CALLER_FIELDS)
    .single();

  if (insertErr) throw new Error('Caller insert failed: ' + insertErr.message);
  return { caller: inserted, isRepeat: false };
}

// Start a new call session or reuse an existing one for the same CallSid
async function startOrReuseSession({ callerId, callSid, status }) {
  const supabase = getSupabaseAdmin();

  if (callSid) {
    const { data: existing } = await supabase
      .from('flowdesk_call_sessions')
      .select('id, caller_id, twilio_call_sid, status, started_at, created_at')
      .eq('twilio_call_sid', callSid)
      .maybeSingle();

    if (existing) return { session: existing, created: false };
  }

  const { data, error } = await supabase
    .from('flowdesk_call_sessions')
    .insert({
      caller_id: callerId || null,
      twilio_call_sid: callSid || null,
      status: status || 'in_progress',
      started_at: new Date().toISOString(),
    })
    .select('id, caller_id, twilio_call_sid, status, started_at, created_at')
    .single();

  if (error) throw new Error('Session creation failed: ' + error.message);
  return { session: data, created: true };
}

// Create a lead from a spoken intent captured by Twilio Gather.
// callback_phone is stored server-side only; never returned in public responses.
async function createLeadFromSpeech({ callerId, sessionId, from, speechResult }) {
  const normalizedFrom = normalizePhone(from);
  const callbackPhoneLast4 = normalizedFrom ? getPhoneLast4(from) : null;

  let contactName = null;
  if (callerId) {
    const ctx = await getCallerSafeContext(callerId);
    if (ctx && ctx.display_name) {
      contactName = ctx.display_name;
    } else if (ctx && ctx.phone_last4) {
      contactName = `Caller ***${ctx.phone_last4}`;
    }
  }
  if (!contactName && callbackPhoneLast4) {
    contactName = `Caller ***${callbackPhoneLast4}`;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('flowdesk_leads')
    .insert({
      caller_id: callerId || null,
      session_id: sessionId || null,
      contact_name: contactName,
      callback_phone: normalizedFrom,
      callback_phone_last4: callbackPhoneLast4,
      interest_area: (speechResult && speechResult.trim()) || 'Not provided',
      priority: 'normal',
      lead_status: 'new',
      source: 'conversational_ai_agent_demo',
    })
    .select(
      'id, caller_id, session_id, contact_name, callback_phone_last4, ' +
      'interest_area, priority, lead_status, source, created_at'
    )
    .single();

  if (error) throw new Error('Lead creation failed: ' + error.message);
  return data;
}

// Return safe caller fields by internal caller UUID (no phone_hash, no callback_phone)
async function getCallerSafeContext(callerId) {
  if (!callerId) return null;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('flowdesk_callers')
    .select(SAFE_CALLER_FIELDS)
    .eq('id', callerId)
    .maybeSingle();

  if (error) return null;
  return data;
}

module.exports = {
  lookupCallerByPhone,
  upsertCallerFromTwilio,
  startOrReuseSession,
  createLeadFromSpeech,
  getCallerSafeContext,
};
