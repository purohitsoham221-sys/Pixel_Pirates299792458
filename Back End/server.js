'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const store = require('./db');
const { DEPARTMENTS } = require('./lib/classify');
const { LEVEL_NAMES, SEVERITY_SLA_LABEL, SEVERITY_RANK } = require('./lib/sla');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_BODY_BYTES = 15 * 1024 * 1024; // allows a base64-encoded photo up to ~10-11MB raw

store.init();

// Escalation sweep — mirrors the original client-side setInterval(...,20000).
// In production, switch SEVERITY_SLA in lib/sla.js from seconds to real
// hours/days and lengthen this interval (e.g. every few minutes).
const SWEEP_INTERVAL_MS = 20 * 1000;
setInterval(() => {
  try { store.runEscalationSweep(); } catch (e) { console.error('sweep error', e); }
}, SWEEP_INTERVAL_MS);

/* ---------------------------------------------------------------------
   tiny helpers
   --------------------------------------------------------------------- */
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(payload);
}
function jsonError(res, status, message) { send(res, status, { error: message }); }

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function savePhotoFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1];
  const ext = mime.split('/')[1].split('+')[0].slice(0, 5).replace(/[^a-z0-9]/gi, '') || 'jpg';
  const buf = Buffer.from(match[2], 'base64');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  return filename;
}

