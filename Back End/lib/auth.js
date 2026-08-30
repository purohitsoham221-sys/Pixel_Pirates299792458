'use strict';
const crypto = require('node:crypto');

function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifySecret(plain, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function refCode() {
  return 'JPS-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

function secretKey() {
  return crypto.randomBytes(6).toString('hex');
}

function sessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashSecret, verifySecret, refCode, secretKey, sessionToken };
