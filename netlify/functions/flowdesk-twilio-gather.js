'use strict';

const https = require('https');
const { Resend } = require('resend');
const twilio = require('twilio');

const {
  parseFormBody,
  xml,
  escapeXml,
  buildAbsoluteFunctionUrl,
  buildSayHangupTwiml,
  normalizeTwilioNumber,
  validateTwilioSignature,
} = require('./lib/flowdesk-twilio-utils');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');

const ESCALATION_RE = /\b(human|agent|person|representative|speak to someone|talk to someone|real person)\b/i;
const URGENCY_TO_PRIORITY = { critical: 'hot', high: 'hot', medium: 'warm', low: 'normal' };
const MAX_TURNS = 10;
const FAREWELL_RE = /have a great day|have a wonderful day|goodbye|take care|we'll be in touch|someone will reach out|i've noted|noted your/i;
const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
const AGENT_NAME = process.env.FLOWDESK_AGENT_NAME || 'Marcus';
const AGENT_VOICE = process.env.FLOWDESK_AGENT_VOICE || 'Polly.Matthew-Neural';

function extractNameFromHistory(history) {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'user') continue;
    const text = (msg.content || '').trim();
    const m = text.match(/(?:my name is|i'm|i am|this is|call me)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
    if (m) return m[1];
    // Short response after assistant explicitly asked for name
    if (i > 0 && history[i - 1].role === 'assistant' && /\bname\b/i.test(history[i - 1].content || '')) {
      const words = text.split(/\s+/);
      if (words.length <= 3 && /^[A-Za-z]/.test(text)) return text;
    }
  }
  return null;
}

function extractIntentFromHistory(history) {
  const userMsgs = history.filter(m => m.role === 'user').map(m => m.content || '');
  return userMsgs.sort((a, b) => b.length - a.length)[0] || 'Voice inquiry';
}

function agentTwiml(message, gatherAction, timeoutUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(AGENT_VOICE)}">${escapeXml(message)}</Say>
  <Gather input="speech" action="${escapeXml(gatherAction)}" method="POST"
          speechTimeout="auto" actionOnEmptyResult="true" speechModel="phone_call" enhanced="true" language="en-US">
  </Gather>
  <Redirect method="POST">${escapeXml(timeoutUrl)}</Redirect>
</Response>`;
}

function buildSystemPrompt(centerName) {
  return `You are ${AGENT_NAME}, a warm, calm, and professional male virtual receptionist for ${centerName}.
Your job is to greet callers, understand their need, collect their name, and ensure they feel heard.
RULES: Max 35 words per response. Speak naturally for a phone call. Never say you are AI unless asked directly.
If asked: "I'm ${AGENT_NAME}, a virtual assistant here to make sure you get the help you need."
Guide the conversation: understand need → ask for name → confirm we will follow up → wrap up warmly.
CRITICAL: Never ask for information the caller has already provided in this conversation. Check the full history before asking any question.
URGENCY: critical(emergency/urgent/right now/today), high(this week/soon/important), medium(no rush/sometime), low(just browsing/general info)
When you have collected the caller's name and understood their intent, output ONLY a raw JSON object (no markdown, no prose):
{"caller_name":"...","intent":"...","urgency":"low|medium|high|critical","callback_number":"caller_phone","summary":"...","next_action":"..."}`;
}

function extractOpenAIText(parsed) {
  if (parsed && typeof parsed.output_text === 'string') {
    return parsed.output_text;
  }

  const output = Array.isArray(parsed && parsed.output) ? parsed.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }

  return '';
}

async function callOpenAI(systemPrompt, messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const input = messages.map((msg) => ({
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content || '',
  }));

  const payload = JSON.stringify({
    model,
    instructions: systemPrompt,
    input,
    max_output_tokens: 256,
    store: false,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400 || parsed.error) {
            const message = (parsed.error && parsed.error.message) || `HTTP ${res.statusCode}`;
            reject(new Error('OpenAI API: ' + message));
            return;
          }

          const text = extractOpenAIText(parsed);
          resolve({ text, usage: parsed.usage || {}, model: parsed.model || model });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendEmailAlert(lead, phoneLast4) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.ALERT_EMAIL || process.env.RESEND_TO_EMAIL;
  if (!apiKey || !toEmail) return;

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@aiflowdeskpro.com';
  const urgencyLabel = (lead.urgency || 'new').toUpperCase();

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      subject: `[${urgencyLabel}] New Lead: ${lead.caller_name || 'Unknown'} — ${lead.intent || 'No intent'}`,
      html: `<h2>New Lead — ${AGENT_NAME} Contact Center</h2>
