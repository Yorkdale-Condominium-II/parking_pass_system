'use strict';
// Public resident portal — submits a pass REQUEST (no login). No session, so
// this never touches privileged endpoints.
const $ = (s) => document.querySelector(s);

// Escape server-supplied values before they flow into innerHTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

let regionData = null;
async function loadRegions() {
  const res = await fetch('/api/resident/regions');
  regionData = await res.json();
  populateRegions();
}
function populateRegions() {
  const country = $('#visitorCountry').value;
  const list = regionData[country] || [];
  $('#visitorRegion').innerHTML = list.map((r) => `<option value="${esc(r.code)}">${esc(r.code)} — ${esc(r.name)}</option>`).join('');
  if (country === 'CA' && list.some((r) => r.code === 'ON')) $('#visitorRegion').value = 'ON';
}
$('#visitorCountry').onchange = populateRegions;

function updateDurationHint(preset) {
  const map = {
    short_stay: 'Short Stay: valid for up to 6 hours, and no later than 11 PM.',
    overnight: 'Overnight: for a visitor staying past midnight. Valid until 8 AM.',
  };
  const h = $('#durationHint');
  if (h) h.textContent = map[preset] || '';
}
document.querySelectorAll('#durationRow .dur').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#durationRow .dur').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#durationPreset').value = b.dataset.preset;
    updateDurationHint(b.dataset.preset);
  };
});
updateDurationHint(($('#durationPreset') || {}).value || 'short_stay');

$('#reqForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#reqError').textContent = '';
  const f = new FormData(e.target);
  const body = Object.fromEntries(f.entries());
  try {
    const res = await fetch('/api/resident/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Could not submit');
    $('#reqForm').hidden = true;
    $('#reqResult').innerHTML = `
      <div class="result-card">
        <h3>✓ Request submitted</h3>
        <p>${esc(data.message)}</p>
        <p>Your reference code: <b style="font-family:monospace;font-size:22px;letter-spacing:2px">${esc(data.reference)}</b></p>
        <p class="hint">Keep this code — use it below to check your request's status. If you gave an email, your approved pass will be sent there.</p>
        <button type="button" id="againBtn">Submit another request</button>
      </div>`;
    document.getElementById('againBtn').onclick = () => location.reload();
  } catch (err) {
    $('#reqError').textContent = err.message === 'unit_not_found'
      ? 'That unit number was not found. Please check and try again.'
      : err.message;
  }
};

// --- Status check by reference code ---
$('#statusForm').onsubmit = async (e) => {
  e.preventDefault();
  const ref = new FormData(e.target).get('ref');
  try {
    const res = await fetch('/api/resident/status/' + encodeURIComponent(ref));
    const d = await res.json();
    if (!res.ok) throw new Error(d.error === 'not_found' ? 'No request found for that reference.' : 'Lookup failed');
    const label = { pending: 'Pending review', approved: 'Approved', denied: 'Denied' }[d.status] || d.status;
    const cls = d.status === 'approved' ? 'VALID' : d.status === 'denied' ? 'REVOKED' : 'EXPIRED';
    $('#statusResult').innerHTML = `
      <div class="result-card">
        <span class="badge ${cls}">${esc(label)}</span>
        <p>Unit ${esc(d.unit)} · Plate ${esc(d.visitorPlate)}</p>
        <p>Submitted ${esc(new Date(d.submittedAt).toLocaleString())}</p>
        ${d.decidedAt ? `<p>Decided ${esc(new Date(d.decidedAt).toLocaleString())}</p>` : ''}
        ${d.note ? `<p>Staff note: ${esc(d.note)}</p>` : ''}
        ${d.status === 'approved' ? '<p>If you provided an email, your pass has been sent there.</p>' : ''}
      </div>`;
  } catch (err) { $('#statusResult').innerHTML = `<p class="error">${esc(err.message)}</p>`; }
};

fetch('/api/settings').then((r) => r.json()).then((s) => {
  const org = document.querySelector('#brandOrg');
  if (org && s.orgName) org.textContent = s.orgName;
}).catch(() => {});

loadRegions();
