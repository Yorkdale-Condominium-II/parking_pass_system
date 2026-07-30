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
  if (!res.ok) {
    const msg = data.message || data.error ||
      (res.status === 404 ? 'Not found (is the server running the latest code? restart it)' : 'HTTP ' + res.status);
    throw Object.assign(new Error(msg), { data, status: res.status });
  }
  return data;
};

const ROLE_VIEWS = {
  security:   ['lookup', 'issue', 'verify', 'spots', 'requests', 'account'],
  management: ['lookup', 'issue', 'verify', 'spots', 'requests', 'board', 'admin', 'account'],
  board:      ['board', 'account'],
};
// Views grouped under a "System Management" label in the nav.
const SYS_GROUP = ['admin', 'account'];
const VIEW_LABELS = { lookup: 'Lookup', issue: 'Issue Pass', verify: 'Verify', spots: 'Spots', requests: 'Requests', admin: 'Yorkdale Manager', board: 'Dashboard', account: 'Account' };
let currentUser = null;
let unitIndex = {};   // unit_number -> {kind, business_name}
let regionData = null;
let orgName = 'Yorkdale Condominium II';
let appVersion = '';

async function loadSettings() {
  try {
    const s = await api('/settings');
    orgName = s.orgName || orgName;
    appVersion = s.version || appVersion;
  } catch {}
  applyOrgName();
  applyVersion();
}
function applyOrgName() {
  const brandName = $('#brandName');
  if (brandName) brandName.textContent = orgName;
  if (currentUser) $('#whoami').innerHTML = `<b>${orgName}</b> · ${currentUser.name}`;
}
function applyVersion() {
  if (!appVersion) return;
  // Header badge (shown once logged in) and login-screen badge (shown before).
  for (const id of ['#appVersion', '#appVersionLogin']) {
    const badge = $(id);
    if (badge) badge.textContent = `v${appVersion}`;
  }
  // Surface the version in the browser tab too.
  document.title = `${orgName} — Parking Management (v${appVersion})`;
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  const el = $('#view-' + name);
  if (el) el.hidden = false;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'board') loadBoard();
  if (name === 'admin') { loadAudit(); loadAuthAudit(); loadOverrideCode(); loadExportDatasets(); loadYearEnd(); loadUsers(); $('#orgNameInput').value = orgName; }
  if (name === 'issue') { loadUnits(); loadSpotsBadge(); }
  if (name === 'requests') loadRequests();
  if (name === 'spots') loadSpots();
  if (name === 'account') loadAccount();
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
  const btn = (v) => `<button data-view="${v}">${VIEW_LABELS[v]}</button>`;
  const main = views.filter((v) => !SYS_GROUP.includes(v));
  const group = views.filter((v) => SYS_GROUP.includes(v));
  let html = main.map(btn).join('');
  if (group.length) {
    html += `<span class="nav-group"><span class="nav-group-label">System Management</span>${group.map(btn).join('')}</span>`;
  }
  $('#nav').innerHTML = html;
  document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  if (views.includes('requests')) refreshPendingBadge();
  showView(views[0]);
}

async function enterApp(user) {
  currentUser = user;
  $('#topbar').hidden = false;
  $('#view-login').hidden = true;
  await loadSettings();
  applyOrgName();
  // Force a password change before anything else if this is a temporary password.
  if (user.mustReset) {
    document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
    $('#nav').innerHTML = '';
    $('#view-reset').hidden = false;
    return;
  }
  await loadRegions();
  renderNav();
}

$('#resetForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/auth/change-password', { method: 'POST', body: { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') } });
    const { user } = await api('/auth/me');
    await enterApp(user);
  } catch (err) {
    $('#resetError').textContent = err.data?.error === 'wrong_current_password' ? 'Current password is incorrect.' : err.message;
  }
};

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

// --- Forgot password (request an emailed reset link) ---
$('#forgotLink').onclick = (e) => {
  e.preventDefault();
  const f = $('#forgotForm');
  f.hidden = !f.hidden;
  if (!f.hidden) f.identifier.focus();
};
$('#forgotForm').onsubmit = async (e) => {
  e.preventDefault();
  const identifier = new FormData(e.target).get('identifier');
  try {
    const r = await api('/auth/forgot-password', { method: 'POST', body: { identifier } });
    $('#forgotMsg').textContent = r.message || 'If that account exists, a reset link has been emailed.';
  } catch (err) {
    $('#forgotMsg').textContent = err.message;
  }
};

// --- Set a new password from an emailed reset token (?reset=…) ---
function startTokenReset(token) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  $('#topbar').hidden = true;
  $('#view-reset-token').hidden = false;
  $('#resetTokenForm').onsubmit = async (e) => {
    e.preventDefault();
    const newPassword = new FormData(e.target).get('newPassword');
    $('#resetTokenError').textContent = '';
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword } });
      $('#resetTokenMsg').textContent = 'Password updated. You can now sign in.';
      // Drop the token from the URL and return to the login screen shortly.
      history.replaceState({}, '', location.pathname);
      setTimeout(() => location.replace(location.pathname), 1500);
    } catch (err) {
      $('#resetTokenError').textContent = err.data?.error === 'invalid_or_expired_token'
        ? 'This reset link is invalid or has expired. Please request a new one.'
        : (err.data?.error === 'password_too_short' ? 'Password must be at least 8 characters.' : err.message);
    }
  };
}

