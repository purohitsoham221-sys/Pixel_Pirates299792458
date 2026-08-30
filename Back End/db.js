'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { classify, DEPARTMENTS, slug } = require('./lib/classify');
const { findDuplicate } = require('./lib/dedup');
const { computeDeadlines, LEVEL_NAMES } = require('./lib/sla');
const { hashSecret, verifySecret, refCode, secretKey, sessionToken } = require('./lib/auth');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'jps.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_ref TEXT UNIQUE NOT NULL,
  secret_key_hash TEXT NOT NULL,
  contact TEXT,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT NOT NULL,
  severity TEXT NOT NULL,
  needs_human_review INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lon REAL,
  address TEXT,
  photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'Open',
  level INTEGER NOT NULL DEFAULT 0,
  support_count INTEGER NOT NULL DEFAULT 1,
  responded_at INTEGER,
  resolved_at INTEGER,
  response_deadline INTEGER,
  resolution_deadline INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  ts INTEGER NOT NULL,
  actor TEXT,
  action TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  type TEXT,
  by_officer TEXT,
  message TEXT,
  at INTEGER
);

CREATE TABLE IF NOT EXISTS officers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  department TEXT NOT NULL,
  level INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  officer_id INTEGER NOT NULL REFERENCES officers(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_complaints_dept ON complaints(department);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_history_complaint ON history(complaint_id);
CREATE INDEX IF NOT EXISTS idx_responses_complaint ON responses(complaint_id);
`);

/* ---------------------------------------------------------------------
   low-level helpers
   --------------------------------------------------------------------- */
function run(sql, ...params) { return db.prepare(sql).run(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }
function all(sql, ...params) { return db.prepare(sql).all(...params); }

function addHistory(complaintId, actor, action, note) {
  run(
    'INSERT INTO history (complaint_id, ts, actor, action, note) VALUES (?, ?, ?, ?, ?)',
    complaintId, Date.now(), actor, action, note,
  );
}

function rowToComplaint(row) {
  if (!row) return null;
  const history = all('SELECT ts, actor, action, note FROM history WHERE complaint_id = ? ORDER BY id ASC', row.id);
  const responses = all('SELECT type, by_officer as by, message, at FROM responses WHERE complaint_id = ? ORDER BY id ASC', row.id);
  return {
    id: row.id,
    anon_ref: row.anon_ref,
    text: row.text,
    category: row.category,
    department: row.department,
    severity: row.severity,
    needs_human_review: !!row.needs_human_review,
    lat: row.lat,
    lon: row.lon,
    address: row.address,
    photo_url: row.photo_path ? `/uploads/${row.photo_path}` : null,
    status: row.status,
    level: row.level,
    level_name: LEVEL_NAMES[row.level] || LEVEL_NAMES[0],
    support_count: row.support_count,
    responded_at: row.responded_at,
    resolved_at: row.resolved_at,
    response_deadline: row.response_deadline,
    resolution_deadline: row.resolution_deadline,
    created_at: row.created_at,
    history,
    responses,
  };
}

/* ---------------------------------------------------------------------
   complaints
   --------------------------------------------------------------------- */
function createComplaint({ text, lat, lon, address, contact, photoPath }) {
  const cls = classify(text);

  // Only compare against open candidates in the same department+category —
  // mirrors the original client-side dedup call.
  const candidateRows = all(
    `SELECT id, text, lat, lon FROM complaints
     WHERE department = ? AND category = ? AND status != 'Closed'`,
    cls.department, cls.category,
  );
  const dup = findDuplicate(text, lat, lon, candidateRows);

  if (dup) {
    run('UPDATE complaints SET support_count = support_count + 1 WHERE id = ?', dup.id);
    if (photoPath) {
      const row = get('SELECT photo_path FROM complaints WHERE id = ?', dup.id);
      if (!row.photo_path) run('UPDATE complaints SET photo_path = ? WHERE id = ?', photoPath, dup.id);
    }
    addHistory(dup.id, 'citizen', 'Duplicate merged', `New report merged: "${String(text).slice(0, 100)}"`);
    return { duplicate: true, complaint: getComplaintById(dup.id) };
  }

  const ref = refCode();
  const plainSecret = secretKey();
  const { response_deadline, resolution_deadline } = computeDeadlines(cls.severity, 0);
  const now = Date.now();

  const info = run(
    `INSERT INTO complaints
      (anon_ref, secret_key_hash, contact, text, category, department, severity,
       needs_human_review, lat, lon, address, photo_path, status, level, support_count,
       response_deadline, resolution_deadline, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ref, hashSecret(plainSecret), contact || null, text, cls.category, cls.department, cls.severity,
    cls.needs_human_review ? 1 : 0, lat ?? null, lon ?? null, address || null, photoPath || null,
    'Open', 0, 1, response_deadline, resolution_deadline, now,
  );
  const id = Number(info.lastInsertRowid);
  addHistory(id, 'system', 'Registered', `Routed to ${cls.department} (category: ${cls.category}, severity: ${cls.severity})`);

  return { duplicate: false, complaint: getComplaintById(id), plainSecret };
}

