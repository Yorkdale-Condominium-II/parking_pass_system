'use strict';
const db = require('./../db');

// Save/refresh a unit's owner contact (name / phone / email) without wiping any
// existing value: each field is only overwritten when a non-empty new value is
// supplied. Called when a resident submits a request or staff issue a pass, and
// from the "All units" editor. `where` is { id } or { unitNumber }.
async function saveUnitOwner(where, { name, phone, email } = {}, client = db) {
  const val = (v) => {
    const s = (v == null ? '' : String(v)).trim();
    return s === '' ? null : s;
  };
  const name_ = val(name);
  const phone_ = val(phone);
  const email_ = val(email);
  if (name_ === null && phone_ === null && email_ === null) return; // nothing to save
  const col = where.id ? 'id' : 'unit_number';
  const key = where.id ? where.id : where.unitNumber;
  await client.query(
    `UPDATE units SET
        owner_name  = COALESCE($2, owner_name),
        owner_phone = COALESCE($3, owner_phone),
        owner_email = COALESCE($4, owner_email)
      WHERE ${col} = $1`,
    [key, name_, phone_, email_]
  );
}

module.exports = { saveUnitOwner };
