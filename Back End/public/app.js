'use strict';
/* =====================================================================
   Jan Prashasan Setu — client
   Talks to the real backend (server.js + SQLite) over the REST API
   defined in /api/*. The server always re-classifies, re-checks
   duplicates, and re-computes SLAs itself — nothing here is trusted
   for those decisions. This file only handles UI wiring, the camera /
   EXIF / voice-input browser APIs, and rendering server responses.
   ===================================================================== */

const API = ''; // same-origin

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const token = sessionStorage.getItem('jps_officer_token');
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ---- a lightweight LOCAL copy of the classifier, for the instant
   "AI PREDICTION" hint only while the citizen is typing. The server
   re-classifies authoritatively on submit, so this copy never needs to
   be perfectly in sync — it's just a preview. ---- */
const CATEGORY_TO_DEPARTMENT = {
  'Roads & Infrastructure': 'Public Works (Roads)', 'Water Supply': 'Water Supply Board',
  Electricity: 'Electricity Board', 'Sanitation & Garbage': 'Municipal Sanitation',
  'Street Lighting': 'Electricity Board', 'Public Health': 'Health Department',
  'Public Safety': 'Police / Public Safety', 'Corruption / Misconduct': 'Vigilance / Anti-Corruption',
  Other: 'General Administration',
};
const HIGH_SEV = ['accident', 'fire', 'collapse', 'collapsed', 'spark', 'sparking', 'electrocut', 'life', 'death', 'died', 'danger', 'dangerous', 'hazard', 'outbreak', 'disease', 'attack', 'unsafe', 'children', 'school', 'hospital', 'bribe', 'gas leak', 'exposed wire', 'live wire', 'flood', 'drowning', 'emergency'];
const MED_SEV = ['weeks', 'days', 'overflow', 'leak', 'leaking', 'broken', 'not working', 'no water', 'no power', 'outage', 'garbage', 'smell', 'mosquito'];
const CATEGORY_KEYWORDS = {
  'Roads & Infrastructure': ['pothole', 'sadak', 'footpath', 'gaddha', 'speed breaker', 'road collapse', 'road is broken', 'broken road', 'cracked road', 'damaged road'],
  'Water Supply': ['water', 'paani', 'pipeline', 'tanker', 'tap', 'drinking water'],
  Electricity: ['power', 'electric', 'bijli', 'transformer', 'wire', 'voltage', 'current'],
  'Sanitation & Garbage': ['garbage', 'kachra', 'drain', 'drainage', 'sewage', 'toilet', 'waste'],
  'Street Lighting': ['street light', 'streetlight', 'lamp post', 'street lamp'],
  'Public Health': ['hospital', 'clinic', 'doctor', 'disease', 'dengue', 'mosquito', 'adulterat'],
  'Public Safety': ['traffic', 'signal', 'fire', 'unsafe', 'attack', 'stray dog', 'eve teasing', 'harassment'],
  'Corruption / Misconduct': ['bribe', 'corrupt', 'illegal money', 'demanding money'],
};
function localClassify(text) {
  const t = text.toLowerCase();
  const scores = {}; for (const c in CATEGORY_KEYWORDS) scores[c] = 0;
  for (const cat in CATEGORY_KEYWORDS) for (const kw of CATEGORY_KEYWORDS[cat]) if (t.includes(kw)) scores[cat]++;
  const top = Math.max(...Object.values(scores));
  const kwCat = top === 0 ? null : Object.keys(scores).find((c) => scores[c] === top);
  const finalCategory = kwCat || 'Other';
  let score = 0;
  for (const kw of HIGH_SEV) if (t.includes(kw)) score += 3;
  for (const kw of MED_SEV) if (t.includes(kw)) score += 1;
  const severity = score >= 5 ? 'Critical' : score >= 3 ? 'High' : score >= 1 ? 'Medium' : 'Low';
  return { category: finalCategory, department: CATEGORY_TO_DEPARTMENT[finalCategory], severity, needs_human_review: !kwCat };
}

/* ---- global state populated from /api/meta ---- */
let META = { departments: [], level_names: [], sla_labels: {}, statuses: [] };
function slaLabel(sev, kind) { return (META.sla_labels[sev] && META.sla_labels[sev][kind]) || '—'; }

