const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { seal, unseal, openBytes } = require('../shared/sealed.cjs');
const { imageType, imageTypeMessage } = require('../shared/media.cjs');
const { parseMood } = require('../shared/moods.cjs');

const secret = () => randomBytes(32).toString('base64url');
const isSecret = (value) => typeof value === 'string' && /^[\w-]{43}$/.test(value);

function serverUrl(input) {
  const url = new URL(input);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入服务的 HTTPS 根地址，例如 https://notes.example.com。');
  }
  return url.origin;
}

function invitation({ url, code, key }) {
  return 'ZT1.' + Buffer.from(JSON.stringify({ url, code, key })).toString('base64url');
}

function readInvitation(value) {
  try {
    if (!/^ZT1\.[\w-]{1,1200}$/.test(value)) throw new Error();
    const { url, code, key } = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8'));
    if (!isSecret(code) || !isSecret(key)) throw new Error();
    return { url: serverUrl(url), code, key };
  } catch {
    throw new Error('邀请码不完整，请重新复制对方给你的整段邀请码。');
  }
}

function readdressInvitation(value, input) {
  const invite = readInvitation(value.trim());
  let url;
  try {
    url = serverUrl(input?.trim());
    if (!url.startsWith('https://')) throw new Error();
  } catch {
    throw new Error('请提供新的 HTTPS 服务根地址。');
  }
  return invitation({ ...invite, url });
}

async function api(url, path, { token, body, signal, timeout = 8500 } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const expiry = AbortSignal.timeout(timeout);
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, expiry]) : expiry
  }).catch(() => {
    throw new Error('暂时连不上纸条服务。');
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) {
    const error = new Error(value?.error ?? '服务未能处理这个操作。');
    error.status = response.status;
    throw error;
  }
  return value;
}

async function pair(kind, fields, previous, savePending) {
  const name = fields.name?.trim();
  if (!name || [...name].length > 16) throw new Error('请输入 1 到 16 个字的昵称。');
  let config;
  if (kind === 'create') {
    let url;
    try { url = serverUrl(fields.url?.trim()); } catch { throw new Error('请输入纸条服务的 HTTPS 根地址。'); }
    config = previous?.url === url && previous.role === 1 ? previous : {
      url, code: secret(), key: secret(), token: secret(), role: 1
    };
  } else {
    const invite = readInvitation(fields.invite?.trim());
    config = previous?.code === invite.code && previous?.url === invite.url && previous.role === 2
      ? previous : { ...invite, token: secret(), role: 2 };
  }
  savePending(config);
  const { url, token, code } = config;
  await api(url, '/api/' + kind, { body: { name, token, code, setupKey: fields.setupKey?.trim() } });
  return { ...config, ready: true };
}

class NoteLink {
  constructor(config, { onState, onNotice, onConnection }) {
    this.config = config;
    this.onState = onState;
    this.onNotice = onNotice;
    this.onConnection = onConnection;
    this.announced = new Set();
  }

  start() {
    if (this.controller) return;
    this.controller = new AbortController();
    this.poll(this.controller.signal);
  }

  stop(notify = false) {
    this.controller?.abort();
    this.controller = null;
    if (notify) return this.call('/api/offline', { body: {}, timeout: 950 }).catch(() => {});
  }

  call(path, options) {
    return api(this.config.url, path, { token: this.config.token, ...options });
  }

