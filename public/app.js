'use strict';
// ---------------------------------------------------------------------------
//  Lightweight vanilla SPA. Talks to the JSON API; session lives in an
//  httpOnly cookie so the token is not exposed to JS.
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

// Which views each role may see.
const ROLE_VIEWS = {
  security:   ['lookup', 'issue', 'verify'],
  management: ['lookup', 'issue', 'verify', 'admin', 'board'],
  board:      ['board'],
};
const VIEW_LABELS = { lookup: 'Lookup', issue: 'Issue Pass', verify: 'Verify', admin: 'Management', board: 'Dashboard' };
let currentUser = null;

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  const el = $('#view-' + name);
  if (el) el.hidden = false;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'board') loadBoard();
  if (name === 'admin') loadAudit();
}

function renderNav() {
  const views = ROLE_VIEWS[currentUser.role] || [];
  $('#nav').innerHTML = views
    .map((v) => `<button data-view="${v}">${VIEW_LABELS[v]}</button>`)
    .join('');
  document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  // Management-only override controls on the issue form.
  const mgmt = currentUser.role === 'management';
  $('#overrideWrap').hidden = !mgmt;
  showView(views[0]);
}

function enterApp(user) {
  currentUser = user;
  $('#topbar').hidden = false;
  $('#view-login').hidden = true;
  $('#whoami').textContent = `${user.name} · ${user.role}`;
  renderNav();
}

// --- Auth ---
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    enterApp(user);
  } catch (err) {
    $('#loginError').textContent = 'Invalid credentials';
  }
};
$('#logoutBtn').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); };

// --- Lookup ---
$('#lookupForm').onsubmit = async (e) => {
  e.preventDefault();
  const plate = new FormData(e.target).get('plate');
  try {
    const r = await api('/passes/lookup?plate=' + encodeURIComponent(plate));
    const reg = r.registeredVehicles.map((v) =>
      `<tr><td>${v.licence_plate}</td><td>${v.unit_number}</td><td>${v.resident_name || '—'}</td><td>${[v.color, v.make, v.model].filter(Boolean).join(' ') || '—'}</td></tr>`).join('');
    const passes = r.visitorPasses.map((p) =>
      `<tr><td>${p.unit_number}</td><td>${p.visitor_name || '—'}</td><td><span class="badge ${p.status === 'active' ? 'VALID' : 'REVOKED'}">${p.status}</span></td><td>${new Date(p.expires_at).toLocaleString()}</td></tr>`).join('');
    $('#lookupResult').innerHTML = `
      <div class="result-card"><h3>Registered vehicles</h3>${reg ? `<table><tr><th>Plate</th><th>Unit</th><th>Resident</th><th>Vehicle</th></tr>${reg}</table>` : '<p>None found.</p>'}</div>
      <div class="result-card"><h3>Visitor passes</h3>${passes ? `<table><tr><th>Unit</th><th>Visitor</th><th>Status</th><th>Expires</th></tr>${passes}</table>` : '<p>None found.</p>'}</div>`;
  } catch (err) { $('#lookupResult').innerHTML = `<p class="error">${err.message}</p>`; }
};

// --- Issue ---
$('#issueForm').querySelector('[name=override]')?.addEventListener('change', (e) => {
  $('#overrideReasonWrap').hidden = !e.target.checked;
});
$('#issueForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#issueError').textContent = '';
  const f = new FormData(e.target);
  const body = {
    unitNumber: f.get('unitNumber'), visitorPlate: f.get('visitorPlate'),
    visitorName: f.get('visitorName'), durationHours: f.get('durationHours'),
    override: f.get('override') === 'on', overrideReason: f.get('overrideReason'),
  };
  try {
    const r = await api('/passes', { method: 'POST', body });
    $('#issueResult').innerHTML = `
      <div class="result-card">
        <h3>Pass issued ${r.usedOverride ? '(override used)' : ''}</h3>
        <p>Unit <b>${r.unitNumber}</b> · Plate <b>${r.visitorPlate}</b></p>
        <p>Expires: <b>${new Date(r.expiresAt).toLocaleString()}</b></p>
        <p>Quota this year: ${r.quota.used}/${r.quota.limit} used</p>
        <a href="${r.printUrl}" target="_blank"><button type="button">🖨 Open printable pass</button></a>
      </div>`;
    e.target.reset();
    $('#overrideReasonWrap').hidden = true;
  } catch (err) {
    if (err.data?.error === 'quota_exceeded') {
      $('#issueError').innerHTML = `Quota reached (${err.data.quota.used}/${err.data.quota.limit}).` +
        (currentUser.role === 'management' ? ' Tick "Override" with a reason to proceed.' : ' Contact Management for an override.');
    } else {
      $('#issueError').textContent = err.message;
    }
  }
};

// --- Verify ---
$('#verifyForm').onsubmit = async (e) => {
  e.preventDefault();
  const token = new FormData(e.target).get('token');
  try {
    const r = await api('/verify', { method: 'POST', body: { token } });
    const detail = r.pass ? `
      <p>Unit <b>${r.pass.unit_number}</b> · Plate <b>${r.pass.visitor_plate}</b></p>
      <p>Visitor: ${r.pass.visitor_name || '—'}</p>
      <p>Expires: ${new Date(r.pass.expires_at).toLocaleString()}</p>
      ${r.verdict === 'VALID' ? `<button type="button" onclick="revokePass('${r.pass.id}')">Revoke this pass</button>` : ''}` : `<p>Reason: ${r.reason}</p>`;
    $('#verifyResult').innerHTML = `<div class="result-card"><span class="badge ${r.verdict}">${r.verdict}</span>${detail}</div>`;
  } catch (err) { $('#verifyResult').innerHTML = `<p class="error">${err.message}</p>`; }
};
window.revokePass = async (id) => {
  await api(`/passes/${id}/revoke`, { method: 'POST' });
  alert('Pass revoked.');
};

// --- Admin ---
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
    await api('/admin/units', { method: 'POST', body: { unitNumber: f.get('unitNumber'), floor: f.get('floor') } });
    $('#unitMsg').textContent = 'Unit added.'; e.target.reset();
  } catch (err) { $('#unitMsg').textContent = err.message; }
};
$('#refreshAudit').onclick = loadAudit;
async function loadAudit() {
  const rows = await api('/admin/audit?limit=100');
  $('#auditTable').innerHTML = `<table><tr><th>Time</th><th>Action</th><th>Actor</th><th>Unit</th><th>Plate</th></tr>` +
    rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${r.action}</td><td>${r.actor_name || '—'} ${r.actor_role ? '(' + r.actor_role + ')' : ''}</td><td>${r.unit_number || '—'}</td><td>${r.visitor_plate || '—'}</td></tr>`).join('') +
    `</table>`;
}

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

// --- Boot: try existing session ---
(async () => {
  try {
    const { user } = await api('/auth/me');
    enterApp(user);
  } catch {
    $('#view-login').hidden = false;
  }
})();
