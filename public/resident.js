'use strict';
// Public resident portal — submits a pass REQUEST (no login). No session, so
// this never touches privileged endpoints.
const $ = (s) => document.querySelector(s);

let regionData = null;
async function loadRegions() {
  const res = await fetch('/api/resident/regions');
  regionData = await res.json();
  populateRegions();
}
function populateRegions() {
  const list = regionData[$('#visitorCountry').value] || [];
  $('#visitorRegion').innerHTML = list.map((r) => `<option value="${r.code}">${r.code} — ${r.name}</option>`).join('');
}
$('#visitorCountry').onchange = populateRegions;

document.querySelectorAll('#durationRow .dur').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#durationRow .dur').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#durationPreset').value = b.dataset.preset;
  };
});

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
        <p>${data.message}</p>
        <p>Your reference code: <b style="font-family:monospace;font-size:22px;letter-spacing:2px">${data.reference}</b></p>
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
        <span class="badge ${cls}">${label}</span>
        <p>Unit ${d.unit} · Plate ${d.visitorPlate}</p>
        <p>Submitted ${new Date(d.submittedAt).toLocaleString()}</p>
        ${d.decidedAt ? `<p>Decided ${new Date(d.decidedAt).toLocaleString()}</p>` : ''}
        ${d.note ? `<p>Staff note: ${d.note}</p>` : ''}
        ${d.status === 'approved' ? '<p>If you provided an email, your pass has been sent there.</p>' : ''}
      </div>`;
  } catch (err) { $('#statusResult').innerHTML = `<p class="error">${err.message}</p>`; }
};

fetch('/api/settings').then((r) => r.json()).then((s) => {
  const b = document.querySelector('#topbar .brand');
  if (b && s.orgName) b.textContent = '🅿️ ' + s.orgName;
}).catch(() => {});

loadRegions();
