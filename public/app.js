'use strict';
// ---------------------------------------------------------------------------
//  Lightweight vanilla SPA. Session lives in an httpOnly cookie.
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || 'error'), { data, status: res.status });
  return data;
};

const ROLE_VIEWS = {
  security:   ['lookup', 'issue', 'verify', 'requests'],
  management: ['lookup', 'issue', 'verify', 'requests', 'admin', 'board'],
  board:      ['board'],
};
const VIEW_LABELS = { lookup: 'Lookup', issue: 'Issue Pass', verify: 'Verify', requests: 'Requests', admin: 'Management', board: 'Dashboard' };
let currentUser = null;
let unitIndex = {};   // unit_number -> {kind, business_name}
let regionData = null;

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  const el = $('#view-' + name);
  if (el) el.hidden = false;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'board') loadBoard();
  if (name === 'admin') { loadAudit(); loadAuthAudit(); loadOverrideCode(); loadExportDatasets(); loadYearEnd(); }
  if (name === 'issue') loadUnits();
  if (name === 'requests') loadRequests();
  if (name !== 'verify') stopCamera();
}

async function refreshPendingBadge() {
  try {
    const { pending } = await api('/requests/pending-count');
    const btn = document.querySelector('#nav button[data-view="requests"]');
    if (btn) btn.textContent = VIEW_LABELS.requests + (pending ? ` (${pending})` : '');
  } catch {}
}

function renderNav() {
  const views = ROLE_VIEWS[currentUser.role] || [];
  $('#nav').innerHTML = views.map((v) => `<button data-view="${v}">${VIEW_LABELS[v]}</button>`).join('');
  document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  if (views.includes('requests')) refreshPendingBadge();
  showView(views[0]);
}

async function enterApp(user) {
  currentUser = user;
  $('#topbar').hidden = false;
  $('#view-login').hidden = true;
  $('#whoami').textContent = `${user.name} · ${user.role}`;
  await loadRegions();
  renderNav();
}

// --- Auth ---
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    await enterApp(user);
  } catch { $('#loginError').textContent = 'Invalid credentials'; }
};
$('#logoutBtn').onclick = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch {} location.reload(); };

// --- Reference data ---
async function loadRegions() {
  if (regionData) return;
  regionData = await api('/regions');
  populateRegions();
}
function populateRegions() {
  const country = $('#visitorCountry').value;
  const list = regionData[country] || [];
  $('#visitorRegion').innerHTML = list.map((r) => `<option value="${r.code}">${r.code} — ${r.name}</option>`).join('');
}
$('#visitorCountry').onchange = populateRegions;

async function loadUnits() {
  const rows = await api('/units');
  unitIndex = {};
  const opts = rows.map((r) => {
    unitIndex[r.unit_number] = r;
    const label = r.kind === 'commercial' ? `${r.unit_number} — ${r.business_name || 'Commercial'}` : r.unit_number;
    return `<option value="${r.unit_number}">${label}</option>`;
  }).join('');
  $('#unitList').innerHTML = opts;
}
$('#issueForm').unitNumber.addEventListener('input', (e) => {
  const u = unitIndex[e.target.value.trim()];
  $('#unitHint').textContent = u
    ? (u.kind === 'commercial' ? `Commercial unit — ${u.business_name || ''} (20 passes/yr)` : 'Residential unit (10 passes/yr)')
    : (e.target.value ? '⚠ Not a known unit — issuance will be rejected.' : '');
});

