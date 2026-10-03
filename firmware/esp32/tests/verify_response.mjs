// Offline hardware-response check. Public data only; no wallet/private key.
import { createHash, createPublicKey, verify } from 'node:crypto';
import assert from 'node:assert/strict';

function hex(value, length, name) {
  assert(typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(value),
    `${name} must contain exactly ${length} bytes of hexadecimal (without spaces)`);
  return Buffer.from(value, 'hex');
}

assert(process.argv.length === 5, 'Usage: node verify_response.mjs PUBLIC_KEY_HEX CHALLENGE_HEX RESPONSE_HEX');
const publicKey = hex(process.argv[2], 32, 'public key');
const challenge = hex(process.argv[3], 44, 'challenge');
const response = hex(process.argv[4], 78, 'response');
assert(response.subarray(64).equals(Buffer.alloc(14)), 'DEV-21 timestamp/counter/evidence length must be zero');
const message = Buffer.concat([Buffer.from('Pathnod/challenge/v0', 'ascii'), challenge, Buffer.alloc(44)]);
assert.equal(message.length, 108);
const digest = createHash('sha256').update(message).digest();
const key = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
  format: 'der', type: 'spki',
});
assert(verify(null, digest, key, response.subarray(0, 64)), 'Invalid DEV_MSG_V0 signature');
console.log('Valid DEV-21 response (Ed25519 over SHA-256 of DEV_MSG_V0)');
