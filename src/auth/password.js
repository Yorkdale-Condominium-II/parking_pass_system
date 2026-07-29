'use strict';
const bcrypt = require('bcryptjs');

const ROUNDS = 12;

module.exports = {
  hash: (plain) => bcrypt.hash(plain, ROUNDS),
  verify: (plain, hash) => bcrypt.compare(plain, hash),
};
