'use strict';
// Seed baseline data: one account per role, a couple of units + vehicles.
const db = require('../src/db');
const password = require('../src/auth/password');

(async () => {
  const pw = await password.hash('changeme123');
  const users = [
    ['security1', 'Sam Security', 'security'],
    ['manager1', 'Morgan Manager', 'management'],
    ['board1', 'Blair Board', 'board'],
  ];
  for (const [username, name, role] of users) {
    await db.query(
      `INSERT INTO users (username, full_name, role, password_hash)
       VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`,
      [username, name, role, pw]
    );
  }

  const units = ['1204', '0805', 'PH-3'];
  for (const u of units) {
    await db.query(`INSERT INTO units (unit_number) VALUES ($1) ON CONFLICT (unit_number) DO NOTHING`, [u]);
  }
  // A commercial unit (separate quota, business-named for tracing).
  await db.query(
    `INSERT INTO units (unit_number, kind, business_name, business_contact)
     VALUES ('C-101', 'commercial', 'Corner Cafe Ltd.', 'manager@cornercafe.example')
     ON CONFLICT (unit_number) DO NOTHING`
  );

  // A resident with phone/name so the new lookup-by-name/phone works out of the box.
  const u1204 = await db.query(`SELECT id FROM units WHERE unit_number = '1204'`);
  await db.query(
    `INSERT INTO residents (unit_id, full_name, email, phone, is_primary)
     SELECT $1, 'Dana Resident', 'dana@example.com', '416-555-0142', TRUE
      WHERE NOT EXISTS (SELECT 1 FROM residents WHERE unit_id = $1)`,
    [u1204.rows[0].id]
  );
  // Link the seeded vehicle to that resident so lookup-by-name finds it.
  await db.query(
    `UPDATE registered_vehicles SET resident_id = (SELECT id FROM residents WHERE unit_id = $1 LIMIT 1)
      WHERE unit_id = $1 AND resident_id IS NULL`,
    [u1204.rows[0].id]
  );

  const unit = await db.query(`SELECT id FROM units WHERE unit_number = '1204'`);
  await db.query(
    `INSERT INTO registered_vehicles (unit_id, licence_plate, province, make, model, color)
     VALUES ($1, 'ABCD123', 'ON', 'Toyota', 'Corolla', 'Silver')
     ON CONFLICT (licence_plate) DO NOTHING`,
    [unit.rows[0].id]
  );

  // eslint-disable-next-line no-console
  console.log('✓ Seed complete. Logins: security1 / manager1 / board1  (password: changeme123)');
  await db.pool.end();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err.message);
  process.exit(1);
});