let currentOfficer = null; // { id, username, department, level }

/* ---- generic helpers ---- */
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function statusLabel(s) { return s.replace(/-/g, ' '); }
function flash(container, msg, kind) {
  container.innerHTML = `<div class="flash ${kind}">${msg}</div>`;
  setTimeout(() => { if (container.firstChild) container.innerHTML = ''; }, 9000);
}

/* ---- tabs ---- */
document.querySelectorAll('nav.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'file' && map) setTimeout(() => map.invalidateSize(), 150);
    if (btn.dataset.view === 'board') renderBoard();
    if (btn.dataset.view === 'officer' && currentOfficer) renderOfficerDashboard();
  });
});

/* ---- dateline ---- */
document.getElementById('dateline').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

/* ---- map display (view-only — pin is set exclusively via the photo's EXIF geotag) ---- */
let pickedLat = null, pickedLon = null, marker = null;
const map = L.map('map-picker').setView([22.9734, 78.6569], 4.6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
document.getElementById('map-picker').style.cursor = 'default';

/* ---- photo capture (compulsory) + geotag extraction from EXIF ---- */
let pickedPhoto = null;
const photoInput = document.getElementById('photo-input');
const photoPreview = document.getElementById('photo-preview');
const photoClearBtn = document.getElementById('photo-clear-btn');
const photoHintEl = document.getElementById('photo-hint');
const geoStatusEl = document.getElementById('geo-status');

function dmsToDecimal(dms, ref) {
  const decimal = dms[0] + dms[1] / 60 + dms[2] / 3600;
  return (ref === 'S' || ref === 'W') ? -decimal : decimal;
}
function placePin(lat, lon, label) {
  pickedLat = lat; pickedLon = lon;
  if (marker) marker.remove();
  marker = L.marker([lat, lon]).addTo(map);
  map.setView([lat, lon], 16);
  document.getElementById('latlon-readout').textContent = `Pinned: [${lat.toFixed(4)}, ${lon.toFixed(4)}]${label ? ' · ' + label : ''}`;
}
function readPhotoGeotag(file) {
  geoStatusEl.textContent = 'Reading location data embedded in the photo…';
  if (typeof EXIF === 'undefined') { geoStatusEl.textContent = 'Could not read photo location data (EXIF reader unavailable).'; return; }
  EXIF.getData(file, function () {
    const latDms = EXIF.getTag(this, 'GPSLatitude');
    const latRef = EXIF.getTag(this, 'GPSLatitudeRef');
    const lonDms = EXIF.getTag(this, 'GPSLongitude');
    const lonRef = EXIF.getTag(this, 'GPSLongitudeRef');
    if (latDms && lonDms) {
      const lat = dmsToDecimal(latDms, latRef);
      const lon = dmsToDecimal(lonDms, lonRef);
      placePin(lat, lon, 'From photo geotag');
      geoStatusEl.textContent = "Location pinned automatically from the photo's GPS data.";
    } else {
      geoStatusEl.textContent = 'This photo has no embedded GPS data. Please enable location tagging in your camera app and attach a geotagged photo.';
    }
  });
}
photoInput.addEventListener('change', () => {
  const file = photoInput.files && photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    pickedPhoto = e.target.result;
    photoPreview.src = pickedPhoto;
    photoPreview.style.display = 'inline-block';
    photoClearBtn.style.display = 'inline-block';
    photoHintEl.textContent = 'Photo attached ✓';
    photoHintEl.style.color = 'var(--green)';
  };
  reader.readAsDataURL(file);
  readPhotoGeotag(file);
});
photoClearBtn.addEventListener('click', () => resetPhotoField());
function resetPhotoField() {
  pickedPhoto = null;
  photoInput.value = '';
  photoPreview.src = '';
  photoPreview.style.display = 'none';
  photoClearBtn.style.display = 'none';
  photoHintEl.textContent = 'A live photo is compulsory for every complaint — it opens your camera directly on a phone. Keep location tagging enabled in your camera app: we read the GPS coordinates embedded in the photo to pin your location below, so this helps officers verify the issue and speeds up resolution.';
  photoHintEl.style.color = '';
  pickedLat = null; pickedLon = null;
  if (marker) { marker.remove(); marker = null; }
  document.getElementById('latlon-readout').textContent = '';
  geoStatusEl.textContent = '';
}