  async poll(signal) {
    let revision = '';
    while (!signal.aborted) {
      try {
        const data = await this.call('/api/state?after=' + revision, { signal });
        if (signal.aborted) return;
        revision = data.revision;
        await this.update(data, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.onConnection(error.message);
        if (error.status === 401) {
          this.controller = null;
          return;
        }
        await delay(1300, undefined, { signal }).catch(() => {});
      }
    }
  }

  decode(content, purpose) {
    try {
      return { text: unseal(content, this.config.key, purpose), readable: true };
    } catch {
      return { text: '这条内容无法解密。', readable: false };
    }
  }

  memberWithMood(member) {
    if (!member) return null;
    const { mood: encrypted, ...info } = member;
    let mood = null;
    if (encrypted) {
      try {
        const { kind, text } = JSON.parse(unseal(encrypted, this.config.key, 'mood:' + member.id));
        mood = parseMood(kind, text);
      } catch {
        // Keep chat usable if a saved mood cannot be read.
      }
    }
    return { ...info, mood };
  }

  async update(data, signal) {
    const notes = data.notes.map(({ content, ...note }) => ({
      ...note, ...this.decode(content, 'note:' + note.sender + ':' + note.clientId)
    }));
    const { incoming, ...state } = data;
    const request = incoming && {
      id: incoming.id,
      text: incoming.content ? this.decode(incoming.content, 'request:' + data.me.focusId).text : ''
    };
    const waiting = notes.filter((note) => note.sender !== data.me.id && note.deliveredAt === null);
    const newlyArrived = waiting.filter((note) => !this.announced.has(note.id));
    this.onState({ ...state, me: this.memberWithMood(data.me), partner: this.memberWithMood(data.partner), notes, incoming: request });
    if (newlyArrived.length) {
      for (const note of newlyArrived) this.announced.add(note.id);
      this.onNotice(newlyArrived);
    }
    for (const note of notes) {
      if (note.deliveredAt !== null) this.announced.delete(note.id);
    }
    const readable = waiting.filter((note) => note.readable);
    for (let index = 0; index < readable.length; index += 200) {
      const ids = readable.slice(index, index + 200).map((note) => note.id);
      await this.call('/api/command', { body: { action: 'ack', ids }, signal });
    }
  }

  async send(text, clientId) {
    const id = typeof clientId === 'string' ? clientId : randomUUID();
    if (typeof text !== 'string' || !text.trim() || [...text.trim()].length > 600) {
      throw new Error('纸条可以写 1 到 600 个字。');
    }
    await this.command({
      action: 'send', clientId: id,
      content: seal(text.trim(), this.config.key, 'note:' + this.config.role + ':' + id)
    });
  }

  async sendImage(bytes, caption, clientId) {
    if (!imageType(bytes)) throw new Error(imageTypeMessage);
    if (typeof caption !== 'string' || [...caption.trim()].length > 600) throw new Error('图片附言最多 600 个字。');
    const id = typeof clientId === 'string' ? clientId : randomUUID();
    const prefix = this.config.role + ':' + id;
    try {
      await this.call('/api/images', {
        body: {
          clientId: id,
          content: seal(caption.trim() || '[图片]', this.config.key, 'note:' + prefix),
          image: seal(bytes, this.config.key, 'image:' + prefix)
        },
        timeout: 120_000
      });
    } catch (error) {
      if (error.status === 404) throw new Error('纸条服务需要更新后才能发送图片。');
      throw error;
    }
  }

  async readImage(note) {
    const { content } = await this.call('/api/images/' + note.id, { timeout: 120_000 });
    const bytes = openBytes(content, this.config.key, 'image:' + note.sender + ':' + note.clientId);
    const mime = imageType(bytes);
    if (!mime) throw new Error('无法显示这张图片。');
    return 'data:' + mime + ';base64,' + bytes.toString('base64');
  }

  setMood(kind, text) {
    const mood = parseMood(kind, text);
    const clean = JSON.stringify({ kind: mood.kind, text: mood.text });
    return this.command({ action: 'set-mood', content: seal(clean, this.config.key, 'mood:' + this.config.role) });
  }

  async ask(text, focusId) {
    if (typeof text !== 'string' || [...text.trim()].length > 90) {
      throw new Error('原因最多写 90 个字。');
    }
    await this.command({
      action: 'request', focusId,
      content: text.trim() ? seal(text.trim(), this.config.key, 'request:' + focusId) : null
    });
  }

  command(body) {
    return this.call('/api/command', { body });
  }
}

module.exports = { invitation, pair, NoteLink, readdressInvitation };
