const { Readable } = require('node:stream');

function createUpdateFetcher(net) {
  return (url, { signal, headers }) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // Chromium uses the system proxy. net.fetch cannot expose manual redirects
    // in this Electron version; the updater must validate every redirect target.
    const request = net.request({ url, headers, redirect: 'manual' });
    const abort = () => {
      request.abort();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    request.on('error', (error) => {
      cleanup();
      reject(error);
    });
    request.once('redirect', (status, _method, location) => {
      cleanup();
      request.abort();
      resolve(new Response(null, { status, headers: { Location: location } }));
    });
    request.once('response', (response) => {
      response.once('close', () => {
        cleanup();
        if (!response.readableEnded) request.abort();
      });
      const status = response.statusCode;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => response.headers[name.toLowerCase()] ?? null },
        body: Readable.toWeb(response, { strategy: { size: (chunk) => chunk.byteLength } })
      });
    });
    request.end();
  });
}

module.exports = { createUpdateFetcher };
