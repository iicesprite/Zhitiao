const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { createNoteServer } = require('../server/http.cjs');
const { KEEP } = require('../server/store.cjs');
const { invitation, pair, NoteLink } = require('../desktop/link.cjs');
const { imageLimit } = require('../shared/media.cjs');
const { moods } = require('../shared/moods.cjs');
const { unseal } = require('../shared/sealed.cjs');

test('pictures share note delivery rules and each member can update their own encrypted mood', async (t) => {
  let time = 1_800_000_000_000;
  const server = createNoteServer({ dbPath: ':memory:', now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });

  const url = 'http://127.0.0.1:' + server.address().port;
  const a = await pair('create', { name: '猫', url }, null, () => {});
  const b = await pair('join', { name: '兔', invite: invitation(a) }, null, () => {});
  const one = new NoteLink(a, {});
  const two = new NoteLink(b, {});
  const picture = readFileSync(join(__dirname, '..', 'desktop', 'ui', 'icon.png'));

  await one.call('/api/state');
  await assert.rejects(one.sendImage(picture, ''), { status: 409 });
  await two.setMood('sleepy');
  const encrypted = (await one.call('/api/state')).partner;
  assert.ok(encrypted.mood);
  assert.equal(encrypted.mood.includes('困'), false);
  assert.equal(one.memberWithMood(encrypted).mood.label, moods.sleepy);
  await one.setMood('custom', '今天有点想你 🫶');
  await assert.rejects(async () => one.setMood('custom', '😴'.repeat(41)), /40/);
  await two.call('/api/state');

  await two.command({ action: 'start', mode: 'manual' });
  const clientId = randomUUID();
  await one.sendImage(picture, '给你看', clientId);
  await one.sendImage(picture, '给你看', clientId);
  await one.send('看完再回复');
  await assert.rejects(one.sendImage(Buffer.from('<svg></svg>'), ''), /PNG/);
  const oversized = Buffer.alloc(imageLimit + 1);
  picture.copy(oversized);
  await assert.rejects(one.sendImage(oversized, ''), /8 MB/);

  const sent = (await one.call('/api/state')).notes;
  assert.equal(sent.length, 2);
  const [note] = sent;
  assert.ok(note.hasImage);
  assert.equal(note.availableAt, null);
  assert.equal(unseal(note.content, a.key, 'note:1:' + clientId), '给你看');
  assert.match(await one.readImage(note), /^data:image\/png;base64,/);
  assert.equal((await two.call('/api/state')).notes.length, 0);
  await assert.rejects(two.readImage(note), { status: 404 });
  assert.equal((await fetch(url + '/api/images/' + note.id)).status, 401);
  assert.equal(two.memberWithMood((await two.call('/api/state')).partner).mood.label, '今天有点想你 🫶');

  await two.command({ action: 'finish' });
  const received = (await two.call('/api/state')).notes;
  assert.deepEqual(received.map((value) => value.availableAt), [time, time]);
  const src = await two.readImage(received[0]);
  assert.deepEqual(Buffer.from(src.split(',')[1], 'base64'), picture);
  await two.command({ action: 'ack', ids: received.map((value) => value.id) });
  time += KEEP;
  assert.deepEqual((await one.call('/api/state')).notes, []);
  await assert.rejects(one.readImage(note), { status: 404 });
});