// --- Lookup ---
$('#lookupForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api(`/passes/lookup?by=${f.get('by')}&q=${encodeURIComponent(f.get('q'))}`);
    const reg = r.registeredVehicles.map((v) =>
      `<tr><td>${v.licence_plate}</td><td>${v.unit_number}${v.business_name ? ' · ' + v.business_name : ''}</td><td>${v.resident_name || '—'}</td><td>${v.phone || '—'}</td><td>${[v.color, v.make, v.model].filter(Boolean).join(' ') || '—'}</td></tr>`).join('');
    const passes = r.visitorPasses.map((p) =>
      `<tr><td>${p.unit_number}</td><td>${p.visitor_plate}${p.visitor_region ? ' (' + p.visitor_region.replace('-', ' ') + ')' : ''}</td><td>${p.visitor_name || '—'}</td><td><span class="badge ${p.status === 'active' ? 'VALID' : 'REVOKED'}">${p.status}</span></td><td>${new Date(p.expires_at).toLocaleString()}</td></tr>`).join('');
    $('#lookupResult').innerHTML = `
      <div class="result-card"><h3>Registered vehicles</h3>${reg ? `<table><tr><th>Plate</th><th>Unit</th><th>Resident</th><th>Phone</th><th>Vehicle</th></tr>${reg}</table>` : '<p>None found.</p>'}</div>
      <div class="result-card"><h3>Visitor passes</h3>${passes ? `<table><tr><th>Unit</th><th>Plate</th><th>Visitor</th><th>Status</th><th>Expires</th></tr>${passes}</table>` : '<p>None found.</p>'}</div>`;
  } catch (err) { $('#lookupResult').innerHTML = `<p class="error">${err.message}</p>`; }
};

// --- Issue ---
document.querySelectorAll('#durationRow .dur').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#durationRow .dur').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#durationPreset').value = b.dataset.preset;
  };
});
$('#overrideChk').onchange = (e) => { $('#overrideFields').hidden = !e.target.checked; };
$('#issueForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#issueError').textContent = '';
  const f = new FormData(e.target);
  const body = {
    unitNumber: f.get('unitNumber'),
    visitorFirstName: f.get('visitorFirstName'),
    visitorLastName: f.get('visitorLastName'),
    visitorCountry: f.get('visitorCountry'),
    visitorRegion: f.get('visitorRegion'),
    visitorPlate: f.get('visitorPlate'),
    durationPreset: f.get('durationPreset'),
    override: f.get('override') === 'on',
    overrideCode: f.get('overrideCode'),
    overrideReason: f.get('overrideReason'),
  };
  try {
    const r = await api('/passes', { method: 'POST', body });
    const q = r.quota || {};
    $('#issueResult').innerHTML = `
      <div class="result-card">
        <h3>Pass issued ${r.usedOverride ? '(override used)' : ''}</h3>
        <p>Unit <b>${r.unitNumber}</b> (${r.kind}) · Plate <b>${r.visitorPlate}</b> · ${r.visitorName || 'visitor'}</p>
        <p>Expires: <b>${new Date(r.expiresAt).toLocaleString()}</b></p>
        <p>Verification code: <b style="font-family:monospace;font-size:18px">${r.shortCode}</b></p>
        <p>${q.unlimited ? 'Commercial: unlimited' : `Quota this year: ${q.used}/${q.limit} used`}</p>
        <a href="${r.printUrl}" target="_blank"><button type="button">🖨 Open printable pass</button></a>
      </div>`;
    e.target.reset();
    $('#overrideFields').hidden = true;
    $('#durationPreset').value = 'today';
    document.querySelectorAll('#durationRow .dur').forEach((x, i) => x.classList.toggle('active', i === 0));
    populateRegions();
  } catch (err) {
    if (err.data?.error === 'quota_exceeded') {
      const qd = err.data.quota || {};
      $('#issueError').innerHTML = `Quota reached (${qd.used}/${qd.limit}). Tick "Quota override" and enter this week's code (from Management) to proceed.`;
    } else {
      $('#issueError').textContent = err.message;
    }
  }
};

// --- Verify: camera ---
let camStream = null, camRAF = null;
function stopCamera() {
  if (camRAF) cancelAnimationFrame(camRAF), (camRAF = null);
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  $('#scanVideo').hidden = true;
  $('#scanStart').hidden = false;
  $('#scanStop').hidden = true;
}
$('#scanStart').onclick = async () => {
  $('#scanStatus').textContent = '';
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    $('#scanStatus').innerHTML = `<span class="error">Camera unavailable (${err.name}). Over a plain-HTTP network connection browsers block the camera — use the printed code instead.</span>`;
    return;
  }
  const video = $('#scanVideo');
  video.srcObject = camStream;
  video.hidden = false;
  $('#scanStart').hidden = true;
  $('#scanStop').hidden = false;
  await video.play();
  const canvas = $('#scanCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (!camStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height);
      if (code && code.data) {
        stopCamera();
        $('#scanStatus').textContent = 'QR detected — verifying…';
        await doVerify({ token: code.data });
        return;
      }
    }
    camRAF = requestAnimationFrame(tick);
  };
  camRAF = requestAnimationFrame(tick);
};
$('#scanStop').onclick = stopCamera;

