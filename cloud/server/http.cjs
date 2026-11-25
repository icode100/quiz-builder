'use strict';
const { ApiError } = require('./validation.cjs');
const MAX_BODY_BYTES = 4 * 1024 * 1024;
function reply(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Cookie');
  res.end(JSON.stringify(payload));
}
function sameOrigin(req) {
  let origin;
  try { origin = new URL(req.headers.origin); } catch { throw new ApiError(403, 'A same-origin request is required.'); }
  const expected = process.env.APP_ORIGIN;
  if (expected) {
    let configured;
    try { configured = new URL(expected).origin; } catch { throw new ApiError(503, 'The app origin has not been configured correctly.'); }
    if (origin.origin !== configured) throw new ApiError(403, 'This request came from a different site.');
  } else if (origin.host !== req.headers.host) throw new ApiError(403, 'This request came from a different site.');
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin.host) && !process.env.VERCEL;
  if (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) throw new ApiError(403, 'Use the secure app address.');
}
async function body(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Send JSON.');
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new ApiError(413, 'This sync request is too large.');
  // Vercel may parse JSON before invoking the handler; native Node streams it.
  if (req.body !== undefined) {
    let parsed = req.body;
    if (Buffer.isBuffer(parsed)) parsed = parsed.toString('utf8');
    if (typeof parsed === 'string') {
      if (Buffer.byteLength(parsed, 'utf8') > MAX_BODY_BYTES) throw new ApiError(413, 'This sync request is too large.');
      try { parsed = JSON.parse(parsed); } catch { throw new ApiError(400, 'Invalid JSON.'); }
    } else if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_BODY_BYTES) throw new ApiError(413, 'This sync request is too large.');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'Invalid JSON object.');
    return parsed;
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new ApiError(413, 'This sync request is too large.'); chunks.push(chunk); }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'Invalid JSON object.');
  return parsed;
}
function cookieOptions(req) {
  const local = !process.env.VERCEL && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
  return { name: local ? 'quiz_session' : '__Host-quiz_session', secure: !local };
}
function cookie(req) {
  const { name } = cookieOptions(req);
  const pair = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  if (!pair) return null;
  try { return decodeURIComponent(pair.slice(name.length + 1)); } catch { return null; }
}
function setCookie(req, res, value, maxAge) {
  const { name, secure } = cookieOptions(req);
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
module.exports = { reply, sameOrigin, body, cookie, setCookie, MAX_BODY_BYTES };