// SSO buttons + callback error messages on the login screen.
const SSO_ERRORS = {
  not_provisioned: 'That account isn’t set up here yet. Ask a manager to add your email.',
  email_unverified: 'Your email isn’t verified with the provider.',
  expired: 'The sign-in took too long — please try again.',
  exchange_failed: 'Sign-in failed. Please try again.',
};
async function initSso() {
  const params = new URLSearchParams(location.search);
  if (params.get('sso_error')) {
    $('#loginError').textContent = SSO_ERRORS[params.get('sso_error')] || 'Sign-in was not completed.';
    history.replaceState({}, '', location.pathname);
  }
  try {
    const { sso } = await api('/auth/providers');
    const labels = { google: 'Sign in with Google', microsoft: 'Sign in with Microsoft' };
    $('#ssoButtons').innerHTML = (sso || []).map((p) =>
      `<a href="/api/auth/sso/${p}/start"><button type="button">${labels[p] || p}</button></a>`).join('');
  } catch {}
}

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
      `<tr><td>${p.unit_number}</td><td>${p.visitor_plate}${p.visitor_region ? ' (' + p.visitor_region.replace('-', ' ') + ')' : ''}</td><td>${p.visitor_name || '—'}</td><td><span class="badge ${p.status === 'active' ? 'VALID' : 'REVOKED'}">${p.status}</span></td><td>${new Date(p.expires_at).toLocaleString()}</td><td>${p.status === 'active' ? `<button type="button" class="danger" data-action="cancel" data-id="${p.id}">Cancel</button>` : ''}</td></tr>`).join('');
    $('#lookupResult').innerHTML = `
      <div class="result-card"><h3>Registered vehicles</h3>${reg ? `<table><tr><th>Plate</th><th>Unit</th><th>Resident</th><th>Phone</th><th>Vehicle</th></tr>${reg}</table>` : '<p>None found.</p>'}</div>
      <div class="result-card"><h3>Visitor passes</h3>${passes ? `<table><tr><th>Unit</th><th>Plate</th><th>Visitor</th><th>Status</th><th>Expires</th><th></th></tr>${passes}</table>` : '<p>None found.</p>'}</div>`;
  } catch (err) { $('#lookupResult').innerHTML = `<p class="error">${err.message}</p>`; }
};
$('#lookupResult').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="cancel"]'); if (!btn) return;
  if (!confirm('Cancel this pass? It will no longer be valid.')) return;
  try { await api(`/passes/${btn.dataset.id}/revoke`, { method: 'POST' }); btn.closest('tr').remove(); }
  catch (err) { alert(err.message); }
});

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
    startsAt: f.get('startsAt') || undefined,
    override: f.get('override') === 'on',
    overrideCode: f.get('overrideCode'),
    overrideReason: f.get('overrideReason'),
  };
  try {
    let r;
    try {
      r = await api('/passes', { method: 'POST', body });
    } catch (e1) {
      if (e1.data?.error === 'spot_full') {
        const sp = e1.data.spots || {};
        if (!confirm(`All ${sp.capacity} visitor spaces are taken for that time. Only override if you've confirmed a spot is physically free. Override and issue anyway?`)) {
          throw e1;
        }
        r = await api('/passes', { method: 'POST', body: { ...body, spotOverride: true } });
      } else { throw e1; }
    }
    const q = r.quota || {};
    $('#issueResult').innerHTML = `
      <div class="result-card">
        <h3>Pass issued ${r.usedOverride ? '(quota override)' : ''}${r.usedSpotOverride ? ' (spot override)' : ''}</h3>
        <p>Unit <b>${r.unitNumber}</b> (${r.kind}) · Plate <b>${r.visitorPlate}</b> · ${r.visitorName || 'visitor'}</p>
        ${new Date(r.startsAt) - new Date(r.issuedAt) > 60000 ? `<p>Valid from: <b>${new Date(r.startsAt).toLocaleString()}</b></p>` : ''}
        <p>Expires: <b>${new Date(r.expiresAt).toLocaleString()}</b></p>
        <p>Verification code: <b style="font-family:monospace;font-size:18px">${r.shortCode}</b></p>
        <p>${q.unlimited ? 'Commercial: unlimited' : `Quota this year: ${q.used}/${q.limit} used`} · Spaces used: ${r.spots ? r.spots.peak + '/' + r.spots.capacity + ' at peak' : ''}</p>
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
      ${r.verdict === 'VALID' ? `<div class="btn-row">
        <button type="button" data-action="vacate" data-id="${r.pass.id}">Vehicle vacated (free spot)</button>
        <button type="button" class="danger" data-action="revoke" data-id="${r.pass.id}">Cancel pass</button>
      </div>` : ''}` : `<p>Reason: ${r.reason}</p>`;
    $('#verifyResult').innerHTML = `<div class="result-card"><span class="badge ${r.verdict}">${r.verdict}</span>${detail}</div>`;
  } catch (err) { $('#verifyResult').innerHTML = `<p class="error">${err.message}</p>`; }
}
$('#verifyResult').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const act = btn.dataset.action;
  if (act === 'revoke') { if (!confirm('Cancel this pass? It will no longer be valid.')) return; await api(`/passes/${btn.dataset.id}/revoke`, { method: 'POST' }); alert('Pass cancelled.'); }
  if (act === 'vacate') { await api(`/passes/${btn.dataset.id}/vacate`, { method: 'POST' }); alert('Spot freed — vehicle marked as vacated.'); }
});