// --- Verify: short code + token ---
$('#shortForm').onsubmit = (e) => { e.preventDefault(); doVerify({ shortCode: new FormData(e.target).get('shortCode') }); };
$('#verifyForm').onsubmit = (e) => { e.preventDefault(); doVerify({ token: new FormData(e.target).get('token') }); };

async function doVerify(body) {
  try {
    const r = await api('/verify', { method: 'POST', body });
    const detail = r.pass ? `
      <p>Unit <b>${r.pass.unit_number}</b> (${r.pass.kind || ''}) · Plate <b>${r.pass.visitor_plate}</b>${r.pass.visitor_region ? ' (' + r.pass.visitor_region.replace('-', ' ') + ')' : ''}</p>
      <p>Visitor: ${r.pass.visitor_name || '—'}</p>
      <p>Expires: ${new Date(r.pass.expires_at).toLocaleString()}</p>
      ${r.verdict === 'VALID' ? `<button type="button" data-action="revoke" data-id="${r.pass.id}">Revoke this pass</button>` : ''}` : `<p>Reason: ${r.reason}</p>`;
    $('#verifyResult').innerHTML = `<div class="result-card"><span class="badge ${r.verdict}">${r.verdict}</span>${detail}</div>`;
  } catch (err) { $('#verifyResult').innerHTML = `<p class="error">${err.message}</p>`; }
}
$('#verifyResult').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="revoke"]');
  if (!btn) return;
  await api(`/passes/${btn.dataset.id}/revoke`, { method: 'POST' });
  alert('Pass revoked.');
});

// --- Admin ---
$('#unitKind').onchange = (e) => { $('#commercialFields').hidden = e.target.value !== 'commercial'; };
$('#userForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/admin/users', { method: 'POST', body: { username: f.get('username'), fullName: f.get('fullName'), role: f.get('role'), password: f.get('password') } });
    $('#userMsg').textContent = 'User created.'; e.target.reset();
  } catch (err) { $('#userMsg').textContent = err.message; }
};
$('#unitForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/admin/units', { method: 'POST', body: {
      unitNumber: f.get('unitNumber'), floor: f.get('floor'), kind: f.get('kind'),
      businessName: f.get('businessName'), businessContact: f.get('businessContact'),
    } });
    $('#unitMsg').textContent = 'Unit added.'; e.target.reset();
    $('#commercialFields').hidden = true;
  } catch (err) { $('#unitMsg').textContent = err.message; }
};
async function loadOverrideCode() {
  try {
    const r = await api('/admin/override-code');
    $('#overrideCodeBox').innerHTML = `<div class="stat" style="max-width:260px"><div class="n" style="font-family:monospace">${r.current.code}</div><div class="l">${r.current.week}</div></div>`;
  } catch { $('#overrideCodeBox').textContent = 'Unavailable.'; }
}
$('#refreshAudit').onclick = loadAudit;
async function loadAudit() {
  const rows = await api('/admin/audit?limit=100');
  $('#auditTable').innerHTML = `<table><tr><th>Time</th><th>Action</th><th>Actor</th><th>Unit</th><th>Plate</th></tr>` +
    rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${r.action}</td><td>${r.actor_name || '—'} ${r.actor_role ? '(' + r.actor_role + ')' : ''}</td><td>${r.unit_number || '—'}</td><td>${r.visitor_plate || '—'}</td></tr>`).join('') + `</table>`;
}
$('#refreshAuthAudit').onclick = loadAuthAudit;
async function loadAuthAudit() {
  const rows = await api('/admin/auth-audit?limit=100');
  $('#authAuditTable').innerHTML = `<table><tr><th>Time</th><th>Event</th><th>User</th><th>IP</th></tr>` +
    rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td><span class="badge ${r.success ? 'VALID' : 'REVOKED'}">${r.event}</span></td><td>${r.actor_name || r.username} ${r.actor_role ? '(' + r.actor_role + ')' : ''}</td><td>${r.ip || '—'}</td></tr>`).join('') + `</table>`;
}

