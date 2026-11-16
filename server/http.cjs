const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { openStore, RequestError } = require('./store.cjs');
const { imageRequestLimit } = require('../shared/media.cjs');

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

async function readBody(request, max = 16 * 1024) {
  if (request.headers['content-type'] !== 'application/json') {
    throw new RequestError(415, '请求必须是 JSON。');
  }
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > max) throw new RequestError(413, '请求内容过长。');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // The same response covers malformed JSON and a non-object body.
  }
  throw new RequestError(400, '请求内容无效。');
}

function createNoteServer({ dbPath, setupKey, now, waitMs = 5000, presenceMs = 12_000, presenceClock = Date.now }) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const store = openStore(dbPath, { setupKey, now });
  const changes = new EventEmitter();
  const online = new Map();
  let revision = randomUUID();

  function publish() {
    revision = randomUUID();
    changes.emit('state');
  }

  function maintain() {
    const changed = store.maintain();
    let disconnected = false;
    for (const [id, deadline] of online) {
      if (presenceClock() >= deadline) {
        online.delete(id);
        disconnected = true;
      }
    }
    if (changed || disconnected) publish();
  }

  function markOnline(id) {
    const justConnected = !online.has(id);
    online.set(id, presenceClock() + presenceMs);
    if (justConnected) publish();
  }

  function authenticate(request) {
    const header = request.headers.authorization;
    return store.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : null);
  }

  function sendState(response, id, after) {
    const ready = () => {
      const state = store.state(id, revision);
      if (state.partner) state.partner.online = online.has(state.partner.id);
      json(response, 200, state);
    };
    if (after !== revision) return ready();

    function clean() {
      clearTimeout(timer);
      changes.off('state', complete);
      response.off('close', clean);
    }
    function complete() {
      clean();
      try {
        ready();
      } catch (error) {
        console.error(error);
        if (!response.destroyed) json(response, 500, { error: '服务暂时无法处理请求。' });
      }
    }
    const timer = setTimeout(complete, waitMs);
    changes.once('state', complete);
    response.once('close', clean);
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });

      if (request.method === 'POST' && ['/api/create', '/api/join'].includes(url.pathname)) {
        const body = await readBody(request);
        const result = url.pathname === '/api/create' ? store.create(body) : store.join(body);
        publish();
        return json(response, 201, result);
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        const id = authenticate(request);
        maintain();
        markOnline(id);
        return sendState(response, id, url.searchParams.get('after'));
      }

      if (request.method === 'POST' && url.pathname === '/api/offline') {
        if (online.delete(authenticate(request))) publish();
        return json(response, 200, { ok: true });
      }

      const imageGet = /^\/api\/images\/([1-9]\d{0,14})$/.exec(url.pathname);
      if (request.method === 'GET' && imageGet) {
        const id = authenticate(request);
        maintain();
        return json(response, 200, store.imageFor(id, Number(imageGet[1])));
      }
      if (request.method === 'POST' && ['/api/command', '/api/images'].includes(url.pathname)) {
        const id = authenticate(request);
        const withImage = url.pathname === '/api/images';
        const body = await readBody(request, withImage ? imageRequestLimit : undefined);
        if (withImage) body.action = 'send-image';
        else if (body.action === 'send-image') throw new RequestError(400, '请使用图片发送入口。');
        maintain();
        if (['send', 'send-image', 'request'].includes(body.action) && !online.has(3 - id)) {
          throw new RequestError(409, '对方离线，等 TA 上线后再发吧。');
        }
        if (store.command(id, body)) publish();
        return json(response, 200, { ok: true });
      }

      json(response, 404, { error: '没有这个地址。' });
    } catch (error) {
      if (!(error instanceof RequestError)) console.error(error);
      if (response.destroyed || response.headersSent) return;
      json(response, error.status ?? 500, {
        error: error instanceof RequestError ? error.message : '服务暂时无法处理请求。'
      });
    }
  });

  const ticker = setInterval(() => {
    try {
      maintain();
    } catch (error) {
      console.error(error);
    }
  }, 1000);
  ticker.unref();
  server.once('close', () => {
    clearInterval(ticker);
    store.close();
  });
  return server;
}

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const setupKey = process.env.ZHITIAO_SETUP_KEY;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (setupKey?.length ?? 0) < 24) {
    throw new Error('公开部署时必须设置至少 24 字符的 ZHITIAO_SETUP_KEY。');
  }
  const dbPath = process.env.ZHITIAO_DB || 'data/zhitiao.sqlite';
  const server = createNoteServer({ dbPath, setupKey });
  server.listen(port, host, () => console.log('纸条服务正在监听 ' + host + ':' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
}

module.exports = { createNoteServer };