// --- Admin ---
$('#unitKind').onchange = (e) => { $('#commercialFields').hidden = e.target.value !== 'commercial'; };
$('#userForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/admin/users', { method: 'POST', body: { username: f.get('username'), firstName: f.get('firstName'), lastName: f.get('lastName'), email: f.get('email'), role: f.get('role'), password: f.get('password') } });
    $('#userMsg').textContent = 'User created.'; e.target.reset(); loadUsers();
  } catch (err) { $('#userMsg').textContent = err.message; }
};

// --- Settings (company / condo name) ---
$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const val = new FormData(e.target).get('orgName').trim();
  if (!val) return;
  try {
    const r = await api('/admin/settings', { method: 'PATCH', body: { orgName: val } });
    orgName = r.orgName; applyOrgName();
    $('#settingsMsg').textContent = 'Saved.';
  } catch (err) { $('#settingsMsg').textContent = err.message; }
};

// --- Manage users ---
$('#refreshUsers').onclick = loadUsers;
async function loadUsers() {
  const rows = await api('/admin/users');
  $('#usersTable').innerHTML = `<table><tr><th>Name</th><th>Username</th><th>Email (SSO)</th><th>Role</th><th>Status</th><th>Actions</th></tr>` +
    rows.map((u) => `<tr>
      <td>${u.first_name || ''} ${u.last_name || ''}</td>
      <td>${u.username}</td>
      <td>${u.email || '—'}</td>
      <td>${u.role}</td>
      <td>${u.is_active ? 'Active' : '<span style="color:#b3261e">Disabled</span>'}</td>
      <td>
        <button type="button" data-uact="history" data-id="${u.id}" data-name="${u.first_name} ${u.last_name}">History</button>
        <button type="button" data-uact="email" data-id="${u.id}" data-email="${u.email || ''}">Set email</button>
        <button type="button" data-uact="toggle" data-id="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Disable' : 'Enable'}</button>
        <button type="button" data-uact="resetpw" data-id="${u.id}">Reset pw</button>
      </td></tr>`).join('') + `</table>`;
}
$('#usersTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-uact]'); if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.uact === 'toggle') {
      await api(`/admin/users/${id}`, { method: 'PATCH', body: { isActive: btn.dataset.active !== 'true' } });
      loadUsers();
    } else if (btn.dataset.uact === 'resetpw') {
      const pw = prompt('New password (min 8 chars):');
      if (!pw) return;
      await api(`/admin/users/${id}/reset-password`, { method: 'POST', body: { password: pw } });
      alert('Password reset.');
    } else if (btn.dataset.uact === 'email') {
      const email = prompt('Email for Google/Microsoft sign-in (blank to clear):', btn.dataset.email);
      if (email === null) return;
      await api(`/admin/users/${id}`, { method: 'PATCH', body: { email } });
      loadUsers();
    } else if (btn.dataset.uact === 'history') {
      const h = await api(`/admin/users/${id}/history`);
      const s = h.summary;
      $('#userHistory').innerHTML = `<div class="result-card">
        <h3>Activity — ${btn.dataset.name}</h3>
        <p>Issued: <b>${s.issued}</b> · Cancelled: <b>${s.cancelled}</b> · Vacated: <b>${s.vacated}</b> · Verified: <b>${s.verified}</b></p>
        <table><tr><th>Time</th><th>Action</th><th>Unit</th><th>Plate</th></tr>` +
        h.events.map((ev) => `<tr><td>${new Date(ev.created_at).toLocaleString()}</td><td>${ev.action}</td><td>${ev.unit_number || '—'}</td><td>${ev.visitor_plate || '—'}</td></tr>`).join('') +
        `</table></div>`;
    }
  } catch (err) { alert(err.message); }
});

