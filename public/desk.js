'use strict';
// Public desk kiosk — no session. Each pass is authorized by the selected
// officer's password.
const $ = (s) => document.querySelector(s);
let regionData = null, unitIndex = {};

async function loadRefData() {
  regionData = await (await fetch('/api/desk/regions')).json();
  populateRegions();
  const units = await (await fetch('/api/desk/units')).json();
  $('#unitList').innerHTML = units.map((u) => {
    unitIndex[u.unit_number] = u;
    const label = u.kind === 'commercial' ? `${u.unit_number} — ${u.business_name || 'Commercial'}` : u.unit_number;
    return `<option value="${u.unit_number}">${label}</option>`;
  }).join('');
  const officers = await (await fetch('/api/desk/officers')).json();
  $('#officerSelect').innerHTML = '<option value="">Select officer…</option>' +
    officers.map((o) => `<option value="${o.username}">${o.name} (${o.role})</option>`).join('');
}
function populateRegions() {
  const country = $('#visitorCountry').value;
  const list = regionData[country] || [];
  $('#visitorRegion').innerHTML = list.map((r) => `<option value="${r.code}">${r.code} — ${r.name}</option>`).join('');
  if (country === 'CA' && list.some((r) => r.code === 'ON')) $('#visitorRegion').value = 'ON';
}
$('#visitorCountry').onchange = populateRegions;
$('#deskForm').unitNumber.addEventListener('input', (e) => {
  const u = unitIndex[e.target.value.trim()];
  $('#unitHint').textContent = u
    ? (u.kind === 'commercial' ? `Commercial unit — ${u.business_name || ''}` : 'Residential unit')
    : (e.target.value ? '⚠ Not a known unit — issuance will be rejected.' : '');
});
document.querySelectorAll('#durationRow .dur').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#durationRow .dur').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#durationPreset').value = b.dataset.preset;
  };
});

async function post(body) {
  const res = await fetch('/api/desk/issue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || 'error'), { data });
  return data;
}

$('#deskForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#deskError').textContent = '';
  const f = new FormData(e.target);
  const body = Object.fromEntries(f.entries());
  try {
    let r;
    try {
      r = await post(body);
    } catch (e1) {
      if (e1.data?.error === 'spot_full') {
        const sp = e1.data.spots || {};
        if (!confirm(`All ${sp.capacity} visitor spaces are taken for that time. Only override if you've confirmed a spot is physically free. Override and issue anyway?`)) throw e1;
        r = await post({ ...body, spotOverride: true });
      } else if (e1.data?.error === 'quota_exceeded') {
        const code = prompt("This unit is at its annual limit. Enter this week's override code to proceed (or Cancel):");
        if (!code) throw e1;
        const reason = prompt('Override reason:') || 'desk override';
        r = await post({ ...body, override: true, overrideCode: code, overrideReason: reason });
      } else { throw e1; }
    }
    $('#deskResult').innerHTML = `
      <div class="result-card">
        <h3>✓ Pass issued by ${r.issuedBy}${r.usedOverride ? ' (quota override)' : ''}${r.usedSpotOverride ? ' (spot override)' : ''}</h3>
        <p>Unit <b>${r.unitNumber}</b> · Plate <b>${r.visitorPlate}</b></p>
        ${new Date(r.startsAt) - Date.now() > 60000 ? `<p>Valid from: <b>${new Date(r.startsAt).toLocaleString()}</b></p>` : ''}
        <p>Expires: <b>${new Date(r.expiresAt).toLocaleString()}</b></p>
        <p>Verification code: <b style="font-family:monospace;font-size:18px">${r.shortCode}</b></p>
        <a href="${r.printUrl}" target="_blank"><button type="button">🖨 Open printable pass</button></a>
      </div>`;
    e.target.reset();
    $('#durationPreset').value = 'today';
    document.querySelectorAll('#durationRow .dur').forEach((x, i) => x.classList.toggle('active', i === 0));
    populateRegions();
  } catch (err) {
    $('#deskError').textContent = err.data?.error === 'invalid_officer_credentials'
      ? 'Officer name or password is incorrect.' : err.message;
  }
};

fetch('/api/settings').then((r) => r.json()).then((s) => {
  const org = document.querySelector('#brandOrg');
  if (org && s.orgName) org.textContent = s.orgName;
  if (s.orgName) document.title = s.orgName + ' — Visitor Pass Desk';
}).catch(() => {});

// Desk session (Google/Microsoft) — when active, no per-pass password is needed.
let deskSession = null;
async function loadDeskSession() {
  deskSession = await (await fetch('/api/desk/session')).json();
  const providers = await (await fetch('/api/auth/providers')).json();
  const box = document.getElementById('deskSessionBox');
  const officerAuth = document.getElementById('officerAuth');
  const ssoBtns = document.getElementById('deskSsoButtons');
  if (deskSession.active) {
    const mins = Math.max(0, Math.round((deskSession.expiresAt - Date.now()) / 60000));
    box.hidden = false;
    box.innerHTML = `Signed in for the desk as <b>${deskSession.name}</b> (${deskSession.role}) · about ${mins} min left · <a href="#" id="deskLogout">sign out</a>`;
    officerAuth.hidden = true;
    ssoBtns.innerHTML = '';
    document.getElementById('deskLogout').onclick = async (e) => {
      e.preventDefault(); await fetch('/api/desk/logout', { method: 'POST' }); loadDeskSession();
    };
  } else {
    box.hidden = true;
    officerAuth.hidden = false;
    const labels = { google: 'Sign in with Google', microsoft: 'Sign in with Microsoft' };
    ssoBtns.innerHTML = (providers.sso || []).map((p) =>
      `<a href="/api/auth/sso/${p}/desk"><button type="button">${labels[p] || p} (start desk session)</button></a>`).join('');
  }
}

const params = new URLSearchParams(location.search);
if (params.get('sso_error')) {
  document.getElementById('deskError').textContent =
    params.get('sso_error') === 'not_provisioned' ? 'That account isn’t set up here. Ask a manager.'
    : params.get('sso_error') === 'not_desk_role' ? 'That account isn’t a security/management officer.'
    : 'Desk sign-in was not completed.';
  history.replaceState({}, '', location.pathname);
}

loadRefData();
loadDeskSession();
