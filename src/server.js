// HTTP server: player API, Square webhook, staff redeem, admin summary, static web app.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { normalisePhone } from './engine.js';
import { issueOtp, checkOtp, createSession, sessionPhone, endSession } from './auth.js';
import { getPlayer, upsertPlayer, recordPayment, recordRefund, play, state, redeem, summary, finishers } from './game.js';
import { verifySignature, parseEvent } from './square.js';
import { sendSms, rollMessage } from './sms.js';
import { LOCATIONS } from './config.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json' };

const env = (k, d) => process.env[k] ?? d;
const PROD = env('NODE_ENV') === 'production';
const DEV_PURCHASES = env('DEV_PURCHASES') === '1' && !PROD;

function send(res, status, body, headers = {}) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(json);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const parseJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return null; } };

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  const file = join(WEB_DIR, path);
  if (!file.startsWith(WEB_DIR)) return send(res, 404, { error: 'not_found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not_found' });
  }
}

export function makeApp(db, { squareFetcher } = {}) {
  async function notifyRolls(phone, result) {
    if (!result || result.rolls < 1) return;
    const p = getPlayer(db, phone);
    if (!p?.sms_opt_in) return;
    try { await sendSms(phone, rollMessage(result)); } catch (e) { console.error('sms failed', e.message); }
  }

  async function handleSquare(req, res) {
    const raw = await readBody(req);
    const ok = verifySignature({
      signature: req.headers['x-square-hmacsha256-signature'],
      body: raw,
      url: env('SQUARE_WEBHOOK_URL'),
      key: env('SQUARE_WEBHOOK_SIGNATURE_KEY'),
    });
    if (!ok) return send(res, 401, { error: 'bad_signature' });
    const event = parseJson(raw);
    if (!event?.event_id) return send(res, 400, { error: 'bad_event' });
    const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)')
      .run(event.event_id, new Date().toISOString());
    if (seen.changes === 0) return send(res, 200, { ok: true, duplicate: true });

    let parsed;
    try {
      parsed = await parseEvent(event, env('SQUARE_ACCESS_TOKEN'), squareFetcher);
    } catch (e) {
      // Let Square retry: forget the event id so the retry is processed.
      db.prepare('DELETE FROM webhook_events WHERE event_id = ?').run(event.event_id);
      console.error('square lookup failed', e.message);
      return send(res, 500, { error: 'lookup_failed' });
    }
    if (parsed?.kind === 'payment') {
      const result = recordPayment(db, parsed);
      await notifyRolls(parsed.phone, result);
    } else if (parsed?.kind === 'refund') {
      recordRefund(db, parsed);
    }
    return send(res, 200, { ok: true });
  }

  return async function app(req, res) {
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'POST /webhooks/square') return await handleSquare(req, res);

      if (route === 'POST /api/auth/start') {
        const body = parseJson(await readBody(req));
        const phone = normalisePhone(body?.phone);
        if (!phone) return send(res, 400, { error: 'bad_phone' });
        const r = issueOtp(db, phone);
        if (r.error) return send(res, 429, r);
        await sendSms(phone, `Your DJs Food Hall code is ${r.code}. It expires in 10 minutes.`);
        return send(res, 200, { ok: true });
      }

      if (route === 'POST /api/auth/verify') {
        const body = parseJson(await readBody(req));
        const phone = normalisePhone(body?.phone);
        if (!phone || !checkOtp(db, phone, String(body?.code || ''))) return send(res, 401, { error: 'bad_code' });
        if (!getPlayer(db, phone) && !body?.acceptTerms) return send(res, 400, { error: 'terms_required' });
        upsertPlayer(db, phone, { smsOptIn: Boolean(body?.smsOptIn) });
        const s = createSession(db, phone);
        const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${s.maxAge}${PROD ? '; Secure' : ''}`;
        return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${s.token}; ${flags}` });
      }

      if (route === 'POST /api/auth/logout') {
        endSession(db, cookie(req, 'sid'));
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      }

      if (url.pathname.startsWith('/api/me') || route === 'POST /api/roll' || route === 'POST /api/dev/purchase') {
        const phone = sessionPhone(db, cookie(req, 'sid'));
        if (!phone) return send(res, 401, { error: 'signed_out' });
        if (route === 'GET /api/me') return send(res, 200, { phone, ...state(db, phone) });
        if (route === 'POST /api/roll') {
          const r = play(db, phone);
          return send(res, r.error ? 409 : 200, r);
        }
        if (route === 'POST /api/dev/purchase') {
          if (!DEV_PURCHASES) return send(res, 404, { error: 'not_found' });
          const body = parseJson(await readBody(req));
          const locationId = LOCATIONS[body?.locationId] ? body.locationId : Object.keys(LOCATIONS)[0];
          const result = recordPayment(db, {
            paymentId: `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            phone, locationId,
            amountCents: Math.round(Number(body?.amount || 0) * 100),
            paidAt: body?.paidAt || new Date().toISOString(),
          });
          return send(res, 200, result || { rolls: 0, reason: 'not_counted' });
        }
      }

      if (route === 'POST /api/staff/redeem') {
        const body = parseJson(await readBody(req));
        if (!sameSecret(String(body?.pin || ''), env('STAFF_PIN'))) return send(res, 401, { error: 'bad_pin' });
        const r = redeem(db, { code: String(body?.code || ''), staff: String(body?.outlet || 'staff') });
        return send(res, r.error ? 409 : 200, r);
      }

      if (url.pathname.startsWith('/api/admin/')) {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!sameSecret(token, env('ADMIN_TOKEN'))) return send(res, 401, { error: 'unauthorised' });
        if (route === 'GET /api/admin/summary') return send(res, 200, summary(db));
        if (route === 'GET /api/admin/finishers') return send(res, 200, finishers(db));
        return send(res, 404, { error: 'not_found' });
      }

      if (route === 'GET /api/config') return send(res, 200, { devPurchases: DEV_PURCHASES, locations: LOCATIONS });

      if (req.method === 'GET') return await serveStatic(req, res);
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      console.error(e);
      return send(res, e.status || 500, { error: 'server_error' });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const port = Number(env('PORT', 3000));
  createServer(makeApp(db)).listen(port, () => console.log(`DJs Food Hall game on http://localhost:${port}`));
}
