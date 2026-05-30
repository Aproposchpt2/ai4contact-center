'use strict';

// Sandbox AI gather loop — processes Twilio STT speech input,
// calls OpenAI Chat Completions REST, returns TwiML Gather for next turn.
// Uses FLOWDESK_OPENAI_REALTIME_MODEL (default gpt-4o-mini) via standard REST.

const {
  parseFormBody,
  escapeXml,
  xml,
  buildAbsoluteFunctionUrl,
  normalizeTwilioNumber,
} = require('./lib/flowdesk-twilio-utils');

const { getProfile } = require('./lib/sandbox-profiles');

const MAX_TURNS = 10;
const ESCALATION_RE = /\b(human|agent|person|representative|speak to someone|talk to someone|real person)\b/i;
const FORWARD_NUMBER = process.env.FORWARD_NUMBER;

function sandboxTwiml(message, gatherAction, timeoutUrl, voice) {
  const safeVoice = escapeXml(voice || 'Polly.Matthew-Neural');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${safeVoice}">${escapeXml(message)}</Say>
  <Gather input="speech" action="${escapeXml(gatherAction)}" method="POST"
          speechTimeout="auto" actionOnEmptyResult="true"
          speechModel="phone_call" enhanced="true" language="en-US">
  </Gather>
  <Redirect method="POST">${escapeXml(timeoutUrl)}</Redirect>
</Response>`;
}

function buildSayHangupTwiml(message, voice) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(voice || 'Polly.Matthew-Neural')}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

async function callOpenAI(systemPrompt, messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const model = process.env.FLOWDESK_OPENAI_REALTIME_MODEL || 'gpt-4o-mini';
  const temperature = parseFloat(process.env.FLOWDESK_AGENT_TEMPERATURE || '0.4');
  const maxTokens = Math.min(
    parseInt(process.env.FLOWDESK_AGENT_MAX_RESPONSE_SECONDS || '8', 10) * 20,
    300
  );

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};
  return { text, usage, model: data.model || model };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return xml(405, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Method not allowed.</Say><Hangup/></Response>');
  }

  const body = parseFormBody(event);
  const { SpeechResult, From } = body;
  const qs = event.queryStringParameters || {};
  const callSid = qs.call_sid || body.CallSid || '';
  const turn = parseInt(qs.turn || '1', 10);
  const profileKey = qs.profile || process.env.FLOWDESK_AGENT_PROFILE || 'corporate';
  const profile = getProfile(profileKey);

  const normalizedFrom = normalizeTwilioNumber(From) || From || '';
  const phoneLast4 = normalizedFrom ? normalizedFrom.slice(-4) : '????';

  // Escalation — caller requests human
  if (SpeechResult && ESCALATION_RE.test(SpeechResult)) {
    if (FORWARD_NUMBER) {
      return xml(200, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(profile.voice)}">One moment while I connect you with a team member.</Say>
  <Dial timeout="30" callerId="${escapeXml(From || '')}">${escapeXml(FORWARD_NUMBER)}</Dial>
  <Say voice="${escapeXml(profile.voice)}">No one is available right now. Please call back at your convenience. Goodbye.</Say>
  <Hangup/>
</Response>`);
    }
  }

  // Empty speech — re-prompt
  if (!SpeechResult || !SpeechResult.trim()) {
    const gatherAction = buildAbsoluteFunctionUrl(event, 'sandbox-agent-gather', { turn, call_sid: callSid, profile: profileKey });
    const timeoutUrl = buildAbsoluteFunctionUrl(event, 'sandbox-voice-webhook', { timeout: 'true', call_sid: callSid });
    return xml(200, sandboxTwiml("I'm sorry, I didn't catch that. Could you repeat that?", gatherAction, timeoutUrl, profile.voice));
  }

  // Turn limit
  if (turn > MAX_TURNS) {
    return xml(200, buildSayHangupTwiml(
      'Thank you for helping us test our AI agent. This has been a great conversation. Goodbye!',
      profile.voice
    ));
  }

  const speech = SpeechResult.trim();

  // Load conversation history from Supabase
  let prevHistory = [];
  let sessionRow = null;
  try {
    const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from('sandbox_call_sessions')
      .select('id, history, turn_count')
      .eq('call_sid', callSid)
      .maybeSingle();
    if (data) {
      sessionRow = data;
      prevHistory = Array.isArray(data.history) ? data.history : [];
    }
  } catch (e) {
    console.warn('SANDBOX HISTORY LOAD FAILED:', e.message);
  }

  const historyWithUser = [...prevHistory, { role: 'user', content: speech }];

  // Call OpenAI
  let aiText = '';
  let aiUsage = {};
  let aiModel = '';
  try {
    const result = await callOpenAI(profile.systemPrompt, historyWithUser);
    aiText = result.text.trim();
    aiUsage = result.usage;
    aiModel = result.model;
  } catch (e) {
    console.error('SANDBOX OPENAI ERROR:', e.message);
    const gatherAction = buildAbsoluteFunctionUrl(event, 'sandbox-agent-gather', { turn: turn + 1, call_sid: callSid, profile: profileKey });
    const timeoutUrl = buildAbsoluteFunctionUrl(event, 'sandbox-voice-webhook', { timeout: 'true', call_sid: callSid });
    return xml(200, sandboxTwiml(
      "I'm having a moment of trouble. Could you say that again?",
      gatherAction, timeoutUrl, profile.voice
    ));
  }

  console.log(`SANDBOX turn=${turn} call_sid=${callSid} phone=***${phoneLast4} profile=${profileKey} model=${aiModel} tokens_in=${aiUsage.prompt_tokens} tokens_out=${aiUsage.completion_tokens}`);

  // Detect JSON completion
  const jsonMatch = aiText.match(/^\s*(\{[\s\S]*\})\s*$/);
  if (jsonMatch) {
    let lead = {};
    try { lead = JSON.parse(jsonMatch[1]); } catch { /* use defaults */ }

    // Save completed session
    try {
      const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
      const supabase = getSupabaseAdmin();
      const finalHistory = [...historyWithUser, { role: 'assistant', content: aiText }];
      await supabase
        .from('sandbox_call_sessions')
        .update({
          history: finalHistory,
          turn_count: turn,
          lead_data: lead,
          status: 'completed',
          ended_at: new Date().toISOString(),
          ai_metadata: {
            model_id: aiModel,
            prompt_tokens: aiUsage.prompt_tokens || 0,
            completion_tokens: aiUsage.completion_tokens || 0,
            total_tokens: aiUsage.total_tokens || 0,
          },
        })
        .eq('call_sid', callSid);
    } catch (e) {
      console.warn('SANDBOX SESSION COMPLETE SAVE FAILED:', e.message);
    }

    const closingMessage = "I've collected everything I need. Thank you so much for your time. We'll be in touch shortly. Goodbye!";
    return xml(200, buildSayHangupTwiml(closingMessage, profile.voice));
  }

  // Ongoing conversation — persist turn
  const historyWithAssistant = [...historyWithUser, { role: 'assistant', content: aiText }];
  try {
    const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
    const supabase = getSupabaseAdmin();
    const updateData = {
      history: historyWithAssistant,
      turn_count: turn,
      updated_at: new Date().toISOString(),
    };
    if (sessionRow?.id) {
      await supabase.from('sandbox_call_sessions').update(updateData).eq('id', sessionRow.id);
    }
  } catch (e) {
    console.warn('SANDBOX HISTORY SAVE FAILED:', e.message);
  }

  const gatherAction = buildAbsoluteFunctionUrl(event, 'sandbox-agent-gather', {
    turn: turn + 1,
    call_sid: callSid,
    profile: profileKey,
  });
  const timeoutUrl = buildAbsoluteFunctionUrl(event, 'sandbox-voice-webhook', {
    timeout: 'true',
    call_sid: callSid,
  });

  return xml(200, sandboxTwiml(aiText, gatherAction, timeoutUrl, profile.voice));
};
