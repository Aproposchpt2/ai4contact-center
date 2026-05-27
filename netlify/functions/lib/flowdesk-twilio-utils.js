'use strict';

const crypto = require('crypto');
const querystring = require('querystring');

// Parse application/x-www-form-urlencoded body from a Twilio POST
function parseFormBody(event) {
  const body = event.body;
  if (!body) return {};
  try {
    const decoded = event.isBase64Encoded
      ? Buffer.from(body, 'base64').toString('utf8')
      : body;
    return querystring.parse(decoded);
  } catch {
    return {};
  }
}

// Escape XML special characters for safe TwiML injection
function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Return a Netlify function response with TwiML body
function xml(statusCode, twiml) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: twiml,
  };
}

// Build an absolute URL for a Netlify function, used as Gather action
function buildAbsoluteFunctionUrl(event, functionPath, queryParams) {
  const base = process.env.FLOWDESK_PUBLIC_BASE_URL;
  let origin;
  if (base) {
    origin = base.replace(/\/$/, '');
  } else {
    const host =
      (event.headers &&
        (event.headers['x-forwarded-host'] || event.headers.host)) ||
      '';
    const proto =
      (event.headers && event.headers['x-forwarded-proto']) || 'https';
    origin = `${proto}://${host}`;
  }
  const path = functionPath.startsWith('/')
    ? functionPath
    : `/.netlify/functions/${functionPath}`;
  if (queryParams && Object.keys(queryParams).length > 0) {
    return `${origin}${path}?${querystring.stringify(queryParams)}`;
  }
  return `${origin}${path}`;
}

// Build a Gather TwiML response with speech input
function buildGatherTwiml(message, actionUrl) {
  const safeMsg = escapeXml(message);
  const safeAction = escapeXml(actionUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${safeAction}" method="POST" timeout="5" speechTimeout="auto">
    <Say voice="Polly.Joanna">${safeMsg}</Say>
  </Gather>
  <Say voice="Polly.Joanna">We did not receive a response. Please call again or submit a request through our website. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

// Build a Say + Hangup TwiML response
function buildSayHangupTwiml(message) {
  const safeMsg = escapeXml(message);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${safeMsg}</Say>
  <Hangup/>
</Response>`;
}

// Normalize a Twilio-provided phone number to E.164
function normalizeTwilioNumber(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 7) return `+${digits}`;
  return null;
}

// Check whether To is in the comma-separated allowed-numbers env var
function isAllowedToNumber(toNumber, allowedNumbersEnv) {
  if (!allowedNumbersEnv) return true;
  const allowed = allowedNumbersEnv
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  const normalized = normalizeTwilioNumber(toNumber);
  return normalized ? allowed.includes(normalized) : false;
}

// Validate Twilio request signature — only enforced when explicitly enabled.
// Default: disabled so curl/manual sandbox tests work without auth.
// TWILIO_AUTH_TOKEN is read from env only; never logged or returned.
function validateTwilioSignature(event, body) {
  if (process.env.FLOWDESK_TWILIO_VALIDATE_SIGNATURE !== 'true') return true;

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;

  const sig =
    event.headers &&
    (event.headers['x-twilio-signature'] ||
      event.headers['X-Twilio-Signature']);
  if (!sig) return false;

  const url = buildAbsoluteFunctionUrl(event, event.path || '', {});
  const params = body || {};
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');

  const expected = crypto
    .createHmac('sha1', token)
    .update(url + paramString)
    .digest('base64');

  return expected === sig;
}

module.exports = {
  parseFormBody,
  xml,
  escapeXml,
  buildAbsoluteFunctionUrl,
  buildGatherTwiml,
  buildSayHangupTwiml,
  normalizeTwilioNumber,
  isAllowedToNumber,
  validateTwilioSignature,
};