function getAuthOfficer(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  return token ? store.officerFromToken(token) : null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStaticFile(res, absPath) {
  fs.readFile(absPath, (err, data) => {
    if (err) return jsonError(res, 404, 'not_found');
    const ext = path.extname(absPath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

/* ---------------------------------------------------------------------
   route handlers
   --------------------------------------------------------------------- */
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/meta
  if (req.method === 'GET' && parts[1] === 'meta') {
    return send(res, 200, {
      departments: DEPARTMENTS,
      level_names: LEVEL_NAMES,
      sla_labels: SEVERITY_SLA_LABEL,
      severity_order: Object.keys(SEVERITY_RANK),
      statuses: ['Open', 'Escalated', 'Critical-Overdue', 'Resolved-Pending-Confirmation', 'Closed'],
    });
  }

  // GET /api/officers/roster  (usernames only, never passwords)
  if (req.method === 'GET' && parts[1] === 'officers' && parts[2] === 'roster') {
    return send(res, 200, store.officerRoster());
  }

  // POST /api/officers/login
  if (req.method === 'POST' && parts[1] === 'officers' && parts[2] === 'login') {
    const body = await readJsonBody(req);
    const result = store.loginOfficer(String(body.username || ''), String(body.password || ''));
    if (!result) return jsonError(res, 401, 'invalid_credentials');
    return send(res, 200, result);
  }

  // POST /api/officers/logout
  if (req.method === 'POST' && parts[1] === 'officers' && parts[2] === 'logout') {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (token) store.logoutOfficer(token);
    return send(res, 200, { ok: true });
  }

  // GET /api/officers/me
  if (req.method === 'GET' && parts[1] === 'officers' && parts[2] === 'me' && !parts[3]) {
    const officer = getAuthOfficer(req);
    if (!officer) return jsonError(res, 401, 'unauthorized');
    return send(res, 200, officer);
  }

  // GET /api/officers/me/queue
  if (req.method === 'GET' && parts[1] === 'officers' && parts[2] === 'me' && parts[3] === 'queue') {
    const officer = getAuthOfficer(req);
    if (!officer) return jsonError(res, 401, 'unauthorized');
    const queue = store
      .listComplaints({ department: officer.department })
      .filter((c) => c.level === officer.level && c.status !== 'Closed')
      .sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (b.support_count - a.support_count));
    return send(res, 200, queue);
  }

  // POST /api/admin/sweep  (any authenticated officer can trigger, like the demo "Force Escalation Sweep" button)
  if (req.method === 'POST' && parts[1] === 'admin' && parts[2] === 'sweep') {
    const officer = getAuthOfficer(req);
    if (!officer) return jsonError(res, 401, 'unauthorized');
    const n = store.runEscalationSweep();
    return send(res, 200, { escalated: n });
  }

  // POST /api/admin/reset-demo  (public, mirrors the original "Reset & Reseed Demo Data" button — disable/protect this in a real production deployment)
  if (req.method === 'POST' && parts[1] === 'admin' && parts[2] === 'reset-demo') {
    store.seedDemo();
    return send(res, 200, { ok: true });
  }

  // POST /api/complaints
  if (req.method === 'POST' && parts[1] === 'complaints' && !parts[2]) {
    const body = await readJsonBody(req);
    const text = String(body.text || '').trim();
    if (!text) return jsonError(res, 400, 'text_required');
    if (!body.photo) return jsonError(res, 400, 'photo_required');
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return jsonError(res, 400, 'geotagged_photo_required');

    const photoPath = savePhotoFromDataUrl(body.photo);
    if (!photoPath) return jsonError(res, 400, 'invalid_photo');

    const { duplicate, complaint, plainSecret } = store.createComplaint({
      text,
      lat,
      lon,
      address: body.address ? String(body.address).trim() : null,
      contact: body.contact ? String(body.contact).trim() : null,
      photoPath,
    });
    return send(res, 201, { duplicate, complaint, secret_key: duplicate ? undefined : plainSecret });
  }

  // GET /api/complaints  (public register / board)
  if (req.method === 'GET' && parts[1] === 'complaints' && !parts[2]) {
    const list = store.listComplaints({
      q: url.searchParams.get('q') || undefined,
      department: url.searchParams.get('department') || undefined,
      status: url.searchParams.get('status') || undefined,
    });
    return send(res, 200, list);
  }

  // GET /api/complaints/:ref  (also accepts a numeric id — the register is public either way)
  if (req.method === 'GET' && parts[1] === 'complaints' && parts[2] && !parts[3]) {
    const raw = decodeURIComponent(parts[2]);
    const c = /^\d+$/.test(raw) ? store.getComplaintById(Number(raw)) : store.getComplaintByRef(raw.toUpperCase());
    if (!c) return jsonError(res, 404, 'not_found');
    return send(res, 200, c);
  }

  // POST /api/complaints/:ref/confirm
  if (req.method === 'POST' && parts[1] === 'complaints' && parts[2] && parts[3] === 'confirm') {
    const body = await readJsonBody(req);
    const result = store.confirmResolution(
      decodeURIComponent(parts[2]).toUpperCase(),
      String(body.secret_key || ''),
      !!body.satisfied,
      body.comment ? String(body.comment).trim() : null,
    );
    if (!result.ok) {
      const codes = { not_found: 404, bad_secret: 401, wrong_state: 409 };
      return jsonError(res, codes[result.error] || 400, result.error);
    }
    return send(res, 200, result.complaint);
  }

  // POST /api/complaints/:id/respond   (id is the numeric id here, officer-only)
  // POST /api/complaints/:id/resolve
  if (req.method === 'POST' && parts[1] === 'complaints' && parts[2] && (parts[3] === 'respond' || parts[3] === 'resolve')) {
    const officer = getAuthOfficer(req);
    if (!officer) return jsonError(res, 401, 'unauthorized');
    const id = Number(parts[2]);
    const c = store.getComplaintById(id);
    if (!c) return jsonError(res, 404, 'not_found');
    if (c.department !== officer.department || c.level !== officer.level) {
      return jsonError(res, 403, 'not_in_your_queue');
    }
    if (c.status === 'Closed') return jsonError(res, 409, 'already_closed');
    const body = await readJsonBody(req);
    const message = (body.message && String(body.message).trim())
      || (parts[3] === 'respond' ? 'Acknowledged - work in progress.' : 'Issue resolved by department.');
    if (parts[3] === 'respond') store.respond(id, officer.username, message);
    else store.resolveComplaint(id, officer.username, message);
    return send(res, 200, store.getComplaintById(id));
  }

  return jsonError(res, 404, 'not_found');
}

/* ---------------------------------------------------------------------
   server
   --------------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    if (url.pathname.startsWith('/uploads/')) {
      const file = path.basename(url.pathname); // strip any path traversal
      return serveStaticFile(res, path.join(UPLOADS_DIR, file));
    }

    // static frontend
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const abs = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!abs.startsWith(PUBLIC_DIR)) return jsonError(res, 400, 'bad_path');
    return serveStaticFile(res, abs);
  } catch (err) {
    if (err && err.message === 'payload_too_large') return jsonError(res, 413, 'payload_too_large');
    if (err && err.message === 'invalid_json') return jsonError(res, 400, 'invalid_json');
    console.error(err);
    return jsonError(res, 500, 'internal_error');
  }
});

server.listen(PORT, () => {
  console.log(`Jan Prashasan Setu backend running on http://localhost:${PORT}`);
  console.log(`SQLite database at ${path.join(__dirname, 'data', 'jps.sqlite')}`);
});
