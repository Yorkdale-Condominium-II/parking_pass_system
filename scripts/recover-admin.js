'use strict';
// ============================================================================
//  Emergency account recovery — run locally on the server PC when you are
//  locked out (e.g. an admin account was deactivated, or a password was lost).
//
//  Usage:
//    node scripts/recover-admin.js                 # list all accounts
//    node scripts/recover-admin.js <username> <newPassword>
//
//  Recovering an account RE-ENABLES it (is_active = TRUE), sets a known
//  password, and grants the superuser flag so you can fix roles/accounts from
//  the UI again. The password is temporary — you'll be asked to change it at
//  next login.
//
//  This bypasses the login screen on purpose and requires direct access to the
//  machine and its database, so it is only usable by someone at the server.
// ============================================================================
const db = require('../src/db');
const password = require('../src/auth/password');

async function listUsers() {
  const r = await db.query(
    `SELECT username, full_name, role, is_active, is_superuser
       FROM users ORDER BY is_active DESC, role, username`
  );
  if (r.rowCount === 0) {
    console.log('No user accounts exist.');
    return;
  }
  console.log('\nAccounts (username — name — role — active — superuser):');
  for (const u of r.rows) {
    console.log(
      `  ${u.username}  —  ${u.full_name}  —  ${u.role}  —  ` +
      `${u.is_active ? 'active' : 'DISABLED'}  —  ${u.is_superuser ? 'superuser' : '-'}`
    );
  }
  console.log('\nTo recover one:  node scripts/recover-admin.js <username> <newPassword>\n');
}

async function recover(username, newPassword) {
  if (newPassword.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }
  const hash = await password.hash(newPassword);
  const r = await db.query(
    `UPDATE users
        SET is_active = TRUE,
            is_superuser = TRUE,
            password_hash = $1,
            must_reset_password = TRUE,
            updated_at = now()
      WHERE lower(username) = lower($2)
      RETURNING username, full_name, role`,
    [hash, username]
  );
  if (r.rowCount === 0) {
    console.error(`No account found with username "${username}".`);
    console.error('Run without arguments to list existing usernames.');
    process.exitCode = 1;
    return;
  }
  const u = r.rows[0];
  console.log(`\n✓ Recovered "${u.username}" (${u.full_name}, ${u.role}).`);
  console.log('  It is now active and a superuser.');
  console.log('  Log in with the password you just set — you\'ll be asked to change it.\n');
}

(async () => {
  const [username, newPassword] = process.argv.slice(2);
  if (!username) {
    await listUsers();
  } else if (!newPassword) {
    console.error('Usage: node scripts/recover-admin.js <username> <newPassword>');
    process.exitCode = 1;
  } else {
    await recover(username, newPassword);
  }
  await db.pool.end();
})().catch((err) => {
  console.error('Recovery failed:', err.message);
  process.exit(1);
});
