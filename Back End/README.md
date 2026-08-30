# Jan Prashasan Setu — Backend

A real backend + database for the JPS grievance-redressal site: citizen
complaints, an AI-ish classifier/dedup engine, SLA-based auto-escalation,
an officer portal, and a public register — all backed by a persistent
SQLite database instead of an in-memory array that resets on refresh.

**Zero npm dependencies.** It's built entirely on Node's built-ins:
`node:http` for the server and `node:sqlite` (Node 22.5+) for the
database. That means no `npm install`, and it also runs anywhere without
network/registry access.

## Run it

```bash
node --version   # need 22.5.0 or newer (for node:sqlite)
cd jps-backend
node server.js   # or: npm start
```

Then open **http://localhost:3000**. The database is created automatically
at `data/jps.sqlite` on first run and seeded with the same 5 demo
complaints the original prototype used. Uploaded photos are written to
`uploads/`. Set `PORT=8080 node server.js` to use a different port.

Everything now persists: refreshing the page, closing the browser, or
restarting the server does **not** wipe the register — only the "Reset &
Reseed Demo Data" button does that, on purpose.

## What changed vs. the original single-file prototype

The original `Finalised_JPS.html` did everything — NLP classification,
dedup, SLA timers, the "database," and the UI — in one in-browser
JavaScript file with a `let complaints = []` array that reset on every
page load. This version splits that into:

| Layer | Where | Notes |
|---|---|---|
| Database | `data/jps.sqlite` | Real SQLite tables: `complaints`, `history`, `responses`, `officers`, `sessions`. Survives restarts. |
| Backend / API | `server.js`, `db.js`, `lib/` | Classifier, dedup, and SLA math are **re-run server-side** on every request — a modified client can't spoof its own department, severity, or "not a duplicate." |
| Frontend | `public/index.html`, `public/app.js` | Same look, tabs, camera/EXIF capture, voice input, and map as the original — now calling the REST API below instead of touching an in-memory array. |

## Data model

- **complaints** — text, category, department, severity, status, escalation
  level, lat/lon, address, photo path, support (duplicate) count, SLA
  deadlines, timestamps. The citizen's contact info is stored but never
  returned by any API response — it's write-only, for internal follow-up.
- **history** — an append-only audit trail per complaint (who did what,
  when).
- **responses** — officer updates and resolution messages, shown on the
  public register.
- **officers** — one row per `<department>-L<1|2|3>` demo account
  (password `password123` for all, hashed with scrypt — never stored or
  returned in plaintext).
- **sessions** — bearer tokens issued on login, expire after 8 hours.

A complaint's **secret key** (needed to confirm a fix) is shown to the
citizen exactly once, at submission time, and only its scrypt hash is
stored — the server can verify it later but can't display it again,
same as a password.

## REST API

All responses are JSON. Public endpoints need no auth; officer endpoints
require `Authorization: Bearer <token>` from `/api/officers/login`.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/meta` | – | Departments, escalation-level names, SLA labels, status list |
| `POST /api/complaints` | – | File a complaint: `{text, lat, lon, address?, contact?, photo}` (photo is a base64 data URL). Returns `{duplicate, complaint, secret_key}` — `secret_key` only on first filing. |
| `GET /api/complaints?q=&department=&status=` | – | Public register / board, filterable, sorted by support count then recency |
| `GET /api/complaints/:ref` | – | Look up one complaint by tracking code (or numeric id) |
| `POST /api/complaints/:ref/confirm` | – | `{secret_key, satisfied, comment?}` — citizen closes or reopens a resolved complaint |
| `GET /api/officers/roster` | – | Demo usernames per department/level (no passwords) |
| `POST /api/officers/login` | – | `{username, password}` → `{token, officer}` |
| `POST /api/officers/logout` | officer | Invalidate the current token |
| `GET /api/officers/me` | officer | Current officer's identity |
| `GET /api/officers/me/queue` | officer | Open complaints in their department + escalation level |
| `POST /api/complaints/:id/respond` | officer (own queue) | `{message}` — publish an update |
| `POST /api/complaints/:id/resolve` | officer (own queue) | `{message}` — mark resolved, awaiting citizen confirmation |
| `POST /api/admin/sweep` | officer | Manually trigger the escalation sweep (also runs automatically every 20s) |
| `POST /api/admin/reset-demo` | – | Wipes and reseeds demo data — **remove or protect this route before any real deployment** |

## Going to production

This ships configured as a runnable demo, matching the original
prototype's behavior. Before using it for anything real:

1. **SLA units** — `lib/sla.js` uses *seconds* as a compressed demo scale
   so escalation is visible within a minute or two. Change `SEVERITY_SLA`
   to real hours/days and lengthen `SWEEP_INTERVAL_MS` in `server.js`
   (e.g. every few minutes) once you do.
2. **Remove or lock down `/api/admin/reset-demo`** — it wipes every
   complaint. It's public here purely to mirror the original demo button.
3. **Officer passwords** — everyone starts on `password123`. Add a
   password-change flow before real officers use these accounts.
4. **HTTPS + a real reverse proxy** (nginx/Caddy) in front of this if
   exposing it beyond localhost — the built-in server here is plain HTTP.
5. **Contact info** — currently stored but unused; wire it up to real
   SMS/email notifications if you want citizens proactively notified of
   updates rather than having to check the tracking page.