// --- Resident requests (staff review) ---
$('#refreshRequests').onclick = loadRequests;
async function loadRequests() {
  const rows = await api('/requests?status=pending');
  if (!rows.length) { $('#requestsList').innerHTML = '<p>No pending requests.</p>'; refreshPendingBadge(); return; }
  $('#requestsList').innerHTML = rows.map((r) => {
    const name = [r.visitor_first_name, r.visitor_last_name].filter(Boolean).join(' ') || '—';
    const dur = r.duration_preset === 'tomorrow_noon' ? 'Until noon tomorrow' : 'Rest of today';
    return `<div class="result-card" data-id="${r.id}">
      <h3>Unit ${r.unit_number} ${r.kind === 'commercial' ? '(commercial)' : ''}</h3>
      <p>Requested by <b>${r.requester_name}</b>${r.requester_contact ? ' · ' + r.requester_contact : ''} · ${new Date(r.created_at).toLocaleString()}</p>
      <p>Visitor <b>${name}</b> · Plate <b>${r.visitor_plate}</b>${r.visitor_region ? ' (' + r.visitor_region.replace('-', ' ') + ')' : ''} · ${dur}</p>
      ${r.note ? `<p>Note: ${r.note}</p>` : ''}
      <div class="btn-row">
        <button type="button" data-action="approve" data-id="${r.id}">Approve &amp; issue</button>
        <button type="button" class="danger" data-action="deny" data-id="${r.id}">Deny</button>
      </div>
      <p class="msg" id="reqmsg-${r.id}"></p>
    </div>`;
  }).join('');
}
// Event delegation — inline onclick attributes are blocked by CSP
// (script-src-attr 'none'), so dynamically-rendered buttons bind here.
$('#requestsList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'approve') approveRequest(btn.dataset.id);
  if (btn.dataset.action === 'deny') denyRequest(btn.dataset.id);
});
async function approveRequest(id) {
  const msg = $(`#reqmsg-${id}`);
  try {
    const r = await api(`/requests/${id}/approve`, { method: 'POST', body: {} });
    const mail = r.emailed ? ' · emailed to resident' : (r.emailConfigured ? '' : ' · (email not configured)');
    msg.innerHTML = `✓ Approved. Code <b>${r.shortCode}</b>. <a href="${r.printUrl}" target="_blank">Print pass</a>${mail}`;
    setTimeout(loadRequests, 1800);
  } catch (err) {
    if (err.data?.error === 'quota_exceeded') {
      const code = prompt("This unit is at its quota. Enter this week's override code to approve anyway (or Cancel):");
      if (!code) { msg.textContent = 'Not approved (unit at quota).'; return; }
      const reason = prompt('Override reason:') || 'staff override';
      try {
        const r2 = await api(`/requests/${id}/approve`, { method: 'POST', body: { override: true, overrideCode: code, overrideReason: reason } });
        msg.innerHTML = `✓ Approved with override. Code <b>${r2.shortCode}</b>. <a href="${r2.printUrl}" target="_blank">Print pass</a>`;
        setTimeout(loadRequests, 1200);
      } catch (e2) { msg.textContent = e2.message; }
    } else { msg.textContent = err.message; }
  }
};
async function denyRequest(id) {
  const note = prompt('Reason for denial (optional):') || '';
  try { await api(`/requests/${id}/deny`, { method: 'POST', body: { note } }); loadRequests(); }
  catch (err) { $(`#reqmsg-${id}`).textContent = err.message; }
}