function getComplaintById(id) {
  return rowToComplaint(get('SELECT * FROM complaints WHERE id = ?', id));
}
function getComplaintByRef(ref) {
  return rowToComplaint(get('SELECT * FROM complaints WHERE anon_ref = ?', ref));
}
function getRawByRef(ref) {
  return get('SELECT * FROM complaints WHERE anon_ref = ?', ref);
}

function listComplaints({ q, department, status } = {}) {
  let sql = 'SELECT * FROM complaints WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND lower(text) LIKE ?'; params.push(`%${String(q).toLowerCase()}%`); }
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY support_count DESC, created_at DESC';
  return all(sql, ...params).map(rowToComplaint);
}

function respond(id, officer, message) {
  const now = Date.now();
  run('UPDATE complaints SET responded_at = COALESCE(responded_at, ?) WHERE id = ?', now, id);
  run('INSERT INTO responses (complaint_id, type, by_officer, message, at) VALUES (?,?,?,?,?)', id, 'response', officer, message, now);
  addHistory(id, officer, 'Responded', message);
}

function resolveComplaint(id, officer, message) {
  const now = Date.now();
  run("UPDATE complaints SET status = 'Resolved-Pending-Confirmation', resolved_at = ? WHERE id = ?", now, id);
  run('INSERT INTO responses (complaint_id, type, by_officer, message, at) VALUES (?,?,?,?,?)', id, 'resolution', officer, message, now);
  addHistory(id, officer, 'Marked Resolved', `${message} (awaiting citizen confirmation)`);
}

function escalate(id, reason) {
  const row = get('SELECT level, severity FROM complaints WHERE id = ?', id);
  if (!row) return;
  let newLevel = row.level;
  let status;
  if (row.level < 2) {
    newLevel = row.level + 1;
    status = 'Escalated';
  } else {
    status = 'Critical-Overdue';
  }
  const { response_deadline, resolution_deadline } = computeDeadlines(row.severity, newLevel);
  run(
    'UPDATE complaints SET level = ?, status = ?, response_deadline = ?, resolution_deadline = ? WHERE id = ?',
    newLevel, status, response_deadline, resolution_deadline, id,
  );
  addHistory(id, 'system', 'Escalated', `${reason} → now with ${LEVEL_NAMES[newLevel]}`);
}

function confirmResolution(ref, plainSecret, satisfied, comment) {
  const row = getRawByRef(ref);
  if (!row) return { ok: false, error: 'not_found' };
  if (!verifySecret(plainSecret, row.secret_key_hash)) return { ok: false, error: 'bad_secret' };
  if (row.status !== 'Resolved-Pending-Confirmation') return { ok: false, error: 'wrong_state' };

  if (satisfied) {
    run("UPDATE complaints SET status = 'Closed' WHERE id = ?", row.id);
    addHistory(row.id, 'citizen', 'Confirmed — Closed', comment || 'Citizen confirmed the issue is resolved.');
  } else {
    run("UPDATE complaints SET status = 'Open' WHERE id = ?", row.id);
    addHistory(row.id, 'citizen', 'Reopened', comment || 'Citizen reported the issue is not actually resolved.');
    escalate(row.id, 'Reopened by citizen after unsatisfactory resolution');
  }
  return { ok: true, complaint: getComplaintById(row.id) };
}

function runEscalationSweep() {
  const now = Date.now();
  const rows = all(
    "SELECT id, resolution_deadline, response_deadline, responded_at FROM complaints WHERE status NOT IN ('Resolved-Pending-Confirmation','Closed','Critical-Overdue')",
  );
  let n = 0;
  for (const c of rows) {
    if (c.resolution_deadline && now > c.resolution_deadline) {
      escalate(c.id, 'Resolution SLA deadline missed');
      n++;
      continue;
    }
    if (c.response_deadline && now > c.response_deadline && !c.responded_at) {
      escalate(c.id, 'Response SLA deadline missed (no acknowledgement)');
      n++;
    }
  }
  return n;
}

