const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createNoteServer } = require('../server/http.cjs');
const { HOUR, KEEP } = require('../server/store.cjs');
const { seal, unseal } = require('../shared/sealed.cjs');

test('two paired clients keep notes until release, reject offline sends and expire delivered notes', async (t) => {
  let time = 1_800_000_000_000;
  let presence = time;
  const server = createNoteServer({
    dbPath: ':memory:', setupKey: 'a-test-only-setup-key-with-entropy',
    now: () => time, presenceClock: () => presence
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function call(path, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + '/api/' + path, {
      method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(6000)
    });
    return { status: response.status, body: await response.json() };
  }
  const token = () => randomBytes(32).toString('base64url');
  const [one, two, code, key] = [token(), token(), token(), token()];
  const sync = async (who) => (await call('state', { token: who })).body;
  const doAs = (who, action, fields) => call('command', { token: who, body: { action, ...fields } });
  const send = (text, clientId = randomUUID()) => doAs(one, 'send', {
    clientId, content: seal(text, key, 'note:1:' + clientId)
  });

  assert.equal((await call('state')).status, 401);
  assert.equal((await call('create', { body: { name: '猫', token: one, code } })).status, 403);
  const owner = { name: '猫', token: one, code, setupKey: 'a-test-only-setup-key-with-entropy' };
  assert.equal((await call('create', { body: owner })).status, 201);
  assert.equal((await call('create', { body: owner })).status, 201);
  const partner = { name: '兔子', token: two, code };
  assert.equal((await call('join', { body: partner })).status, 201);
  assert.equal((await call('join', { body: { ...partner, token: token() } })).status, 403);
  assert.equal((await sync(one)).partner.online, false);
  assert.equal((await send('离线时不能递纸条')).status, 409);
  await sync(two);
  assert.equal((await sync(one)).partner.online, true);

  assert.equal((await doAs(two, 'start', { mode: 'manual' })).status, 200);
  const first = await sync(one);
  assert.ok(first.partner.focusId);
  assert.equal(first.partner.focusUntil, null);
  const noteId = randomUUID();
  assert.equal((await send('第一张', noteId)).status, 200);
  assert.equal((await send('第一张', noteId)).status, 200);
  assert.equal((await send('第二张')).status, 200);
  assert.deepEqual((await sync(two)).notes, []);
  const held = (await sync(one)).notes;
  assert.equal(held.length, 2);
  assert.equal(held[0].availableAt, null);
  await doAs(two, 'ack', { ids: held.map((note) => note.id) });
  assert.equal((await sync(one)).notes[0].deliveredAt, null);

  const before = await sync(two);
  const waitForRequest = call('state?after=' + before.revision, { token: two });
  const reason = seal('有件事想跟你商量', key, 'request:' + first.partner.focusId);
  const request = { focusId: first.partner.focusId, content: reason };
  assert.equal((await doAs(one, 'request', request)).status, 200);
  assert.equal((await doAs(one, 'request', request)).status, 409);
  const { incoming } = (await waitForRequest).body;
  assert.equal(unseal(incoming.content, key, 'request:' + first.partner.focusId), '有件事想跟你商量');
  assert.equal((await doAs(one, 'answer', { id: incoming.id, decision: 'accept' })).status, 409);
  assert.equal((await doAs(two, 'answer', { id: incoming.id, decision: 'decline' })).status, 200);
  assert.equal((await sync(one)).outgoing.status, 'declined');
  assert.ok((await sync(two)).me.focusId);
  assert.deepEqual((await sync(two)).notes, []);

  await call('offline', { token: two, body: {} });
  assert.equal((await sync(one)).partner.online, false);
  assert.equal((await send('不会偷偷递出')).status, 409);
  assert.equal((await doAs(one, 'request', request)).status, 409);
  time += 2 * KEEP;
  assert.equal((await sync(one)).notes.length, 2, '未送达的纸条不受历史保留期限影响');
  await sync(two);
  assert.equal((await doAs(one, 'request', { focusId: first.partner.focusId })).status, 200);
  const again = (await sync(two)).incoming;
  assert.equal((await doAs(two, 'answer', { id: again.id, decision: 'accept' })).status, 200);
  const released = await sync(two);
  assert.equal(released.me.focusId, null);
  assert.equal(released.incoming, null);
  assert.deepEqual(released.notes.map((note) => unseal(note.content, key, 'note:1:' + note.clientId)), ['第一张', '第二张']);
  assert.deepEqual(released.notes.map((note) => note.availableAt), [time, time]);
  await doAs(two, 'ack', { ids: released.notes.map((note) => note.id) });
  time += KEEP;
  assert.deepEqual((await sync(two)).notes, []);

  assert.equal((await doAs(two, 'start', { mode: 'hour' })).status, 200);
  const timed = (await sync(one)).partner;
  assert.equal(timed.focusUntil, time + HOUR);
  assert.equal((await send('一小时后见')).status, 200);
  assert.equal((await doAs(one, 'request', { focusId: timed.focusId })).status, 200);
  presence += 13_000;
  assert.equal((await sync(one)).partner.online, false, '心跳超时后应自动离线');
  assert.equal((await send('等待重新上线')).status, 409);
  time += HOUR;
  const status = await sync(one);
  assert.equal(status.partner.focusId, null, '关机期间也会按时结束');
  assert.equal(status.outgoing.status, 'expired');
  assert.equal((await sync(two)).notes.length, 1);
});
