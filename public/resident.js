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
        <p class="hint">Reference: ${data.requestId}</p>
        <button type="button" onclick="location.reload()">Submit another request</button>
      </div>`;
  } catch (err) {
    $('#reqError').textContent = err.message === 'unit_not_found'
      ? 'That unit number was not found. Please check and try again.'
      : err.message;
  }
};

loadRegions();