// --- Clear all logs ---
$('#clearLogsBtn').onclick = async () => {
  if (!confirm('Have you downloaded all data you need? This deletes all audit logs and historical passes/requests. It CANNOT be undone.')) return;
  if (!confirm('Final confirmation — clear all logs now?')) return;
  try {
    const r = await api('/admin/clear-logs', { method: 'POST', body: { confirm: true } });
    $('#clearLogsMsg').textContent = `Cleared: ${r.deleted.pass_audit + r.deleted.auth_audit} log rows, ${r.deleted.passes} historical passes, ${r.deleted.requests} requests.`;
    loadAudit(); loadAuthAudit(); loadUsers();
  } catch (err) { $('#clearLogsMsg').textContent = err.message; }
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
// Holds a selected Excel workbook (base64) until import; CSV/text files are
// previewed in the textarea instead.
let unitImportXlsx = null;
const isXlsxName = (name) => /\.xlsx?$/i.test(name || '');
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]); // strip data: prefix
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
const unitImportFile = $('#unitImportFile');
if (unitImportFile) {
  unitImportFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    unitImportXlsx = null;
    if (!file) return;
    if (isXlsxName(file.name)) {
      // Excel: don't dump binary into the textarea — parse it on the server.
      unitImportXlsx = await fileToBase64(file);
      $('#unitImportText').value = '';
      $('#unitImportMsg').textContent = `Excel file ready: ${file.name}. Click “Import units”.`;
    } else {
      $('#unitImportText').value = await file.text();
      $('#unitImportMsg').textContent = '';
    }
  });
}
const unitImportForm = $('#unitImportForm');
if (unitImportForm) {
  unitImportForm.onsubmit = async (e) => {
    e.preventDefault();
    const csv = new FormData(e.target).get('csv');
    let body;
    if (unitImportXlsx) body = { xlsxBase64: unitImportXlsx };
    else if (csv && csv.trim()) body = { csv };
    else { $('#unitImportMsg').textContent = 'Choose a file or paste CSV first.'; return; }
    try {
      const r = await api('/admin/units/import', { method: 'POST', body });
      let msg = `Imported: ${r.inserted} added, ${r.updated} updated, ${r.failed} skipped.`;
      if (r.errors && r.errors.length) {
        msg += ' — ' + r.errors.slice(0, 5)
          .map((x) => `row ${x.line}${x.unitNumber ? ' (' + x.unitNumber + ')' : ''}: ${x.error}`).join('; ')
          + (r.errors.length > 5 ? ` …and ${r.errors.length - 5} more.` : '');
      }
      $('#unitImportMsg').textContent = msg;
      unitImportXlsx = null;
      unitImportFile.value = '';
    } catch (err) { $('#unitImportMsg').textContent = err.message; }
  };
}
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
    const sched = r.starts_at ? `Scheduled: ${new Date(r.starts_at).toLocaleString()}` : 'Start: now';
    return `<div class="result-card" data-id="${r.id}">
      <h3>Unit ${r.unit_number} ${r.kind === 'commercial' ? '(commercial)' : ''}</h3>
      <p>Requested by <b>${r.requester_name}</b>${r.requester_contact ? ' · ' + r.requester_contact : ''} · ${new Date(r.created_at).toLocaleString()}</p>
      <p>Visitor <b>${name}</b> · Plate <b>${r.visitor_plate}</b>${r.visitor_region ? ' (' + r.visitor_region.replace('-', ' ') + ')' : ''} · ${dur} · ${sched}</p>
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
    showApproved(msg, r);
    setTimeout(loadRequests, 1800);
  } catch (err) {
    if (err.data?.error === 'quota_exceeded') {
      const code = prompt("This unit is at its quota. Enter this week's override code to approve anyway (or Cancel):");
      if (!code) { msg.textContent = 'Not approved (unit at quota).'; return; }
      const reason = prompt('Override reason:') || 'staff override';
      try {
        const r2 = await api(`/requests/${id}/approve`, { method: 'POST', body: { override: true, overrideCode: code, overrideReason: reason } });
        showApproved(msg, r2); setTimeout(loadRequests, 1500);
      } catch (e2) { msg.textContent = e2.message; }
    } else if (err.data?.error === 'spot_full') {
      const sp = err.data.spots || {};
      if (!confirm(`All ${sp.capacity} visitor spaces are taken for that time. Only override if a spot is physically free. Approve anyway?`)) {
        msg.textContent = 'Not approved (no space available).'; return;
      }
      try {
        const r3 = await api(`/requests/${id}/approve`, { method: 'POST', body: { spotOverride: true } });
        showApproved(msg, r3); setTimeout(loadRequests, 1500);
      } catch (e3) { msg.textContent = e3.message; }
    } else { msg.textContent = err.message; }
  }
};
function showApproved(msg, r) {
  const mail = r.emailed ? ' · emailed to resident' : (r.emailConfigured ? '' : ' · (email not configured)');
  msg.innerHTML = `✓ Approved. Code <b>${r.shortCode}</b>. <a href="${r.printUrl}" target="_blank">Print pass</a>${mail}`;
}
async function denyRequest(id) {
  const note = prompt('Reason for denial (optional):') || '';
  try { await api(`/requests/${id}/deny`, { method: 'POST', body: { note } }); loadRequests(); }
  catch (err) { $(`#reqmsg-${id}`).textContent = err.message; }
}