/* ---------------------------------------------------------------------
   officers / sessions
   --------------------------------------------------------------------- */
function seedOfficers() {
  const existing = get('SELECT COUNT(*) as n FROM officers').n;
  if (existing > 0) return;
  for (const dep of DEPARTMENTS) {
    for (let lvl = 0; lvl < 3; lvl++) {
      const username = `${slug(dep)}-L${lvl + 1}`;
      run(
        'INSERT OR IGNORE INTO officers (username, password_hash, department, level) VALUES (?,?,?,?)',
        username, hashSecret('password123'), dep, lvl,
      );
    }
  }
}

function officerRoster() {
  return all('SELECT username, department, level FROM officers ORDER BY department, level');
}

function loginOfficer(username, password) {
  const off = get('SELECT * FROM officers WHERE username = ?', username);
  if (!off || !verifySecret(password, off.password_hash)) return null;
  const token = sessionToken();
  const now = Date.now();
  const expires = now + 8 * 60 * 60 * 1000; // 8 hours
  run('INSERT INTO sessions (token, officer_id, created_at, expires_at) VALUES (?,?,?,?)', token, off.id, now, expires);
  return { token, officer: { id: off.id, username: off.username, department: off.department, level: off.level } };
}

function logoutOfficer(token) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

function officerFromToken(token) {
  if (!token) return null;
  const row = get(
    `SELECT o.id, o.username, o.department, o.level, s.expires_at FROM sessions s
     JOIN officers o ON o.id = s.officer_id WHERE s.token = ?`,
    token,
  );
  if (!row) return null;
  if (Date.now() > row.expires_at) { run('DELETE FROM sessions WHERE token = ?', token); return null; }
  return { id: row.id, username: row.username, department: row.department, level: row.level };
}

/* ---------------------------------------------------------------------
   demo seed / reset
   --------------------------------------------------------------------- */
function wipeAllComplaints() {
  run('DELETE FROM responses');
  run('DELETE FROM history');
  run('DELETE FROM complaints');
}

function seedDemo() {
  wipeAllComplaints();
  const DEMO = [
    ['Massive pothole on MG Road near the flyover, two accidents already this week', 12.9716, 77.5946, 'MG Road flyover, Bengaluru', 'escalate'],
    ['No water supply in Sector 21 for 4 days now, tankers also not coming', 28.5679, 77.3261, 'Sector 21, Noida', 'open'],
    ['Streetlights near the community park have been off for a month', 19.0760, 72.8777, 'Community Park, Mumbai', 'resolved'],
    ['Garbage not collected on Lake Road for two weeks, terrible smell', 13.0827, 80.2707, 'Lake Road, Chennai', 'closed'],
    ['Transformer sparking near the government school, very dangerous for children', 22.5726, 88.3639, 'Govt School Road, Kolkata', 'open'],
  ];
  for (const [text, lat, lon, addr, walk] of DEMO) {
    const { complaint: c } = createComplaint({ text, lat, lon, address: addr, contact: null });
    if (walk === 'escalate') {
      escalate(c.id, 'Demo: simulated missed SLA for illustration');
    } else if (walk === 'resolved') {
      respond(c.id, 'demo-officer', 'Team dispatched to inspect.');
      resolveComplaint(c.id, 'demo-officer', 'New light fixtures installed and tested.');
    } else if (walk === 'closed') {
      respond(c.id, 'demo-officer', 'Sanitation crew assigned.');
      resolveComplaint(c.id, 'demo-officer', 'Backlog cleared, area cleaned.');
      const row = getRawByRef(c.anon_ref);
      run("UPDATE complaints SET status = 'Closed' WHERE id = ?", row.id);
      addHistory(row.id, 'citizen', 'Confirmed — Closed', 'Confirmed clean now, thank you.');
    }
  }
}

function init() {
  seedOfficers();
  const count = get('SELECT COUNT(*) as n FROM complaints').n;
  if (count === 0) seedDemo();
}

module.exports = {
  db,
  init,
  createComplaint,
  getComplaintById,
  getComplaintByRef,
  listComplaints,
  respond,
  resolveComplaint,
  escalate,
  confirmResolution,
  runEscalationSweep,
  officerRoster,
  loginOfficer,
  logoutOfficer,
  officerFromToken,
  seedDemo,
};
