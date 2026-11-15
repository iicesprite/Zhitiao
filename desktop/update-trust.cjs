const { createHash, sign, verify } = require('node:crypto');

const repository = 'iicesprite/Zhitiao';
const limit = 16 * 1024 * 1024;
const validVersion = (value) => typeof value === 'string' && /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}$/.test(value);

function newer(left, right) {
  if (!validVersion(left) || !validVersion(right)) return false;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function assetName(version, runtime) {
  if (!validVersion(version) || !validVersion(runtime)) throw new Error('Invalid update version');
  return 'zhitiao-' + version + '-electron-' + runtime + '.asar';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function signedText({ version, runtime, digest }) {
  return Buffer.from(['Zhitiao desktop update v1', repository, version, runtime, digest].join('\n'));
}

function signUpdate(bytes, version, runtime, privateKey) {
  assetName(version, runtime);
  if (!bytes.length || bytes.length > limit) throw new Error('Invalid update size');
  const release = { version, runtime, digest: sha256(bytes) };
  return { ...release, signature: sign(null, signedText(release), privateKey).toString('base64url') };
}

function trustedUpdate(record, runtime, publicKey) {
  if (!record || !validVersion(record.version) || record.runtime !== runtime
      || !validVersion(runtime) || typeof record.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(record.digest) || typeof record.signature !== 'string'
      || !/^[\w-]{86}$/.test(record.signature)) return false;
  try {
    return verify(null, signedText(record), publicKey, Buffer.from(record.signature, 'base64url'));
  } catch {
    return false;
  }
}

module.exports = { repository, limit, validVersion, newer, assetName, sha256, signUpdate, trustedUpdate };