// --- Export (Management) ---
async function loadExportDatasets() {
  if ($('#exportDataset').options.length) return;
  const sets = await api('/admin/export/datasets');
  $('#exportDataset').innerHTML = sets.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
}
$('#exportBtn').onclick = () => {
  const dataset = $('#exportDataset').value;
  const format = $('#exportFormat').value;
  // Hit the download endpoint in a new tab; the browser saves the file.
  window.open(`/api/admin/export?dataset=${encodeURIComponent(dataset)}&format=${format}`, '_blank');
};

// --- Year-end archive & clear ---
async function loadYearEnd() {
  const s = await api('/admin/year-end/status');
  const banner = $('#yearEndBanner');
  if (s.hasPriorData) {
    banner.hidden = false;
    banner.innerHTML = `<b>Year-end archive due.</b> There are ${s.total} records from ${s.priorYears.join(', ')} (before ${s.currentYear}). Download all datasets below, then clear prior-year data to keep the system tidy.`;
  } else {
    banner.hidden = true;
  }
  const c = s.counts;
  $('#yearEndBox').innerHTML = s.hasPriorData
    ? `<p>Prior-year records (before ${s.currentYear}): <b>${c.passes}</b> passes, <b>${c.requests}</b> requests, <b>${c.pass_audit}</b> pass-audit, <b>${c.auth_audit}</b> sign-in-audit.</p>
       <p class="hint">⚠ Download everything you need first — clearing permanently deletes these rows. Units, residents, and vehicles are kept.</p>
       <button type="button" id="yearEndClearBtn" class="danger">Clear prior-year data</button>
       <p class="msg" id="yearEndMsg"></p>`
    : `<p>No prior-year data to archive. Everything is from ${s.currentYear}.</p>`;
}
$('#yearEndBox').addEventListener('click', async (e) => {
  if (!e.target.closest('#yearEndClearBtn')) return;
  if (!confirm('Have you downloaded all the data you need? This permanently deletes all passes, requests, and audit records from previous years. This cannot be undone.')) return;
  if (!confirm('Final confirmation — permanently delete prior-year records now?')) return;
  try {
    const r = await api('/admin/year-end/clear', { method: 'POST', body: { confirm: true } });
    $('#yearEndMsg').textContent = `Cleared: ${r.deleted.passes} passes, ${r.deleted.requests} requests, ${r.deleted.pass_audit + r.deleted.auth_audit} audit rows.`;
    setTimeout(loadYearEnd, 1200);
  } catch (err) { $('#yearEndMsg').textContent = err.message; }
});

// --- Board ---
async function loadBoard() {
  const s = await api('/board/summary');
  const t = s.totals;
  const months = s.passesByMonth.map((m) => `<tr><td>${m.month}</td><td>${m.passes}</td></tr>`).join('');
  const units = s.busiestUnits.map((u) => `<tr><td>${u.unit_number}</td><td>${u.passes_used}</td></tr>`).join('');
  $('#boardSummary').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${t.total_passes}</div><div class="l">Passes ${s.year}</div></div>
      <div class="stat"><div class="n">${t.active_passes}</div><div class="l">Active</div></div>
      <div class="stat"><div class="n">${t.revoked_passes}</div><div class="l">Revoked</div></div>
      <div class="stat"><div class="n">${t.override_passes}</div><div class="l">Overrides</div></div>
      <div class="stat"><div class="n">${t.units_with_passes}/${s.totalUnits}</div><div class="l">Units active</div></div>
      <div class="stat"><div class="n">${s.registeredVehicles}</div><div class="l">Registered vehicles</div></div>
    </div>
    <div class="cols" style="margin-top:16px">
      <div class="result-card"><h3>Passes by month</h3><table><tr><th>Month</th><th>Passes</th></tr>${months || '<tr><td colspan=2>No data</td></tr>'}</table></div>
      <div class="result-card"><h3>Busiest units</h3><table><tr><th>Unit</th><th>Passes used</th></tr>${units || '<tr><td colspan=2>No data</td></tr>'}</table></div>
    </div>
    <p class="hint">Board view shows aggregate analytics only — no resident names, contact details, or plate numbers.</p>`;
}

// --- Boot ---
(async () => {
  try {
    const { user } = await api('/auth/me');
    await enterApp(user);
  } catch { $('#view-login').hidden = false; }
})();
