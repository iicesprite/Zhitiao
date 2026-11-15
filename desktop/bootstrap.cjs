const { app } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createUpdater, makeStore, releasePage } = require('./updater.cjs');
const { version: bundledVersion } = require('../package.json');

if (process.env.ZHITIAO_PROFILE) app.setPath('userData', path.resolve(process.env.ZHITIAO_PROFILE));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function boot() {
  const publicKey = readFileSync(path.join(__dirname, 'update-signing.pub'), 'utf8');
  const runtime = process.versions.electron;
  const folder = path.join(app.getPath('userData'), 'updates');
  const store = makeStore({ directory: folder, runtime, publicKey });
  const bundle = path.resolve(__dirname, '..');
  const resources = path.resolve(process.resourcesPath ?? bundle);
  const packaged = app.isPackaged || bundle === path.join(resources, 'app') || bundle === path.join(resources, 'app.asar');
  const fallback = { version: bundledVersion, archive: null, trial: false };
  let candidate = fallback;
  if (packaged) {
    try { candidate = store.select(bundledVersion); } catch (error) { console.error(error); }
  }
  try {
    start(candidate);
  } catch (error) {
    console.error(error);
    if (!candidate.archive) return app.exit(1);
    try { store.reject(candidate.version); } catch (saveError) { console.error(saveError); }
    start(fallback);
  }

  function start(selected) {
    const entry = selected.archive ? path.join(selected.archive, 'desktop', 'main.cjs') : path.join(__dirname, 'main.cjs');
    const { launch } = require(entry);
    if (typeof launch !== 'function') throw new Error('The update has no desktop entry point');
    const updater = packaged ? createUpdater({ store, version: selected.version, runtime, publicKey }) : null;
    let startupTimer;
    const rollback = () => {
      clearTimeout(startupTimer);
      try { store.reject(selected.version); } catch (error) { console.error(error); }
      app.relaunch();
      app.exit(1);
    };
    launch({
      updater, releasePage,
      ready: () => {
        if (selected.trial && startupTimer) {
          store.confirm(selected.version);
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      },
      failed: selected.archive ? rollback : undefined
    });
    if (selected.trial) startupTimer = setTimeout(rollback, 18_000);
  }
}
