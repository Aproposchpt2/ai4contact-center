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

function ariaTwiml(message, gatherAction, timeoutUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(message)}</Say>
  <Gather input="speech" action="${escapeXml(gatherAction)}" method="POST"
          speechTimeout="3" speechModel="phone_call" enhanced="true" language="en-US">
  </Gather>
  <Redirect method="POST">${escapeXml(timeoutUrl)}</Redirect>
</Response>`;
}

function buildSystemPrompt(centerName) {
  return `You are Aria, a warm and professional AI receptionist for ${centerName}.
Your job is to greet callers, understand their need, collect their name, and ensure they feel heard.
RULES: Max 35 words per response. Warm and natural. Never say you are AI unless asked directly.
If asked: "I'm Aria, a virtual assistant here to make sure you get the help you need."
Guide the conversation: understand need → ask for name → confirm we will follow up → wrap up warmly.
URGENCY: critical(emergency/urgent/right now/today), high(this week/soon/important), medium(no rush/sometime), low(just browsing/general info)
When you have collected the caller's name and understood their intent, output ONLY a raw JSON object (no markdown, no prose):
{"caller_name":"...","intent":"...","urgency":"low|medium|high|critical","callback_number":"caller_phone","summary":"...","next_action":"..."}`;
}

async function callClaude(systemPrompt, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: systemPrompt,
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error('Claude API: ' + parsed.error.message));
            return;
          }
          const text = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
          resolve({ text, usage: parsed.usage || {} });
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
      html: `<h2>New Lead — Aria Contact Center</h2>
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
      body: `[ARIA ${(lead.urgency || 'new').toUpperCase()}] ${lead.caller_name || 'Unknown'}: ${lead.intent || 'No intent'}. Phone: ***${phoneLast4 || '????'}`,
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
  <Say voice="Polly.Joanna-Neural">One moment while I connect you with a team member.</Say>
  <Dial timeout="30" callerId="${escapeXml(From || '')}">${escapeXml(forwardNumber)}</Dial>
  <Say voice="Polly.Joanna-Neural">No one is available right now. Please call back at your convenience. Goodbye.</Say>
  <Hangup/>
</Response>`);
    }
  }

  // Empty speech — re-prompt
  if (!SpeechResult || !SpeechResult.trim()) {
    const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', { turn, call_sid: callSid });
    const timeoutUrl = buildAbsoluteFunctionUrl(event, 'call', { timeout: 'true', call_sid: callSid });
    return xml(200, ariaTwiml("I'm sorry, I didn't catch that. How can I help you today?", gatherAction, timeoutUrl));
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
    const { data } = await supabase
      .from('conversation_history')
      .select('caller_id, session_id, history, turn_count')
      .eq('call_sid', callSid)
      .maybeSingle();
    historyRecord = data;
  } catch (e) {
    console.error('HISTORY LOAD ERROR:', e.message);
  }

  const callerId = historyRecord ? historyRecord.caller_id : null;
  const sessionId = historyRecord ? historyRecord.session_id : null;
  const prevHistory = (historyRecord && Array.isArray(historyRecord.history)) ? historyRecord.history : [];

  // Append user turn
  const historyWithUser = [...prevHistory, { role: 'user', content: speech }];

  // Call Claude
  let claudeText = '';
  let claudeUsage = {};
  try {
    const result = await callClaude(buildSystemPrompt(centerName), historyWithUser);
    claudeText = result.text.trim();
    claudeUsage = result.usage;
  } catch (e) {
    console.error('CLAUDE ERROR:', e.message);
    const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', { turn: turn + 1, call_sid: callSid });
    const timeoutUrl = buildAbsoluteFunctionUrl(event, 'call', { timeout: 'true', call_sid: callSid });
    return xml(200, ariaTwiml(
      "I'm having a moment of trouble. Could you tell me how I can help you today?",
      gatherAction,
      timeoutUrl
    ));
  }

  // Detect JSON completion output from Claude
  const jsonMatch = claudeText.match(/^\s*(\{[\s\S]*\})\s*$/);
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
              model_id: 'claude-sonnet-4-6',
              input_tokens: claudeUsage.input_tokens || 0,
              output_tokens: claudeUsage.output_tokens || 0,
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
        source: 'conversational_ai_agent',
      });
    } catch (e) {
      console.error('LEAD INSERT ERROR:', e.message);
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
  <Say voice="Polly.Joanna-Neural">${escapeXml(farewell)}</Say>
  <Hangup/>
</Response>`);
  }

  // Continue conversation — append assistant response and save
  const fullHistory = [...historyWithUser, { role: 'assistant', content: claudeText }];
  const newTurn = turn + 1;

  try {
    await supabase
      .from('conversation_history')
      .update({ history: fullHistory, turn_count: newTurn })
      .eq('call_sid', callSid);
  } catch (e) {
    console.error('HISTORY UPDATE ERROR:', e.message);
  }

  const gatherAction = buildAbsoluteFunctionUrl(event, 'flowdesk-twilio-gather', { turn: newTurn, call_sid: callSid });
  const timeoutUrl = buildAbsoluteFunctionUrl(event, 'call', { timeout: 'true', call_sid: callSid });

  return xml(200, ariaTwiml(claudeText, gatherAction, timeoutUrl));
};