/* ---- voice-to-text for problem description ---- */
(function () {
  const voiceBtn = document.getElementById('voice-input-btn');
  const voiceStatus = document.getElementById('voice-status');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceBtn.disabled = true; voiceBtn.style.opacity = '.4'; voiceBtn.style.cursor = 'not-allowed';
    voiceBtn.title = 'Voice input is not supported in this browser';
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.continuous = false; recognition.interimResults = true; recognition.lang = 'en-IN';
  let listening = false;
  recognition.addEventListener('start', () => {
    listening = true;
    voiceBtn.style.background = '#DC2626'; voiceBtn.style.borderColor = '#DC2626'; voiceBtn.style.color = 'white';
    voiceStatus.textContent = 'Listening… speak your complaint now.';
  });
  recognition.addEventListener('result', (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    descEl.value = transcript;
    descEl.dispatchEvent(new Event('input'));
  });
  recognition.addEventListener('error', (e) => { voiceStatus.textContent = 'Voice input error: ' + e.error + '. You can type instead.'; });
  function stopListeningUI() {
    listening = false;
    voiceBtn.style.background = 'var(--white)'; voiceBtn.style.borderColor = 'var(--navy)'; voiceBtn.style.color = 'var(--navy)';
    if (voiceStatus.textContent.startsWith('Listening')) voiceStatus.textContent = 'Stopped listening.';
  }
  recognition.addEventListener('end', stopListeningUI);
  voiceBtn.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    try { recognition.start(); } catch (err) { voiceStatus.textContent = 'Could not start voice input: ' + err.message; }
  });
})();

/* ---- live classify hint (local preview only — server re-classifies on submit) ---- */
const descEl = document.getElementById('desc');
let classifyTimer;
descEl.addEventListener('input', () => {
  clearTimeout(classifyTimer);
  classifyTimer = setTimeout(() => {
    const t = descEl.value.trim();
    const hintEl = document.getElementById('classify-hint');
    if (!t) { hintEl.textContent = ''; return; }
    const r = localClassify(t);
    hintEl.innerHTML = `AI PREDICTION: <span style="color:var(--ink);">${r.department}</span>  ·  SEVERITY: <span style="color:var(--ink);">${r.severity}</span>${r.needs_human_review ? ' <span style="color:var(--saffron);">(Low Confidence - Flagged for Review)</span>' : ''}  ·  TARGET RESPONSE: <span style="color:var(--ink);">${slaLabel(r.severity, 'resp')}</span>  ·  TARGET RESOLUTION: <span style="color:var(--ink);">${slaLabel(r.severity, 'res')}</span>`;
  }, 350);
});

/* ---- My Profile / tracker (kept in localStorage, same as the original — this
   is just a device-local convenience list of ref codes, not an account) ---- */
let myComplaints = JSON.parse(localStorage.getItem('my_jps_complaints') || '[]');

