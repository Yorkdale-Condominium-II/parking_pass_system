'use strict';
const { Pool } = require('pg');
const config = require('./config');

// A single shared connection pool for the whole process.
const pool = new Pool(
  config.databaseUrl
    ? { connectionString: config.databaseUrl }
    : {} // fall back to standard PG* environment variables
);

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected idle client error', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  /**
   * Run a function inside a single transaction. The callback receives a
   * dedicated client; the transaction commits on success and rolls back on
   * any thrown error.
   */
  async withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