// --- Spots (live occupancy board) ---
$('#refreshSpots').onclick = loadSpots;
async function loadSpots() {
  const s = await api('/spots');
  $('#spotsSummary').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${s.used}/${s.capacity}</div><div class="l">Spaces occupied</div></div>
      <div class="stat"><div class="n">${s.available}</div><div class="l">Available now</div></div>
      <div class="stat"><div class="n">${s.upcoming.length}</div><div class="l">Scheduled (48h)</div></div>
    </div>`;
  $('#spotsLive').innerHTML = s.live.length ? s.live.map((p) => `
    <div class="result-card">
      <p>Unit <b>${p.unit_number}</b> · Plate <b>${p.visitor_plate}</b>${p.visitor_region ? ' (' + p.visitor_region.replace('-', ' ') + ')' : ''} · ${p.visitor_name || 'visitor'}</p>
      <p class="hint">Until ${new Date(p.expires_at).toLocaleString()}</p>
      <div class="btn-row">
        <button type="button" data-action="vacate" data-id="${p.id}">Mark vacated (free spot)</button>
        <button type="button" class="danger" data-action="cancel" data-id="${p.id}">Cancel pass</button>
      </div>
    </div>`).join('') : '<p>No spaces occupied right now.</p>';
  $('#spotsUpcoming').innerHTML = s.upcoming.length ? `<table><tr><th>Starts</th><th>Unit</th><th>Plate</th><th>Until</th><th>Authorized by</th><th></th></tr>` +
    s.upcoming.map((p) => `<tr><td>${new Date(p.starts_at).toLocaleString()}</td><td>${p.unit_number}</td><td>${p.visitor_plate}</td><td>${new Date(p.expires_at).toLocaleString()}</td><td>${p.authorized_by || '—'}</td><td><button type="button" class="danger" data-action="cancel" data-id="${p.id}">Cancel</button></td></tr>`).join('') + `</table>` : '<p>Nothing scheduled.</p>';
}
$('#spotsUpcoming').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="cancel"]');
  if (!btn) return;
  if (!confirm('Cancel this scheduled pass? It will no longer be valid.')) return;
  await api(`/passes/${btn.dataset.id}/revoke`, { method: 'POST' });
  loadSpots();
});
$('#spotsLive').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'vacate') {
    if (!confirm('Confirm the vehicle has left. This frees the spot for the next guest.')) return;
    await api(`/passes/${btn.dataset.id}/vacate`, { method: 'POST' });
  } else if (btn.dataset.action === 'cancel') {
    if (!confirm('Cancel this pass? It will no longer be valid.')) return;
    await api(`/passes/${btn.dataset.id}/revoke`, { method: 'POST' });
  }
  loadSpots();
});
async function loadSpotsBadge() {
  try {
    const s = await api('/spots');
    const btn = document.querySelector('#nav button[data-view="spots"]');
    if (btn) btn.textContent = `${VIEW_LABELS.spots} (${s.available}/${s.capacity})`;
  } catch {}
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

// --- Account (all roles) ---
const ROLE_LABELS = { security: 'Security', management: 'Management', board: 'Board' };
async function loadAccount() {
  let a;
  try {
    a = await api('/auth/account');
  } catch (err) {
    $('#accountMsg').textContent = `Could not load your details: ${err.message}`;
    return;
  }
  // Populate the editable details form.
  const f = $('#accountForm');
  f.username.value = a.username || '';
  f.firstName.value = a.first_name || '';
  f.lastName.value = a.last_name || '';
  f.email.value = a.email || '';
  // Role select: superusers can change it; everyone else sees it locked.
  const roleSel = $('#accountRole');
  roleSel.innerHTML = Object.entries(ROLE_LABELS)
    .map(([v, l]) => `<option value="${v}"${v === a.role ? ' selected' : ''}>${l}</option>`).join('');
  roleSel.disabled = !a.is_superuser;
  $('#roleLockHint').hidden = Boolean(a.is_superuser);
  $('#accountMsg').textContent = '';

  $('#accountBox').innerHTML = `
    <p><b>${a.full_name}</b> · ${ROLE_LABELS[a.role] || a.role}${a.is_superuser ? ' · <span class="badge VALID">Superuser</span>' : ''}</p>
    <p>Email: ${a.email || '<i>not linked</i>'} ${a.sso_provider ? `· linked to ${a.sso_provider}` : ''}</p>`;
  try {
    const { sso } = await api('/auth/providers');
    const labels = { google: 'Link Google', microsoft: 'Link Microsoft' };
    $('#linkButtons').innerHTML = (sso || []).length
      ? sso.map((p) => `<a href="/api/auth/sso/${p}/link"><button type="button">${labels[p] || p}</button></a>`).join('')
      : '<span class="hint">Google/Microsoft sign-in isn’t configured on this server yet.</span>';
  } catch {}
}
$('#accountForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    username: f.get('username'), firstName: f.get('firstName'),
    lastName: f.get('lastName'), email: f.get('email'),
  };
  // Only send role when the field is editable (superuser), so others never trip the guard.
  if (!$('#accountRole').disabled) body.role = f.get('role');
  try {
    const roleBefore = currentUser.role;
    const updated = await api('/auth/account', { method: 'PATCH', body });
    currentUser.name = updated.full_name;
    currentUser.role = updated.role;
    applyOrgName();
    $('#accountMsg').textContent = 'Saved.';
    if (updated.role !== roleBefore) {
      // Role changed which tabs are available — rebuild nav, then return to Account.
      renderNav();
      showView('account');
    } else {
      loadAccount();
    }
  } catch (err) {
    const map = { username_taken: 'That username is already taken.', email_taken: 'That email is already in use.',
      role_change_forbidden: 'Only a superuser can change roles.' };
    $('#accountMsg').textContent = map[err.data?.error] || err.message;
  }
};
$('#pwForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/auth/change-password', { method: 'POST', body: { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') } });
    $('#pwMsg').textContent = 'Password changed.'; e.target.reset();
  } catch (err) { $('#pwMsg').textContent = err.data?.error === 'wrong_current_password' ? 'Current password is incorrect.' : err.message; }
};

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
  // Load public settings first so the version/org show even before login.
  await loadSettings();
  // An emailed reset link (?reset=<token>) takes priority over everything else.
  const resetToken = new URLSearchParams(location.search).get('reset');
  if (resetToken) {
    startTokenReset(resetToken);
    return;
  }
  try {
    const { user } = await api('/auth/me');
    await enterApp(user);
    if (new URLSearchParams(location.search).get('linked') && !user.mustReset) {
      history.replaceState({}, '', location.pathname);
      showView('account');
    }
  } catch { $('#view-login').hidden = false; initSso(); }
})();
