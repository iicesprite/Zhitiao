const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { repository, assetName, signUpdate } = require('../desktop/update-trust.cjs');
const { createUpdateFetcher } = require('../desktop/update-network.cjs');
const { makeStore, createUpdater } = require('../desktop/updater.cjs');

const runtime = '45.3.2';
const base = '0.3.0';
const version = '0.3.1';
const bytes = Buffer.from('test ASAR bytes');
const key = generateKeyPairSync('ed25519');
const payload = signUpdate(bytes, version, runtime, key.privateKey);
const assetsUrl = 'https://github.com/' + repository + '/releases/download/v' + version + '/';
const manifestUrl = 'https://github.com/' + repository + '/releases/latest/download/zhitiao-update.json';
const filename = assetName(version, runtime);

function testStore(t) {
  const cache = path.resolve('.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, 'test-updater-'));
  t.after(() => {
    if (path.dirname(directory) === cache && path.basename(directory).startsWith('test-updater-')) {
      rmSync(directory, { force: true, recursive: true });
    }
  });
  return makeStore({ directory, runtime, publicKey: key.publicKey });
}

function github({ archive = bytes, record = payload, redirect = null } = {}) {
  return async (url) => {
    if (url === manifestUrl) return Response.json(record);
    if (url === assetsUrl + filename) return redirect ? Response.redirect(redirect) : new Response(archive);
    throw new Error('Unexpected request: ' + url);
  };
}

const withGithub = (store, options) => createUpdater({
  store, version: base, runtime, publicKey: key.publicKey, fetcher: github(options)
});

test('a signed GitHub release is staged and becomes active only after the GUI confirms startup', async (t) => {
  const store = testStore(t);
  const updater = withGithub(store);
  assert.equal((await updater.check()).readyVersion, version);
  assert.equal(store.read().active, undefined);
  const launch = store.select(base);
  assert.equal(launch.version, version);
  assert.equal(launch.trial, true);
  store.confirm(version);
  assert.equal(store.select(base).version, version);
  assert.equal(store.select(base).trial, false);
  writeFileSync(launch.archive, Buffer.from('changed after download'));
  assert.equal(store.select(base).version, base);
});

test('unsigned, altered and off-origin downloads never stage an update', async (t) => {
  const store = testStore(t);
  const anotherKey = generateKeyPairSync('ed25519');
  const forged = signUpdate(bytes, version, runtime, anotherKey.privateKey);
  assert.match((await withGithub(store, { record: forged }).check()).message, /签名校验失败/);
  assert.match((await withGithub(store, { archive: Buffer.alloc(bytes.length) }).check()).message, /更新包校验失败/);
  await withGithub(store, { redirect: 'https://example.com/update.asar' }).check();
  assert.equal(store.read().pending, undefined);
  assert.equal(store.select(base).version, base);
});

test('the Electron transport leaves redirect validation to the updater and streams the signed archive', async (t) => {
  const store = testStore(t);
  const redirectedManifest = 'https://release-assets.githubusercontent.com/manifest';
  const redirectedArchive = 'https://release-assets.githubusercontent.com/archive';
  let archiveTarget = 'https://example.com/archive';
  const requests = [];
  const cancelled = [];
  const net = {
    request({ url, redirect }) {
      assert.equal(redirect, 'manual');
      requests.push(url);
      const request = new EventEmitter();
      request.abort = () => cancelled.push(url);
      request.end = () => {
        if (url === manifestUrl || url === assetsUrl + filename) {
          request.emit('redirect', 302, 'GET', url === manifestUrl ? redirectedManifest : archiveTarget);
          return;
        }
        assert.ok([redirectedManifest, redirectedArchive].includes(url));
        const body = url === redirectedManifest ? Buffer.from(JSON.stringify(payload)) : bytes;
        const response = Readable.from([body]);
        response.statusCode = 200;
        response.headers = { 'content-length': String(body.length) };
        request.emit('response', response);
      };
      return request;
    }
  };
  const updater = createUpdater({
    store, version: base, runtime, publicKey: key.publicKey, fetcher: createUpdateFetcher(net)
  });
  const expected = [manifestUrl, redirectedManifest, assetsUrl + filename];
  assert.equal((await updater.check()).readyVersion, null);
  assert.deepEqual(requests.splice(0), expected);
  assert.deepEqual(cancelled.splice(0), [manifestUrl, assetsUrl + filename]);
  assert.equal(store.read().pending, undefined);

  archiveTarget = redirectedArchive;
  assert.equal((await updater.check()).readyVersion, version);
  assert.deepEqual(requests, [...expected, redirectedArchive]);
});

test('a GitHub connection timeout gives a specific message and the next check can succeed', async (t) => {
  const store = testStore(t);
  let calls = 0;
  const updater = createUpdater({
    store, version: base, runtime, publicKey: key.publicKey,
    fetcher: (url) => {
      if (calls++ === 0) throw new Error('net::ERR_CONNECTION_TIMED_OUT');
      return github()(url);
    }
  });
  assert.match((await updater.check()).message, /连接 GitHub 超时.*系统代理/);
  assert.equal((await updater.check()).readyVersion, version);
});

test('the deadline applies while downloading the response body', async (t) => {
  const store = testStore(t);
  const controller = new AbortController();
  const setDeadline = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const updater = createUpdater({
    store, version: base, runtime, publicKey: key.publicKey,
    fetcher: async (url, { signal }) => {
      if (url === manifestUrl) return Response.json(payload);
      assert.equal(url, assetsUrl + filename);
      assert.equal(signal, controller.signal);
      return new Response(new ReadableStream({
        pull() {
          controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
          throw new Error('Response stream closed');
        }
      }));
    }
  });
  assert.match((await updater.check()).message, /连接 GitHub 超时/);
  assert.equal(setDeadline.mock.callCount(), 2);
  assert.equal(setDeadline.mock.calls[1].arguments[0], 18_000);
  assert.equal(store.read().pending, undefined);
});

test('an interrupted or crashing first run falls back to the previously confirmed update', (t) => {
  const store = testStore(t);
  store.stage(payload, bytes);
  store.select(base);
  store.confirm(version);
  const badVersion = '0.3.2';
  store.stage(signUpdate(bytes, badVersion, runtime, key.privateKey), bytes);
  assert.equal(store.select(base).version, badVersion);
  assert.equal(store.select(base).version, version);
  assert.equal(store.read().failed, badVersion);
});
