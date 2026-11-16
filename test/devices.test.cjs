const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createNoteServer } = require('../server/http.cjs');
const { invitation, pair, NoteLink } = require('../desktop/link.cjs');

test('two devices are one member with independent presence and note notifications', async (t) => {
  let now = 1_800_000_000_000;
  const server = createNoteServer({ dbPath: ':memory:', now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const owner = await pair('create', { name: '主人', url }, null, () => {});
  const partner = await pair('join', { name: '对方', invite: invitation(owner) }, null, () => {});
  const notices = [[], []];
  const watch = (config, received) => new NoteLink(config, {
    onState() {}, onNotice(notes) { received.push(...notes.map(({ text }) => text)); }
  });
  const dorm = watch(owner, notices[0]);
  const other = new NoteLink(partner, {});
  const state = (link) => link.call('/api/state');
  await state(dorm);
  await state(other);
  await other.send('已有历史');
  await dorm.update(await state(dorm));
  assert.deepEqual(notices[0].splice(0), ['已有历史']);

  let pending;
  const code = await dorm.inviteDevice();
  const fields = { name: '工位电脑', invite: code };
  const enrolled = await pair('join-device', fields, null, (value) => { pending = value; });
  assert.equal(enrolled.role, owner.role);
  assert.notEqual(enrolled.token, owner.token);
  assert.equal((await pair('join-device', fields, pending, () => {})).token, enrolled.token);
  await assert.rejects(pair('join-device', fields, null, () => {}), { status: 403 });
  const desk = watch(enrolled, notices[1]);
  await desk.update(await state(desk));
  assert.deepEqual(notices[1], []);

  await desk.setMood('happy');
  assert.equal(dorm.memberWithMood((await state(dorm)).me).mood.kind, 'happy');
  await dorm.command({ action: 'start', mode: 'manual' });
  assert.ok((await state(desk)).me.focusId);
  await other.send('出关见');
  assert.equal((await state(desk)).notes.length, 1);
  await desk.command({ action: 'finish' });
  await dorm.update(await state(dorm));
  // The first device has already acknowledged delivery when the second polls.
  assert.ok((await state(desk)).notes.at(-1).deliveredAt);
  await desk.update(await state(desk));
  await desk.update(await state(desk));
  assert.deepEqual(notices.map((notes) => notes.splice(0)), [['出关见'], ['出关见']]);

  await desk.stop(true);
  assert.equal((await state(other)).partner.online, true);
  await other.send('宿舍收到了');
  await dorm.update(await state(dorm));
  now++;
  const reconnected = await state(desk);
  await desk.update(reconnected);
  assert.deepEqual(notices[1], []);
  assert.equal(reconnected.notes.at(-1).notified, 1);
  await dorm.stop(true);
  assert.equal((await state(other)).partner.online, true);
  await desk.stop(true);
  assert.equal((await state(other)).partner.online, false);
  await assert.rejects(other.send('都已离线'), { status: 409 });

  await assert.rejects(other.command({ action: 'remove-device', deviceId: reconnected.deviceId }), { status: 404 });
  await dorm.command({ action: 'remove-device', deviceId: reconnected.deviceId });
  await assert.rejects(state(desk), { status: 401 });
  await assert.rejects(pair('join-device', fields, pending, () => {}), { status: 403 });
  const expiredCode = await dorm.inviteDevice();
  now += 10 * 60 * 1000;
  await assert.rejects(pair('join-device', { ...fields, invite: expiredCode }, null, () => {}), { status: 403 });
  const token = randomBytes(32).toString('base64url');
  await assert.rejects(new NoteLink({ url, token }, {}).inviteDevice(), { status: 401 });
});
