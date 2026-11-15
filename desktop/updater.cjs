const { EventEmitter } = require('node:events');
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const { repository, limit, newer, assetName, sha256, trustedUpdate } = require('./update-trust.cjs');

const releasePage = 'https://github.com/' + repository + '/releases';
const latestManifest = releasePage + '/latest/download/zhitiao-update.json';
const packageHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function atomicWrite(file, content) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function makeStore({ directory, runtime, publicKey }) {
  const stateFile = path.join(directory, 'state.json');
  function read() {
    try {
      if (fs.statSync(stateFile).size > 4096) return {};
      const value = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function save(state) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWrite(stateFile, JSON.stringify(state));
  }
  const file = (record) => path.join(directory, assetName(record.version, runtime));

  function available(record) {
    if (!trustedUpdate(record, runtime, publicKey)) return false;
    try {
      const archive = file(record);
      const info = fs.lstatSync(archive);
      return info.isFile() && info.size > 0 && info.size <= limit && sha256(fs.readFileSync(archive)) === record.digest;
    } catch {
      return false;
    }
  }

  function stage(record, bytes) {
    if (!trustedUpdate(record, runtime, publicKey) || !bytes.length || bytes.length > limit
        || sha256(bytes) !== record.digest) throw new Error('更新包校验失败。');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWrite(file(record), bytes);
    save({ ...read(), pending: record });
  }

  function select(bundled) {
    const state = read();
    let changed = false;
    if (state.trial) {
      if (trustedUpdate(state.trial, runtime, publicKey)) state.failed = state.trial.version;
      delete state.trial;
      changed = true;
    }
    if (state.active && !available(state.active)) {
      if (trustedUpdate(state.active, runtime, publicKey)) state.failed = state.active.version;
      delete state.active;
      changed = true;
    }
    const active = newer(state.active?.version, bundled) ? state.active : null;
    const version = active?.version ?? bundled;
    if (state.pending) {
      const pending = state.pending;
      delete state.pending;
      if (newer(pending.version, version) && pending.version !== state.failed && available(pending)) {
        state.trial = pending;
        save(state);
        return { version: pending.version, archive: file(pending), trial: true };
      }
      changed = true;
    }
    if (changed) save(state);
    return { version, archive: active ? file(active) : null, trial: false };
  }

  function confirm(version) {
    const state = read();
    if (state.trial?.version !== version) return;
    const previous = state.active;
    state.active = state.trial;
    delete state.trial;
    delete state.failed;
    save(state);
    if (previous && available(previous) && previous.version !== version) {
      try { fs.unlinkSync(file(previous)); } catch { /* Windows may still hold the file open. */ }
    }
  }

  function reject(version) {
    const state = read();
    state.failed = version;
    if (state.active?.version === version) delete state.active;
    if (state.trial?.version === version) delete state.trial;
    if (state.pending?.version === version) delete state.pending;
    save(state);
  }

  return { available, read, stage, select, confirm, reject };
}

async function download(fetcher, target, { max, allowMissing = false }) {
  let url = new URL(target);
  const signal = AbortSignal.timeout(18_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!packageHosts.has(url.hostname) || url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new Error('更新地址无效。');
    }
    const response = await fetcher(url.href, {
      signal, redirect: 'manual',
      headers: { 'User-Agent': 'Zhitiao-Desktop', Accept: 'application/octet-stream' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('更新地址无效。');
      url = new URL(location, url);
      continue;
    }
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel();
      throw new Error('暂时无法从 GitHub 获取更新。');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > max) throw new Error('更新文件超出大小限制。');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  throw new Error('更新地址无效。');
}

function createUpdater({ store, version, runtime, publicKey, fetcher = fetch }) {
  const changes = new EventEmitter();
  let current;
  let running;
  let initialTimer, timer;
  let readyVersion = null;
  function update(message) {
    current = { version, message, readyVersion };
    changes.emit('status', current);
    return current;
  }

  const pending = store.read().pending;
  if (newer(pending?.version, version) && store.available(pending)) readyVersion = pending.version;
  update(readyVersion ? '新版已下载，下次启动自动更新。' : '启动后会自动检查更新。');

  async function checkRelease() {
    const raw = await download(fetcher, latestManifest, { max: 2048, allowMissing: true });
    if (!raw) return update('当前没有可自动更新的发布。');
    const record = JSON.parse(raw.toString('utf8'));
    const candidate = record?.version;
    if (!trustedUpdate(record, record?.runtime, publicKey)) return update('新版的数字签名校验失败。');
    if (!newer(candidate, version)) return update('已是最新版本。');
    if (readyVersion && !newer(candidate, readyVersion)) return update('新版已下载，下次启动自动更新。');
    if (store.read().failed === candidate) return update('这个版本启动失败，已恢复可用版本。');
    if (record.runtime !== runtime) return update('新版需要完整安装包，请查看 GitHub 发布页。');
    const name = assetName(candidate, runtime);
    update('正在下载 ' + candidate + '…');
    const bytes = await download(fetcher, releasePage + '/download/v' + candidate + '/' + name, { max: limit });
    if (sha256(bytes) !== record.digest) return update('更新包校验失败。');
    store.stage(record, bytes);
    readyVersion = candidate;
    return update('新版 ' + candidate + ' 已下载，下次启动自动更新。');
  }

  function check() {
    if (running) return running;
    running = Promise.resolve().then(() => {
      update('正在检查更新…');
      return checkRelease();
    }).catch(() => update('暂时无法检查更新，稍后会重试。')).finally(() => { running = null; });
    return running;
  }

  return {
    state: () => current,
    check,
    onChange: (fn) => changes.on('status', fn),
    start() {
      initialTimer = setTimeout(check, 5_000);
      timer = setInterval(check, 6 * 60 * 60 * 1000);
      initialTimer.unref();
      timer.unref();
    },
    stop() { clearTimeout(initialTimer); clearInterval(timer); }
  };
}

module.exports = { createUpdater, makeStore, releasePage };