async function renderMyProfile() {
  const badge = document.getElementById('my-complaints-badge');
  const list = document.getElementById('my-complaints-list');
  if (myComplaints.length === 0) {
    badge.style.display = 'none';
    list.innerHTML = '<div style="color:var(--ink-soft); font-style:italic; padding:10px 0;">No complaints submitted from this device yet.</div>';
    return;
  }
  const results = await Promise.all(myComplaints.map((ref) => api(`/api/complaints/${encodeURIComponent(ref)}`).catch(() => null)));
  const active = results.filter(Boolean);
  myComplaints = active.map((c) => c.anon_ref);
  localStorage.setItem('my_jps_complaints', JSON.stringify(myComplaints));

  const needsActionCount = active.filter((c) => c.status === 'Resolved-Pending-Confirmation').length;
  if (active.length > 0) {
    badge.style.display = 'inline-block';
    badge.textContent = needsActionCount > 0 ? needsActionCount : active.length;
    badge.style.background = needsActionCount > 0 ? '#DC2626' : 'var(--navy)';
  } else {
    badge.style.display = 'none';
  }
  list.innerHTML = active.map((c) => {
    const isResolved = c.status === 'Resolved-Pending-Confirmation';
    const textSnippet = c.text.length > 70 ? c.text.slice(0, 70) + '…' : c.text;
    return `
        <div class="profile-item">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="padding-right:12px;">
              <strong class="mono" style="color:var(--navy); font-size:14px;">${c.anon_ref}</strong><br>
              <span style="font-size:12.5px; color:var(--ink-soft); line-height:1.3; display:inline-block; margin-top:4px;">"${textSnippet}"</span>
            </div>
            <span class="stamp ${c.status}" style="font-size:10px; padding:2px 6px; white-space:nowrap;">${statusLabel(c.status)}</span>
          </div>
          ${isResolved ? `
            <div style="background:#e8f5e9; padding:10px 12px; border-radius:8px; border:1px solid #c8e6c9; display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
              <span style="font-size:12px; color:var(--green); font-weight:600;">Action Required: Verify Fix</span>
              <button class="btn green" style="padding:6px 14px; font-size:12px; box-shadow:none;" onclick="quickTrack('${c.anon_ref}')">Verify Now</button>
            </div>
          ` : `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
              <span style="font-size:11px; color:var(--ink-soft); font-family:'JetBrains Mono', monospace;">Updated: ${new Date(c.history[c.history.length - 1].ts).toLocaleDateString()}</span>
              <button class="btn secondary" style="padding:6px 14px; font-size:12px;" onclick="quickTrack('${c.anon_ref}')">View Details</button>
            </div>
          `}
        </div>`;
  }).join('');
}
window.quickTrack = function (ref) {
  document.getElementById('my-profile-dropdown').style.display = 'none';
  document.querySelector('nav.tabs button[data-view="track"]').click();
  document.getElementById('track-ref').value = ref;
  doTrack();
};
document.getElementById('my-profile-btn').addEventListener('click', (e) => {
  const dd = document.getElementById('my-profile-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  renderMyProfile();
  e.stopPropagation();
});
document.addEventListener('click', () => { const dd = document.getElementById('my-profile-dropdown'); if (dd) dd.style.display = 'none'; });
document.getElementById('my-profile-dropdown').addEventListener('click', (e) => e.stopPropagation());

/* ---- submit complaint ---- */
document.getElementById('submit-btn').addEventListener('click', async () => {
  const flashEl = document.getElementById('flash-file');
  const text = descEl.value.trim();
  if (!text) { flash(flashEl, 'Please describe the problem before submitting.', 'error'); return; }
  if (!pickedPhoto) { flash(flashEl, 'A live photo of the problem is compulsory. Please attach one before submitting.', 'error'); return; }
  if (pickedLat == null) { flash(flashEl, "We couldn't find location data in your photo. Please attach a geotagged photo (with location tagging enabled in your camera app) so we can route this correctly and avoid duplicates.", 'error'); return; }
  const address = document.getElementById('address').value.trim();
  const contact = document.getElementById('contact').value.trim() || null;
  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
  try {
    const result = await api('/api/complaints', {
      method: 'POST',
      body: JSON.stringify({ text, lat: pickedLat, lon: pickedLon, address, contact, photo: pickedPhoto }),
    });
    const { duplicate, complaint, secret_key } = result;
    if (duplicate) {
      flash(flashEl, `This looks like an existing reported issue nearby. We've added your report as additional support to complaint <span class="ref-chip">${complaint.anon_ref}</span> (now reported by ${complaint.support_count} citizens), which boosts its priority.`, 'info');
    } else {
      myComplaints.push(complaint.anon_ref);
      localStorage.setItem('my_jps_complaints', JSON.stringify(myComplaints));
      renderMyProfile();
      flash(flashEl, `Complaint registered! Routed to <strong>${complaint.department}</strong> (Priority: ${complaint.severity}). Response due within <strong>${slaLabel(complaint.severity, 'resp')}</strong>, resolution within <strong>${slaLabel(complaint.severity, 'res')}</strong>. <br><br><strong>SAVE YOUR TRACKING CODE & SECRET KEY:</strong> <span class="mono bg-white px-2 py-1 rounded" style="color:var(--navy); font-size:16px;">${complaint.anon_ref} / ${secret_key}</span> <br><span style="font-size:12.5px;">(The secret key is shown once and is required to confirm the fix later — write it down.)</span>`, 'success');
    }
    descEl.value = ''; document.getElementById('address').value = ''; document.getElementById('contact').value = '';
    document.getElementById('classify-hint').textContent = '';
    document.getElementById('track-ref').value = complaint.anon_ref;
    resetPhotoField();
  } catch (err) {
    flash(flashEl, `Could not submit complaint: ${err.body?.error || err.message}`, 'error');
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = 'Process via AI & Submit';
  }
});

/* ---- shared complaint-card renderer (track view + officer detail view) ---- */
function renderComplaintCard(c, opts = {}) {
  const showConfirm = opts.showConfirm;
  let html = `<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:baseline; margin-bottom:16px;">
    <div><span class="ref-chip" style="font-size:15px; padding:6px 12px;">${c.anon_ref}</span> <span class="stamp ${c.status}" style="margin-left:12px; font-size:13px;">${statusLabel(c.status)}</span></div>
    <div class="severity sev-${c.severity}" style="font-size:16px;">${c.severity} Priority</div>
  </div>
  <p style="margin:16px 0 10px; font-size:16px; color:var(--ink);">${c.text}</p>
  <div class="complaint-meta" style="background:rgba(0,0,0,0.02); padding:12px; border-radius:8px; display:inline-block; border:1px solid var(--line);">
    <strong>Dept:</strong> ${c.department} &nbsp;·&nbsp; <strong>Category:</strong> ${c.category} &nbsp;·&nbsp; <strong>Location:</strong> ${c.address || 'Map Pin'} &nbsp;·&nbsp; <strong>Support:</strong> ${c.support_count} citizen${c.support_count > 1 ? 's' : ''} &nbsp;·&nbsp; <strong>Level:</strong> ${c.level_name}
  </div>
  <div class="complaint-meta" style="margin-top:8px;">
    <strong>Severity:</strong> <span class="severity sev-${c.severity}">${c.severity}</span> &nbsp;·&nbsp; <strong>Response due within:</strong> ${slaLabel(c.severity, 'resp')} &nbsp;·&nbsp; <strong>Resolution due within:</strong> ${slaLabel(c.severity, 'res')}
  </div>
  ${c.photo_url ? `<div style="margin-top:18px;"><img src="${c.photo_url}" alt="Attached photo evidence" style="max-width:100%; max-height:340px; border-radius:12px; border:1px solid var(--line); box-shadow:0 4px 10px rgba(0,0,0,.08);"></div>` : ''}`;
  if (c.responses.length) {
    html += `<h4 style="margin-top:32px; font-size:18px;">Official Responses</h4>`;
    for (const r of c.responses) {
      html += `<div class="response-item ${r.type}"><strong>${r.type === 'resolution' ? 'Resolution' : 'Update'} from ${r.by}</strong> · <span style="color:var(--ink-soft); font-size:13px;">${fmtTime(r.at)}</span><br><span style="color:var(--ink); font-weight:500;">${r.message}</span></div>`;
    }
  }
  html += `<h4 style="margin-top:32px; font-size:18px;">Audit Trail</h4><div style="background:rgba(255,255,255,0.5); padding:16px; border-radius:12px; border:1px solid var(--line);">`;
  for (const h of c.history) {
    html += `<div class="history-item"><div class="history-dot"></div><div><strong>${h.action}</strong> — <span class="mono" style="font-size:12px; color:var(--ink-soft);">${fmtTime(h.ts)}</span><br><span style="color:var(--ink-soft)">${h.note}</span></div></div>`;
  }
  html += `</div>`;
  if (showConfirm && c.status === 'Resolved-Pending-Confirmation') {
    html += `<div style="margin-top:32px;border-top:1px solid var(--line);padding-top:24px;">
      <h4 style="color:var(--green); font-size:20px;">Confirm Resolution</h4>
      <p style="margin-bottom:16px; color:var(--ink-soft);">The department has marked this as resolved. Please confirm to officially close the ticket.</p>
      <label>Secret Key</label>
      <input type="text" id="confirm-secret" placeholder="Enter your secret key to verify identity" class="mono">
      <label>Comment (optional)</label>
      <textarea id="confirm-comment" style="min-height:80px;"></textarea>
      <div style="margin-top:16px;display:flex;gap:12px;">
        <button class="btn green" id="confirm-yes">Yes, resolved — Close Ticket</button>
        <button class="btn secondary" id="confirm-no" style="border-color:#DC2626; color:#DC2626;">Not fixed — Reopen Ticket</button>
      </div>
      <div id="confirm-flash" style="margin-top:16px;"></div>
    </div>`;
  }
  return html;
}

/* ---- track ---- */
document.getElementById('track-btn').addEventListener('click', doTrack);
document.getElementById('track-ref').addEventListener('keydown', (e) => { if (e.key === 'Enter') doTrack(); });
async function doTrack() {
  const ref = document.getElementById('track-ref').value.trim().toUpperCase();
  const resultEl = document.getElementById('track-result');
  if (!ref) return;
  let c;
  try { c = await api(`/api/complaints/${encodeURIComponent(ref)}`); }
  catch { resultEl.innerHTML = `<div class="flash error">No complaint found with that tracking code. Please check and try again.</div>`; return; }
  resultEl.innerHTML = `<div style="padding-top:16px; border-top:2px solid var(--line);">${renderComplaintCard(c, { showConfirm: true })}</div>`;
  const yes = document.getElementById('confirm-yes'), no = document.getElementById('confirm-no');
  if (yes) yes.addEventListener('click', () => doConfirm(ref, true));
  if (no) no.addEventListener('click', () => doConfirm(ref, false));
}
async function doConfirm(ref, satisfied) {
  const secret = document.getElementById('confirm-secret').value;
  const flashEl = document.getElementById('confirm-flash');
  const comment = document.getElementById('confirm-comment').value;
  try {
    await api(`/api/complaints/${encodeURIComponent(ref)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ secret_key: secret, satisfied, comment }),
    });
    doTrack();
    renderBoard();
    renderMyProfile();
  } catch (err) {
    const msg = err.body?.error === 'bad_secret' ? 'Secret key does not match our records for this complaint.' : (err.body?.error || err.message);
    flash(flashEl, msg, 'error');
  }
}

/* ---- board (public register) ---- */
const deptSelect = document.getElementById('board-dept');
['board-q', 'board-dept', 'board-status'].forEach((id) => document.getElementById(id).addEventListener('input', renderBoard));

async function renderBoard() {
  const q = document.getElementById('board-q').value.trim();
  const dept = document.getElementById('board-dept').value;
  const status = document.getElementById('board-status').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (dept) params.set('department', dept);
  if (status) params.set('status', status);
  const list = await api(`/api/complaints?${params.toString()}`);
  const el = document.getElementById('board-list');
  if (!list.length) { el.innerHTML = `<div class="empty-state">No complaints match these filters yet.</div>`; return; }
  el.innerHTML = list.map((c) => `
    <div class="complaint-row">
      <div class="complaint-main">
        <span class="ref-chip">${c.anon_ref}</span>
        <span class="severity sev-${c.severity}" style="margin-left:12px;font-size:13.5px;">${c.severity}</span>
        <p style="margin:10px 0 6px; font-weight:500; font-size:15px; color:var(--ink);">${c.text.length > 120 ? c.text.slice(0, 120) + '…' : c.text}</p>
        <div class="complaint-meta"><strong>${c.department}</strong> · ${c.address || 'Map Pin'} · ${c.support_count} report${c.support_count > 1 ? 's' : ''}${c.photo_url ? ' · 📷 Photo attached' : ''}</div>
      </div>
      <div class="complaint-side">
        <span class="stamp ${c.status}">${statusLabel(c.status)}</span>
        <button class="btn secondary" style="padding:6px 16px;font-size:13px;" onclick="viewBoardDetail('${c.anon_ref}')">View Details</button>
      </div>
    </div>`).join('');
}
window.viewBoardDetail = async function (ref) {
  const c = await api(`/api/complaints/${encodeURIComponent(ref)}`);
  const el = document.getElementById('board-list');
  el.innerHTML = `<button class="btn secondary" style="margin-bottom:24px;" onclick="renderBoard()">← Back to Register</button>` + renderComplaintCard(c);
};

/* ---- officer login/dashboard ---- */
document.getElementById('off-login-btn').addEventListener('click', async () => {
  const u = document.getElementById('off-user').value.trim();
  const p = document.getElementById('off-pass').value.trim();
  const flashEl = document.getElementById('flash-officer');
  try {
    const { token, officer } = await api('/api/officers/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    sessionStorage.setItem('jps_officer_token', token);
    currentOfficer = officer;
    document.getElementById('officer-login-panel').style.display = 'none';
    document.getElementById('officer-dashboard-panel').style.display = 'block';
    renderOfficerDashboard();
  } catch {
    flash(flashEl, 'Invalid credentials. Use the demo roster below.', 'error');
  }
});
document.getElementById('off-logout-btn').addEventListener('click', async () => {
  try { await api('/api/officers/logout', { method: 'POST' }); } catch { /* ignore */ }
  sessionStorage.removeItem('jps_officer_token');
  currentOfficer = null;
  document.getElementById('officer-dashboard-panel').style.display = 'none';
  document.getElementById('officer-detail-panel').style.display = 'none';
  document.getElementById('officer-login-panel').style.display = 'block';
  document.getElementById('off-user').value = '';
  document.getElementById('off-pass').value = '';
});
document.getElementById('officer-back-btn').addEventListener('click', () => {
  document.getElementById('officer-detail-panel').style.display = 'none';
  document.getElementById('officer-dashboard-panel').style.display = 'block';
  renderOfficerDashboard();
});

async function renderOfficerDashboard() {
  document.getElementById('off-dept-name').textContent = currentOfficer.department;
  document.getElementById('off-level-tag').innerHTML = `<span class="stamp Open" style="margin-left:12px; background:var(--navy); color:white;">${META.level_names[currentOfficer.level]}</span>`;
  const queue = await api('/api/officers/me/queue');
  const el = document.getElementById('officer-queue');
  el.innerHTML = `<div style="margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid var(--line);"><button class="btn secondary" id="sweep-btn" style="font-size:13px; padding:8px 16px;">Force Escalation Sweep</button> <span class="hint" id="sweep-result" style="margin-left:12px; font-weight:600;"></span></div>`;
  if (!queue.length) {
    el.innerHTML += `<div class="empty-state">No open complaints in your queue at this level right now.</div>`;
  } else {
    el.innerHTML += queue.map((c) => `
      <div class="complaint-row">
        <div class="complaint-main">
          <span class="ref-chip">${c.anon_ref}</span>
          <span class="severity sev-${c.severity}" style="margin-left:12px;font-size:13.5px;">${c.severity}</span>
          <p style="margin:10px 0 6px; font-weight:500; font-size:15px; color:var(--ink);">${c.text.length > 120 ? c.text.slice(0, 120) + '…' : c.text}</p>
          <div class="complaint-meta">${c.support_count} report${c.support_count > 1 ? 's' : ''} · ${c.address || 'Map Pin'}${c.photo_url ? ' · 📷 Photo attached' : ''}</div>
        </div>
        <div class="complaint-side">
          <span class="stamp ${c.status}">${statusLabel(c.status)}</span>
          <button class="btn" style="padding:8px 20px;font-size:13.5px;" onclick="openOfficerDetail(${c.id})">Take Action</button>
        </div>
      </div>`).join('');
  }
  document.getElementById('sweep-btn').addEventListener('click', async () => {
    const { escalated } = await api('/api/admin/sweep', { method: 'POST' });
    document.getElementById('sweep-result').textContent = `System check complete: Escalated ${escalated} complaint(s) due to SLA breach.`;
    renderOfficerDashboard(); renderBoard();
  });
}

window.openOfficerDetail = async function (id) {
  document.getElementById('officer-dashboard-panel').style.display = 'none';
  document.getElementById('officer-detail-panel').style.display = 'block';
  const c = await api(`/api/complaints/${id}`); // numeric id, resolved server-side
  renderOfficerDetailBody(c, id);
};
async function renderOfficerDetailBody(c, id) {
  const body = document.getElementById('officer-detail-body');
  body.innerHTML = renderComplaintCard(c) + `
    <div style="margin-top:32px;border-top:1px solid var(--line);padding-top:24px; background:rgba(0,0,0,0.02); padding:24px; border-radius:12px;">
      <h4 style="font-size:20px; color:var(--navy);">Take Official Action</h4>
      <textarea id="off-message" placeholder="e.g., Acknowledged — dispatching team to site." style="min-height:90px; margin-top:12px;"></textarea>
      <div style="margin-top:16px;display:flex;gap:12px;">
        <button class="btn" id="off-respond-btn">Send Update to Citizen</button>
        <button class="btn green" id="off-resolve-btn">Mark as Resolved</button>
      </div>
      <div id="off-detail-flash" style="margin-top:16px;"></div>
    </div>`;
  document.getElementById('off-respond-btn').addEventListener('click', async () => {
    const msg = document.getElementById('off-message').value.trim();
    try {
      const updated = await api(`/api/complaints/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ message: msg }) });
      flash(document.getElementById('off-detail-flash'), 'Response recorded and published to the public register.', 'info');
      renderOfficerDetailBody(updated, id);
    } catch (err) { flash(document.getElementById('off-detail-flash'), err.body?.error || err.message, 'error'); }
  });
  document.getElementById('off-resolve-btn').addEventListener('click', async () => {
    const msg = document.getElementById('off-message').value.trim();
    try {
      const updated = await api(`/api/complaints/${c.id}/resolve`, { method: 'POST', body: JSON.stringify({ message: msg }) });
      flash(document.getElementById('off-detail-flash'), 'Marked as resolved. Awaiting final citizen confirmation.', 'success');
      renderOfficerDetailBody(updated, id);
    } catch (err) { flash(document.getElementById('off-detail-flash'), err.body?.error || err.message, 'error'); }
  });
}

