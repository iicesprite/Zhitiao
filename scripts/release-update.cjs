const { createPublicKey, generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assetName, signUpdate } = require('../desktop/update-trust.cjs');
const manifest = require('../package.json');

const root = path.resolve(__dirname, '..');
const privateFile = path.join(root, 'data', 'update-signing-key.pem');
const publicFile = path.join(root, 'desktop', 'update-signing.pub');

function initializeKey() {
  if (!fs.existsSync(privateFile)) {
    if (fs.existsSync(publicFile)) throw new Error('已有更新公钥，请恢复原签名私钥。');
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    fs.mkdirSync(path.dirname(privateFile), { recursive: true });
    fs.writeFileSync(privateFile, privateKey, { mode: 0o600, flag: 'wx' });
  }
  const publicKey = createPublicKey(fs.readFileSync(privateFile)).export({ type: 'spki', format: 'pem' });
  if (!fs.existsSync(publicFile)) fs.writeFileSync(publicFile, publicKey, { flag: 'wx' });
  verifyPair();
  console.log('更新签名密钥已就绪。私钥已保存在本机 data 目录。');
}

function verifyPair() {
  if (!fs.existsSync(privateFile) || !fs.existsSync(publicFile)) {
    throw new Error('缺少更新签名密钥。首次配置请运行 npm run update:key。');
  }
  const privateKey = fs.readFileSync(privateFile);
  const expected = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const configured = createPublicKey(fs.readFileSync(publicFile)).export({ type: 'spki', format: 'der' });
  if (!expected.equals(configured)) throw new Error('本地签名私钥与应用内置公钥不匹配。');
  return privateKey;
}

async function packageUpdate() {
  const privateKey = verifyPair();
  const { createPackage } = require('@electron/asar');
  const runtime = manifest.devDependencies.electron;
  const name = assetName(manifest.version, runtime);
  const output = path.join(root, 'dist');
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cache, 'update-'));
  try {
    const payload = path.join(staging, 'payload');
    fs.mkdirSync(payload);
    for (const entry of ['desktop', 'shared', 'THIRD-PARTY-NOTICES.txt']) {
      fs.cpSync(path.join(root, entry), path.join(payload, entry), { recursive: true });
    }
    const temporaryArchive = path.join(staging, name);
    await createPackage(payload, temporaryArchive);
    const bytes = fs.readFileSync(temporaryArchive);
    const record = signUpdate(bytes, manifest.version, runtime, privateKey);
    fs.writeFileSync(path.join(output, name), bytes);
    fs.writeFileSync(path.join(output, 'zhitiao-update.json'), JSON.stringify(record, null, 2) + '\n');
    console.log('GitHub Release v' + manifest.version + ' 附件：');
    console.log(path.join(output, name));
    console.log(path.join(output, 'zhitiao-update.json'));
  } finally {
    if (path.dirname(staging) === cache && path.basename(staging).startsWith('update-')) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

async function run() {
  if (process.argv[2] === '--init') initializeKey();
  else await packageUpdate();
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