<p><strong>Name:</strong> ${lead.caller_name || 'Not provided'}</p>
<p><strong>Intent:</strong> ${lead.intent || 'Not provided'}</p>
<p><strong>Urgency:</strong> ${lead.urgency || 'unknown'}</p>
<p><strong>Phone (last 4):</strong> ***${phoneLast4 || '????'}</p>
<p><strong>Summary:</strong> ${lead.summary || 'Not provided'}</p>
<p><strong>Next Action:</strong> ${lead.next_action || 'Follow up'}</p>`,
    });
  } catch (e) {
    console.error('EMAIL ALERT FAILED:', e.message);
  }
}

async function sendSmsAlert(lead, phoneLast4) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const alertPhone = process.env.TWILIO_ALERT_PHONE;
  const fromPhone = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !alertPhone || !fromPhone) return;

  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({
      to: alertPhone,
      from: fromPhone,
      body: `[${AGENT_NAME.toUpperCase()} ${(lead.urgency || 'new').toUpperCase()}] ${lead.caller_name || 'Unknown'}: ${lead.intent || 'No intent'}. Phone: ***${phoneLast4 || '????'}`,
    });
  } catch (e) {
    console.error('SMS ALERT FAILED:', e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return xml(405, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Method not allowed.</Say><Hangup/></Response>');
  }

  const body = parseFormBody(event);

  if (!validateTwilioSignature(event, body)) {
    return xml(403, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized.</Say><Hangup/></Response>');
  }

  const { SpeechResult, From } = body;
  const qs = event.queryStringParameters || {};
  const callSid = qs.call_sid || body.CallSid || '';
  const turn = parseInt(qs.turn || '1', 10);
  const normalizedFrom = normalizeTwilioNumber(From) || From || '';
  const phoneLast4 = normalizedFrom ? normalizedFrom.slice(-4) : '????';
  const centerName = process.env.FLOWDESK_CONTACT_CENTER_NAME || 'FlowDesk Pro Contact Center';

  // Escalation: caller requests a human agent
  if (SpeechResult && ESCALATION_RE.test(SpeechResult)) {
    const forwardNumber = process.env.FORWARD_NUMBER;
    if (forwardNumber) {
      return xml(200, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(AGENT_VOICE)}">One moment while I connect you with a team member.</Say>
  <Dial timeout="30" callerId="${escapeXml(From || '')}">${escapeXml(forwardNumber)}</Dial>
  <Say voice="${escapeXml(AGENT_VOICE)}">No one is available right now. Please call back at your convenience. Goodbye.</Say>
  <Hangup/>
</Response>`);
    }
  }

  // Empty speech — re-prompt
  if (!SpeechResult || !SpeechResult.trim()) {
    const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', { turn, call_sid: callSid });
    const timeoutUrl = buildAbsoluteFunctionUrl(event, 'call', { timeout: 'true', call_sid: callSid });
    return xml(200, agentTwiml("I'm sorry, I didn't catch that. How can I help you today?", gatherAction, timeoutUrl));
  }

  // Turn limit — gracefully close
  if (turn > MAX_TURNS) {
    return xml(200, buildSayHangupTwiml(
      'Thank you for your patience. Please call back and a team member will assist you. Goodbye.'
    ));
  }

  const speech = SpeechResult.trim();
  const supabase = getSupabaseAdmin();

  // Load conversation history
  let historyRecord = null;
  try {
    const { data, error: loadErr } = await supabase
      .from('conversation_history')
      .select('caller_id, session_id, history, turn_count')
      .eq('call_sid', callSid)
      .maybeSingle();
    if (loadErr) {
      console.error('HISTORY LOAD DB ERROR:', loadErr.message, loadErr.code);
    } else {
      historyRecord = data;
    }
  } catch (e) {
    console.error('HISTORY LOAD EXCEPTION:', e.message);
  }

  const callerId = historyRecord ? historyRecord.caller_id : null;
  const sessionId = historyRecord ? historyRecord.session_id : null;
  const prevHistory = (historyRecord && Array.isArray(historyRecord.history)) ? historyRecord.history : [];

  console.log(`${AGENT_NAME} turn=${turn} call_sid=${callSid} history_turns=${prevHistory.length} record_found=${!!historyRecord}`);

  // Append user turn
  const historyWithUser = [...prevHistory, { role: 'user', content: speech }];

  // Call OpenAI
  let agentText = '';
  let agentUsage = {};
  let agentModel = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  try {
    const result = await callOpenAI(buildSystemPrompt(centerName), historyWithUser);
    agentText = result.text.trim();
    agentUsage = result.usage;
    agentModel = result.model || agentModel;
  } catch (e) {
    console.error('OPENAI ERROR:', e.message);
    const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', { turn: turn + 1, call_sid: callSid });
    const timeoutUrl = buildAbsoluteFunctionUrl(event, 'call', { timeout: 'true', call_sid: callSid });
    return xml(200, agentTwiml(
      "I'm having a moment of trouble. Could you tell me how I can help you today?",
      gatherAction,
      timeoutUrl
    ));
  }

  // Detect JSON completion output from OpenAI
  const jsonMatch = agentText.match(/^\s*(\{[\s\S]*\})\s*$/);
  if (jsonMatch) {
    let lead = {};
    try { lead = JSON.parse(jsonMatch[1]); } catch { /* use defaults */ }

    const priority = URGENCY_TO_PRIORITY[lead.urgency] || 'normal';
    const callerName = lead.caller_name || null;
    const callbackPhone = (lead.callback_number && lead.callback_number !== 'caller_phone')
      ? lead.callback_number
      : normalizedFrom || null;
    const callbackLast4 = callbackPhone ? callbackPhone.slice(-4) : phoneLast4;

    // Update caller profile
    if (callerId) {
      try {
        const callerUpdate = {
          last_intent_summary: lead.summary || null,
          last_call_topic: lead.intent || null,
          last_seen_at: new Date().toISOString(),
        };
        if (callerName) callerUpdate.display_name = callerName;
        await supabase.from('flowdesk_callers').update(callerUpdate).eq('id', callerId);
      } catch (e) {
        console.error('CALLER UPDATE ERROR:', e.message);
      }
    }

    // Finalize session
    if (sessionId) {
      try {
        await supabase
          .from('flowdesk_call_sessions')
          .update({
            raw_transcript: historyWithUser,
            intent_summary: lead.summary || null,
            outcome: 'callback_requested',
            status: 'completed',
            ended_at: new Date().toISOString(),
            ai_metadata: {
              provider: 'openai',
              model_id: agentModel,
              input_tokens: agentUsage.input_tokens || 0,
              output_tokens: agentUsage.output_tokens || 0,
              total_tokens: agentUsage.total_tokens || 0,
            },
          })
          .eq('id', sessionId);
      } catch (e) {
        console.error('SESSION UPDATE ERROR:', e.message);
      }
    }

    // Create lead
    try {
      await supabase.from('flowdesk_leads').insert({
        caller_id: callerId || null,
        session_id: sessionId || null,
        contact_name: callerName,
        callback_phone: callbackPhone,
        callback_phone_last4: callbackLast4,
        interest_area: lead.intent || 'Not provided',
        priority,
        lead_status: 'new',
        source: 'contact-center',
      });
    } catch (e) {
      console.error('LEAD INSERT ERROR:', e.message);
    }

    // Dual-write to Lead Manager
    try {
      const now = new Date().toISOString();
      await supabase.from('lead_manager_records').insert({
        created_at: now,
        updated_at: now,
        tenant_id: 'apropos-ai4-businesses',
        client_name: 'Apropos Group LLC',
        business_name: 'FlowDesk Pro Contact Center',
        contact_name: callerName || 'Voice Caller',
        email: '',
        phone: '',
        source: 'contact-center',
        channel: 'voice',
        source_page: 'marcus-openai-voice-agent',
        lead_status: 'New / Needs Review',
        urgency: (lead.urgency === 'critical' || lead.urgency === 'high') ? 'High' : 'Normal',
        service_needed: lead.intent || 'Voice inquiry',
        category: 'Voice Inquiry',
        preferred_contact_method: 'Phone callback',
        message: lead.summary || lead.intent || '',
        details: `Voice inquiry via ${AGENT_NAME}. Intent: ${lead.intent || 'Not provided'}. Phone (last 4): ***${callbackLast4}. Next: ${lead.next_action || 'Follow up.'}`,
        ai_summary: lead.summary || '',
        next_action: lead.next_action || 'Follow up with caller via phone',
        follow_up_needed: true,
        appointment_requested: false,
        sms_consent: false,
        metadata: {
          origin_site: 'aiflowdeskpro.com',
          source_site: 'ai4contact-center',
          channel: 'voice',
          lead_source_type: 'contact_center_voice',
          agent_name: AGENT_NAME,
          ai_provider: 'openai',
          ai_model: agentModel,
          phone_last4: callbackLast4,
        },
      });
    } catch (e) {
      console.error('LM DUAL-WRITE ERROR:', e.message);
    }

    // Close history record
    try {
      await supabase.from('conversation_history').update({ is_complete: true }).eq('call_sid', callSid);
    } catch { /* non-fatal */ }

    // Send alerts (non-blocking)
    const alertsPromise = sendEmailAlert(lead, callbackLast4);
    const smsPromise = (lead.urgency === 'high' || lead.urgency === 'critical')
      ? sendSmsAlert(lead, callbackLast4)
      : Promise.resolve();
    await Promise.allSettled([alertsPromise, smsPromise]);

    const farewell = callerName
      ? `Thank you ${callerName}! We will follow up with you shortly. Have a wonderful day!`
      : `Thank you for calling ${centerName}. We will be in touch with you shortly. Have a wonderful day!`;

    return xml(200, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(AGENT_VOICE)}">${escapeXml(farewell)}</Say>
  <Hangup/>
</Response>`);
  }

  // Completion triggers: farewell words in response, soft turn limit, or name + reason both collected
  const nameFromHistory = extractNameFromHistory(historyWithUser);
  const hasReason = historyWithUser.filter(m => m.role === 'user').some(m => (m.content || '').split(/\s+/).length >= 5);
  const conversationDone = FAREWELL_RE.test(agentText) || turn >= 4 || (nameFromHistory && hasReason);

  if (conversationDone) {
    const softLead = {
      caller_name: nameFromHistory,
      intent: extractIntentFromHistory(historyWithUser),
      urgency: 'medium',
      summary: historyWithUser.filter(m => m.role === 'user').map(m => m.content).join('; '),
      next_action: 'Follow up with caller',
    };
    const callbackPhone = normalizedFrom || null;
    const callbackLast4 = callbackPhone ? callbackPhone.slice(-4) : phoneLast4;

    if (callerId) {
      try {
        const callerUpdate = { last_intent_summary: softLead.intent, last_seen_at: new Date().toISOString() };
        if (softLead.caller_name) callerUpdate.display_name = softLead.caller_name;
        await supabase.from('flowdesk_callers').update(callerUpdate).eq('id', callerId);
      } catch (e) { console.error('CALLER UPDATE ERROR:', e.message); }
    }

    if (sessionId) {
      try {
        await supabase.from('flowdesk_call_sessions').update({
          raw_transcript: historyWithUser,
          intent_summary: softLead.intent,
          outcome: 'callback_requested',
          status: 'completed',
          ended_at: new Date().toISOString(),
          ai_metadata: {
            provider: 'openai',
            model_id: agentModel,
            input_tokens: agentUsage.input_tokens || 0,
            output_tokens: agentUsage.output_tokens || 0,
            total_tokens: agentUsage.total_tokens || 0,
          },
        }).eq('id', sessionId);
      } catch (e) { console.error('SESSION UPDATE ERROR:', e.message); }
    }

    try {
      await supabase.from('flowdesk_leads').insert({
        caller_id: callerId || null,
        session_id: sessionId || null,
        contact_name: softLead.caller_name,
        callback_phone: callbackPhone,
        callback_phone_last4: callbackLast4,
        interest_area: softLead.intent,
        priority: 'warm',
        lead_status: 'new',
        source: 'contact-center',
      });
    } catch (e) { console.error('LEAD INSERT ERROR:', e.message); }

    try {
      const now = new Date().toISOString();
      await supabase.from('lead_manager_records').insert({
        created_at: now,
        updated_at: now,
        tenant_id: 'apropos-ai4-businesses',
        client_name: 'Apropos Group LLC',
        business_name: 'FlowDesk Pro Contact Center',
        contact_name: softLead.caller_name || 'Voice Caller',
        email: '',
        phone: '',
        source: 'contact-center',
        channel: 'voice',
        source_page: 'marcus-openai-voice-agent',
        lead_status: 'New / Needs Review',
        urgency: 'Normal',
        service_needed: softLead.intent || 'Voice inquiry',
        category: 'Voice Inquiry',
        preferred_contact_method: 'Phone callback',
        message: softLead.intent || '',
        details: `Voice inquiry via ${AGENT_NAME}. Intent: ${softLead.intent || 'Not provided'}. Phone (last 4): ***${callbackLast4}.`,
        ai_summary: softLead.intent || '',
        next_action: softLead.next_action || 'Follow up with caller via phone',
        follow_up_needed: true,
        appointment_requested: false,
        sms_consent: false,
        metadata: {
          origin_site: 'aiflowdeskpro.com',
          source_site: 'ai4contact-center',
          channel: 'voice',
          lead_source_type: 'contact_center_voice',
          agent_name: AGENT_NAME,
          ai_provider: 'openai',
          ai_model: agentModel,
          phone_last4: callbackLast4,
        },
      });
    } catch (e) { console.error('LM DUAL-WRITE ERROR:', e.message); }

    try {
      await supabase.from('conversation_history').update({ is_complete: true }).eq('call_sid', callSid);
    } catch { /* non-fatal */ }

    await Promise.allSettled([
      sendEmailAlert(softLead, callbackLast4),
      (softLead.urgency === 'high' || softLead.urgency === 'critical') ? sendSmsAlert(softLead, callbackLast4) : Promise.resolve(),
    ]);

    const farewellText = FAREWELL_RE.test(agentText)
      ? agentText
      : (softLead.caller_name
          ? `Thank you ${softLead.caller_name}! We will follow up with you shortly. Have a wonderful day!`
          : `Thank you for calling ${centerName}. We will be in touch shortly. Have a wonderful day!`);

    return xml(200, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(AGENT_VOICE)}">${escapeXml(farewellText)}</Say>
  <Hangup/>
</Response>`);
  }

  // Continue conversation — append assistant response and save
  const fullHistory = [...historyWithUser, { role: 'assistant', content: agentText }];
  const newTurn = turn + 1;

  try {
    const { error: saveErr } = await supabase
      .from('conversation_history')
      .update({ history: fullHistory, turn_count: newTurn })
      .eq('call_sid', callSid);
    if (saveErr) {
      console.error('HISTORY SAVE DB ERROR:', saveErr.message, saveErr.code);
    } else {
      console.log(`${AGENT_NAME} history saved turn=${newTurn} messages=${fullHistory.length}`);
    }
  } catch (e) {
    console.error('HISTORY SAVE EXCEPTION:', e.message);
  }

  const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', { turn: newTurn, call_sid: callSid });
  const timeoutUrl = buildAbsoluteFunctionUrl(event, 'call', { timeout: 'true', call_sid: callSid });

  return xml(200, agentTwiml(agentText, gatherAction, timeoutUrl));
};