/* ---- reset demo ---- */
document.getElementById('reset-demo-btn').addEventListener('click', async () => {
  await api('/api/admin/reset-demo', { method: 'POST' });
  myComplaints = []; localStorage.setItem('my_jps_complaints', '[]');
  document.getElementById('track-result').innerHTML = '';
  renderAll();
});

function renderAll() {
  renderBoard();
  renderMyProfile();
  if (currentOfficer && document.getElementById('officer-dashboard-panel').style.display !== 'none') renderOfficerDashboard();
}

/* ---- boot ---- */
async function boot() {
  META = await api('/api/meta');
  META.departments.forEach((d) => { const o = document.createElement('option'); o.textContent = d; deptSelect.appendChild(o); });

  const roster = await api('/api/officers/roster');
  const byDept = {};
  roster.forEach((r) => { (byDept[r.department] = byDept[r.department] || [])[r.level] = r.username; });
  const rosterBody = document.getElementById('officer-roster');
  Object.keys(byDept).forEach((d) => {
    const usernames = [0, 1, 2].map((l) => byDept[d][l] || '—').join('<br>');
    rosterBody.innerHTML += `<tr><td style="font-weight:600;">${d}</td><td class="mono" style="font-size:13px; color:var(--navy);">${usernames}</td></tr>`;
  });

  // resume an officer session if one is still valid
  const token = sessionStorage.getItem('jps_officer_token');
  if (token) {
    try {
      currentOfficer = await api('/api/officers/me');
      document.getElementById('officer-login-panel').style.display = 'none';
      document.getElementById('officer-dashboard-panel').style.display = 'block';
    } catch { sessionStorage.removeItem('jps_officer_token'); }
  }

  renderAll();
  // light polling so the board/queue reflect server-side escalation sweeps
  setInterval(() => {
    const boardActive = document.getElementById('view-board').classList.contains('active');
    const officerActive = document.getElementById('view-officer').classList.contains('active');
    if (boardActive) renderBoard();
    if (officerActive && currentOfficer && document.getElementById('officer-dashboard-panel').style.display !== 'none') renderOfficerDashboard();
  }, 15000);
}
boot();
