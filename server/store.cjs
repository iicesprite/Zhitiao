const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { imageLimit } = require('../shared/media.cjs');

const HOUR = 60 * 60 * 1000;
const KEEP = 7 * 24 * HOUR;
const DEVICE_INVITE_LIFETIME = 10 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const isSecret = (value) => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function need(ok, status, message) {
  if (!ok) throw new RequestError(status, message);
}

function nickname(value) {
  need(typeof value === 'string' && value.trim() && [...value.trim()].length <= 16,
    400, '请输入 1 到 16 个字的昵称。');
  return value.trim();
}

function checkSealed(value, maxBytes) {
  need(typeof value === 'string' && value.length >= 38
    && value.length <= Math.ceil((28 + maxBytes) * 4 / 3) && /^[\w-]+$/.test(value),
  400, '纸条内容无效。');
  return value;
}

function schema(db) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      focus_id TEXT,
      focus_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS invite (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      code_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      sender INTEGER NOT NULL REFERENCES people(id),
      recipient INTEGER NOT NULL REFERENCES people(id),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      focus_id TEXT,
      available_at INTEGER,
      delivered_at INTEGER,
      UNIQUE (sender, client_id)
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      sender INTEGER NOT NULL REFERENCES people(id),
      recipient INTEGER NOT NULL REFERENCES people(id),
      focus_id TEXT NOT NULL,
      content TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
      resolved_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS only_one_pending
      ON requests(recipient) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS note_images (
      note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS moods (
      member INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY,
      member INTEGER NOT NULL REFERENCES people(id),
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      invite_hash TEXT,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS device_invites (
      member INTEGER PRIMARY KEY REFERENCES people(id),
      issuer INTEGER NOT NULL REFERENCES devices(id),
      code_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_receipts (
      device INTEGER NOT NULL REFERENCES devices(id),
      note INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      PRIMARY KEY (device, note)
    );
    CREATE INDEX IF NOT EXISTS device_receipts_note ON device_receipts(note);
  `);
}

function openStore(path, { now = Date.now, setupKey = '' } = {}) {
  const db = new DatabaseSync(path);
  schema(db);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args).changes;

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function registerOriginalDevice(id, tokenHash) {
    const inserted = db.prepare("INSERT INTO devices (member, token_hash, name) VALUES (?, ?, '原配对设备') ON CONFLICT(token_hash) DO NOTHING").run(id, tokenHash);
    if (inserted.changes) {
      run('INSERT INTO device_receipts (device, note) SELECT ?, id FROM notes WHERE recipient = ? AND delivered_at IS NOT NULL', inserted.lastInsertRowid, id);
    }
  }

  transaction(() => {
    for (const person of all('SELECT id, token_hash AS tokenHash FROM people')) registerOriginalDevice(person.id, person.tokenHash);
  });

  function create(body) {
    if (setupKey) {
      need(typeof body.setupKey === 'string'
        && timingSafeEqual(Buffer.from(hash(body.setupKey)), Buffer.from(hash(setupKey))),
      403, '服务端设置码不正确。');
    }
    const name = nickname(body.name);
    need(isSecret(body.token) && isSecret(body.code), 400, '配对凭据无效。');
    return transaction(() => {
      const owner = get('SELECT token_hash FROM people WHERE id = 1');
      if (owner?.token_hash === hash(body.token)) return { ok: true };
      need(!owner, 409, '这个服务已创建配对，请使用对方的邀请。');
      run('INSERT INTO people (id, name, token_hash) VALUES (1, ?, ?)', name, hash(body.token));
      registerOriginalDevice(1, hash(body.token));
      run('INSERT INTO invite (slot, code_hash) VALUES (1, ?)', hash(body.code));
      return { ok: true };
    });
  }

  function join(body) {
    const name = nickname(body.name);
    need(isSecret(body.code) && isSecret(body.token), 400, '邀请码格式不正确。');
    return transaction(() => {
      const member = get('SELECT token_hash FROM people WHERE id = 2');
      if (member?.token_hash === hash(body.token)) return { ok: true };
      need(get('SELECT slot FROM invite WHERE code_hash = ?', hash(body.code)), 403, '邀请码无效或已经使用。');
      run('INSERT INTO people (id, name, token_hash) VALUES (2, ?, ?)', name, hash(body.token));
      registerOriginalDevice(2, hash(body.token));
      run('DELETE FROM invite');
      return { ok: true };
    });
  }

  function authenticate(token) {
    if (isSecret(token)) {
      const device = get('SELECT id, member FROM devices WHERE token_hash = ? AND revoked_at IS NULL', hash(token));
      if (device) return device;
    }
    throw new RequestError(401, '配对凭据无效。');
  }

  function joinDevice(body) {
    const name = nickname(body.name);
    need(isSecret(body.token) && isSecret(body.code), 400, '设备码格式不正确。');
    const tokenHash = hash(body.token);
    const codeHash = hash(body.code);
    return transaction(() => {
      const existing = get('SELECT member, invite_hash AS inviteHash, revoked_at AS revokedAt FROM devices WHERE token_hash = ?', tokenHash);
      if (existing) {
        need(existing.revokedAt === null && existing.inviteHash === codeHash, 403, '这个设备码已失效。');
        return { role: existing.member };
      }
      const invite = get('SELECT member FROM device_invites WHERE code_hash = ? AND expires_at > ?', codeHash, now());
      need(invite, 403, '设备码已过期或已用过，请重新生成。');
      const { member } = invite;
      const inserted = db.prepare('INSERT INTO devices (member, token_hash, name, invite_hash) VALUES (?, ?, ?, ?)').run(member, tokenHash, name, codeHash);
      run('INSERT INTO device_receipts (device, note) SELECT ?, id FROM notes WHERE recipient = ? AND delivered_at IS NOT NULL', inserted.lastInsertRowid, member);
      run('DELETE FROM device_invites WHERE member = ?', member);
      return { role: member };
    });
  }

  function finishFocus(member, time, acceptedId = null) {
    run('UPDATE people SET focus_id = NULL, focus_until = NULL WHERE id = ?', member.id);
    run('UPDATE notes SET available_at = ? WHERE recipient = ? AND focus_id = ? AND available_at IS NULL',
      time, member.id, member.focus_id);
    run("UPDATE requests SET status = CASE WHEN id = ? THEN 'accepted' ELSE 'expired' END, resolved_at = ? WHERE recipient = ? AND focus_id = ? AND status = 'pending'",
      acceptedId, time, member.id, member.focus_id);
  }

  function maintain() {
    const time = now();
    const expired = all('SELECT id, focus_id FROM people WHERE focus_until <= ?', time);
    const removed = transaction(() => {
      for (const member of expired) finishFocus(member, time);
      const notes = run('DELETE FROM notes WHERE delivered_at <= ?', time - KEEP);
      const requests = run('DELETE FROM requests WHERE resolved_at <= ?', time - KEEP);
      return notes + requests;
    });
    return expired.length > 0 || removed > 0;
  }

  function state(id, revision, deviceId, onlineSince) {
    const personSql = 'SELECT p.id, p.name, p.focus_id AS focusId, p.focus_until AS focusUntil, m.content AS mood FROM people p LEFT JOIN moods m ON m.member = p.id WHERE p.id = ?';
    const me = get(personSql, id);
    const partner = get(personSql, 3 - id) ?? null;
    const notes = all(`SELECT id, client_id AS clientId, sender, content, created_at AS createdAt,
      focus_id AS focusId, available_at AS availableAt, delivered_at AS deliveredAt,
      EXISTS(SELECT 1 FROM note_images WHERE note_id = notes.id) AS hasImage,
      (COALESCE(delivered_at < ?, 0) OR EXISTS(SELECT 1 FROM device_receipts WHERE device = ? AND note = notes.id)) AS notified
      FROM notes WHERE sender = ? OR (recipient = ? AND available_at IS NOT NULL) ORDER BY id`, onlineSince, deviceId, id, id);
    const incoming = get("SELECT id, content, created_at AS createdAt FROM requests WHERE recipient = ? AND status = 'pending'", id) ?? null;
    const outgoing = get('SELECT id, status FROM requests WHERE sender = ? ORDER BY rowid DESC LIMIT 1', id) ?? null;
    const devices = all('SELECT id, name FROM devices WHERE member = ? AND revoked_at IS NULL ORDER BY id', id);
    return { revision, time: now(), me, partner, notes, incoming, outgoing, devices, deviceId };
  }

  function imageFor(id, noteId) {
    const image = get('SELECT i.content FROM note_images i JOIN notes n ON n.id = i.note_id WHERE n.id = ? AND (n.sender = ? OR (n.recipient = ? AND n.available_at IS NOT NULL))', noteId, id, id);
    need(image, 404, '找不到这张图片。');
    return image;
  }

  function command(id, body, deviceId) {
    const time = now();
    return transaction(() => {
      const me = get('SELECT id, focus_id FROM people WHERE id = ?', id);
      const partner = get('SELECT id, focus_id FROM people WHERE id = ?', 3 - id);
      switch (body.action) {
        case 'invite-device': {
          need(isSecret(body.code), 400, '设备码无效。');
          run('INSERT INTO device_invites (member, issuer, code_hash, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(member) DO UPDATE SET issuer = excluded.issuer, code_hash = excluded.code_hash, expires_at = excluded.expires_at', id, deviceId, hash(body.code), time + DEVICE_INVITE_LIFETIME);
          return true;
        }
        case 'remove-device': {
          need(Number.isSafeInteger(body.deviceId) && body.deviceId !== deviceId, 400, '请在另一台设备上移除本机。');
          need(run('UPDATE devices SET revoked_at = ? WHERE id = ? AND member = ? AND revoked_at IS NULL', time, body.deviceId, id), 404, '找不到这台设备。');
          run('DELETE FROM device_invites WHERE issuer = ?', body.deviceId);
          run('DELETE FROM device_receipts WHERE device = ?', body.deviceId);
          return true;
        }
        case 'start':
          need(!me.focus_id, 409, '你已经在闭关。');
          need(body.mode === 'hour' || body.mode === 'manual', 400, '闭关时长无效。');
          run('UPDATE people SET focus_id = ?, focus_until = ? WHERE id = ?', randomUUID(),
            body.mode === 'hour' ? time + HOUR : null, id);
          return true;
        case 'finish':
          if (!me.focus_id) return false;
          finishFocus(me, time);
          return true;
        case 'send':
        case 'send-image': {
          need(partner, 409, '配对后就能递纸条。');
          need(isId(body.clientId), 400, '纸条编号无效。');
          const content = checkSealed(body.content, 2400);
          const image = body.action === 'send-image' ? checkSealed(body.image, imageLimit) : null;
          const inserted = db.prepare('INSERT INTO notes (client_id, sender, recipient, content, created_at, focus_id, available_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sender, client_id) DO NOTHING')
            .run(body.clientId, id, partner.id, content, time, partner.focus_id, partner.focus_id ? null : time);
          if (inserted.changes && image) run('INSERT INTO note_images (note_id, content) VALUES (?, ?)', inserted.lastInsertRowid, image);
          return inserted.changes > 0;
        }
        case 'set-mood': {
          const content = checkSealed(body.content, 300);
          run('INSERT INTO moods (member, content) VALUES (?, ?) ON CONFLICT(member) DO UPDATE SET content = excluded.content', id, content);
          return true;
        }
        case 'request': {
          need(partner?.focus_id, 409, '对方已经出关了。');
          need(body.focusId === partner.focus_id, 409, '闭关状态已更新，请重新申请。');
          const pending = get("SELECT id FROM requests WHERE recipient = ? AND status = 'pending'", partner.id);
          need(!pending, 409, '已经有一个待处理的解除请求。');
          const content = body.content == null ? null : checkSealed(body.content, 360);
          run("INSERT INTO requests (id, sender, recipient, focus_id, content, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
            randomUUID(), id, partner.id, partner.focus_id, content, time);
          return true;
        }
        case 'answer': {
          need(body.decision === 'accept' || body.decision === 'decline', 400, '请选择是否结束闭关。');
          const pending = get("SELECT id FROM requests WHERE id = ? AND recipient = ? AND focus_id = ? AND status = 'pending'",
            typeof body.id === 'string' ? body.id : '', id, me.focus_id);
          need(pending, 409, '这条解除请求已处理或失效。');
          if (body.decision === 'accept') finishFocus(me, time, pending.id);
          else run("UPDATE requests SET status = 'declined', resolved_at = ? WHERE id = ?", time, pending.id);
          return true;
        }
        case 'ack': {
          need(Array.isArray(body.ids) && body.ids.length <= 200
            && body.ids.every((value) => Number.isSafeInteger(value) && value > 0), 400, '纸条回执无效。');
          const ack = db.prepare('UPDATE notes SET delivered_at = ? WHERE id = ? AND recipient = ? AND available_at IS NOT NULL AND delivered_at IS NULL');
          const receipt = db.prepare('INSERT OR IGNORE INTO device_receipts (device, note) SELECT ?, id FROM notes WHERE id = ? AND recipient = ? AND available_at IS NOT NULL');
          let updated = false;
          for (const noteId of body.ids) {
            if (ack.run(time, noteId, id).changes) updated = true;
            if (receipt.run(deviceId, noteId, id).changes) updated = true;
          }
          return updated;
        }
        default:
          throw new RequestError(400, '无法识别该操作。');
      }
    });
  }

  return { create, join, joinDevice, authenticate, maintain, state, imageFor, command, close: () => db.close() };
}

module.exports = { openStore, RequestError, HOUR, KEEP };
