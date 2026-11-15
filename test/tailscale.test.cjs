const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTailscale, serveArgs } = require('../desktop/tailscale.cjs');

const host = 'paper-pc.example.ts.net';
const ports = { localPort: '8789', httpsPort: '8443' };
const origin = 'http://127.0.0.1:8789';

function fixtures() {
  const changes = [];
  let settings = {};
  const route = {
    TCP: { 8443: { HTTPS: true } },
    Web: { [host + ':8443']: { Handlers: { '/': { Proxy: origin } } } }
  };
  const serve = createTailscale({
    find: () => 'tailscale.exe',
    async command(_, args) {
      if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: host + '.' } });
      if (args[1] === 'status') return JSON.stringify(settings);
      changes.push(args);
      settings = args.at(-1) === 'off' ? {} : route;
    },
    probe: async (_, pairing) => ({ canInvite: pairing?.role === 1 }),
    verifyHttps: async (url) => url === 'https://' + host + ':8443'
  });
  return { serve, changes, route, setConfig: (value) => { settings = value; } };
}

test('Serve starts and stops just the selected private HTTPS route', async () => {
  const { serve, changes } = fixtures();
  assert.deepEqual(serveArgs(), ['serve', '--bg', 'http://127.0.0.1:8787']);
  const result = await serve.update('start', ports, { role: 1 });
  assert.equal(result.state, 'active');
  assert.equal(result.url, 'https://' + host + ':8443');
  assert.equal(result.canInvite, true);
  assert.deepEqual(changes, [['serve', '--bg', '--https=8443', origin]]);
  await serve.update('start', ports);
  assert.equal(changes.length, 1, 'already-active Serve should not be overwritten');
  assert.equal((await serve.update('stop', ports)).state, 'ready');
  assert.deepEqual(changes[1], ['serve', '--bg', '--https=8443', origin, 'off']);
});

test('invalid ports and other Serve or Funnel routes never reach the mutation command', async () => {
  const { serve, changes, route, setConfig } = fixtures();
  await assert.rejects(serve.update('start', { localPort: '1 & whoami', httpsPort: '443' }), /整数/);
  setConfig({ ...route, AllowFunnel: { [host + ':8443']: true } });
  assert.equal((await serve.update('start', ports)).state, 'occupied');
  assert.equal((await serve.update('stop', ports)).state, 'occupied');
  setConfig({ Foreground: { session: route } });
  assert.equal((await serve.update('start', ports)).state, 'occupied');
  setConfig(route);
  assert.equal((await serve.update('start', { localPort: '8787', httpsPort: '8443' })).state, 'occupied');
  assert.deepEqual(changes, []);
});
