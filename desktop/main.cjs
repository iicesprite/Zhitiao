const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, powerMonitor, safeStorage, screen, shell } = require('electron');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { invitation, pair, NoteLink, readdressInvitation } = require('./link.cjs');
const { createTailscale, servePorts } = require('./tailscale.cjs');

if (process.env.ZHITIAO_PROFILE) app.setPath('userData', path.resolve(process.env.ZHITIAO_PROFILE));
if (process.platform === 'win32') app.setAppUserModelId('local.zhitiao.desktop');

const ui = (file) => path.join(__dirname, 'ui', file);
const emptyState = { me: null, partner: null, notes: [], incoming: null, outgoing: null };
const windowsServer = process.platform === 'win32';
const tailscale = windowsServer ? createTailscale() : null;
const tailscalePages = new Map([
  ['serve-install', 'https://tailscale.com/docs/install/windows'],
  ['serve-dns', 'https://console.tailscale.com/admin/dns'],
  ['serve-share', 'https://console.tailscale.com/admin/machines']
]);
let config, prefs, settingsPath, link, pet, chat, bubble, tray;
let state = emptyState;
let connection = null;
let alert = null;
let alertTimer;
let drag;
let pairing = false;
let quitting = false;
let mayQuit = false;
let serveBusy = false;
let updates, updateReleasePage, readyCallback;

function readSettings() {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  settingsPath = path.join(dir, 'settings.json');
  let data = {};
  try {
    if (existsSync(settingsPath)) data = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (data.link) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error();
      config = JSON.parse(safeStorage.decryptString(Buffer.from(data.link, 'base64')));
    }
    if (config?.ready) connection = '正在连接纸条服务…';
  } catch {
    connection = '无法读取本机的配对凭据。';
  }
  let serve;
  try { serve = servePorts(data.serve); } catch { serve = servePorts(); }
  prefs = { hidden: Boolean(data.hidden), position: data.position, link: data.link, serve };
}

function savePrefs() {
  const temporary = settingsPath + '.tmp';
  writeFileSync(temporary, JSON.stringify(prefs), { mode: 0o600 });
  renameSync(temporary, settingsPath);
}

function saveConfig(next) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统暂时无法安全保存配对信息。');
  prefs.link = safeStorage.encryptString(JSON.stringify(next)).toString('base64');
  savePrefs();
  config = next;
}

function viewState() {
  return { ...state, connection, hidden: prefs.hidden, configured: Boolean(config?.ready),
    canInvite: Boolean(config?.ready && config.role === 1 && !state.partner), role: config?.role,
    tailscaleAvailable: windowsServer, servePorts: prefs.serve, updates: updates?.state() };
}

function broadcast() {
  for (const win of [pet, chat]) {
    if (win && !win.isDestroyed()) win.webContents.send('paper:state', viewState());
  }
}

function openWindow(name, options) {
  const win = new BrowserWindow({
    show: false,
    icon: ui('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    ...options
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(ui(name + '.html'));
  return win;
}

function workArea(position) {
  return (position ? screen.getDisplayNearestPoint(position) : screen.getPrimaryDisplay()).workArea;
}

const clamp = (n, min, max) => Math.max(min, Math.min(n, max));

function petPosition(saved) {
  const valid = saved && Number.isInteger(saved.x) && Number.isInteger(saved.y);
  const { x, y, width, height } = workArea(valid ? saved : null);
  return [
    clamp(valid ? saved.x : x + width - 132, x, x + width - 104),
    clamp(valid ? saved.y : y + height - 140, y, y + height - 110)
  ];
}

function createWindows() {
  const [x, y] = petPosition(prefs.position);
  pet = openWindow('pet', {
    x, y, width: 104, height: 110,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, minimizable: false
  });
  pet.once('ready-to-show', () => { if (!prefs.hidden) pet.showInactive(); });
  pet.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    togglePet(false);
  });
  pet.on('move', () => { if (bubble?.isVisible()) positionBubble(); });

  chat = openWindow('chat', {
    title: '纸条桌宠', width: 430, height: 670, minWidth: 368, minHeight: 540, backgroundColor: '#f8f3ea'
  });
  chat.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      chat.hide();
    }
  });

  bubble = openWindow('bubble', {
    width: 316, height: 178, frame: false, transparent: true, hasShadow: false,
    resizable: false, alwaysOnTop: true, skipTaskbar: true, minimizable: false
  });
  bubble.webContents.on('did-finish-load', () => {
    if (alert) bubble.webContents.send('paper:alert', alert);
  });
}

function openChat() {
  chat.show();
  chat.focus();
}

function positionBubble() {
  const { x, y, width, height } = pet.getBounds();
  const area = workArea({ x, y });
  const [w, h] = bubble.getSize();
  const nearX = prefs.hidden ? area.x + area.width - w - 16 : x + width - w;
  const nearY = prefs.hidden ? area.y + area.height - h - 20 : y - h + 6;
  bubble.setPosition(
    clamp(nearX, area.x, area.x + area.width - w),
    clamp(nearY < area.y ? y + height : nearY, area.y, area.y + area.height - h)
  );
}

function closeAlert() {
  clearTimeout(alertTimer);
  alert = null;
  if (bubble && !bubble.isDestroyed()) bubble.hide();
}

function showAlert(value) {
  clearTimeout(alertTimer);
  alert = value;
  positionBubble();
  bubble.webContents.send('paper:alert', alert);
  bubble.showInactive();
  if (value.kind === 'notes') alertTimer = setTimeout(closeAlert, 7500);
}

function petMenu() {
  return Menu.buildFromTemplate([
    { label: '打开纸条', click: openChat },
    { label: prefs.hidden ? '显示桌宠' : '收起桌宠', click: () => togglePet(prefs.hidden) },
    { type: 'separator' },
    { label: '退出纸条桌宠', click: () => app.quit() }
  ]);
}

function togglePet(visible) {
  prefs.hidden = !visible;
  if (visible) pet.showInactive();
  else pet.hide();
  savePrefs();
  tray?.setContextMenu(petMenu());
  broadcast();
}

function beginLink() {
  if (!config?.ready) return;
  link = new NoteLink(config, {
    onConnection(error) {
      connection = error;
      closeAlert();
      broadcast();
    },
    onState(next) {
      const before = state.incoming?.id;
      const reconnected = Boolean(connection);
      state = next;
      connection = null;
      broadcast();
      if (state.incoming && (reconnected || before !== state.incoming.id)) {
        showAlert({ kind: 'request', id: state.incoming.id, title: (state.partner?.name ?? '对方') + ' 想请你出关',
          text: state.incoming.text });
      } else if (!state.incoming && alert?.kind === 'request') {
        closeAlert();
      }
    },
    onNotice(notes) {
      if (alert?.kind === 'request') return;
      const fromFocus = notes.filter((note) => note.focusId).length;
      const who = state.partner?.name ?? '对方';
      const title = fromFocus === notes.length ? '闭关期间收到了 ' + fromFocus + ' 张纸条'
        : notes.length === 1 ? who + ' 给你递了张纸条' : who + ' 给你递了 ' + notes.length + ' 张纸条';
      const text = notes.length === 1 && !fromFocus ? notes[0].text : '';
      showAlert({ kind: 'notes', title, text });
    }
  });
  link.start();
}

async function handleServe(action, payload) {
  if (tailscalePages.has(action)) {
    await shell.openExternal(tailscalePages.get(action));
    return { ok: true };
  }
  if (serveBusy) throw new Error('正在处理另一次 Tailscale 操作，请稍等。');
  serveBusy = true;
  try {
    const task = action === 'serve-start' ? 'start' : action === 'serve-stop' ? 'stop' : 'status';
    const pairing = config?.ready && config.role === 1 ? config : null;
    const result = await tailscale.update(task, payload, pairing);
    if (task === 'start' && result.state === 'active') {
      prefs.serve = result.ports;
      const original = pairing && new URL(pairing.url);
      if (original && ['localhost', '127.0.0.1', '[::1]'].includes(original.hostname)
          && Number(original.port || 80) !== result.ports.localPort) {
        saveConfig({ ...pairing, url: 'http://127.0.0.1:' + result.ports.localPort });
        await link?.stop(true);
        connection = '正在连接纸条服务…';
        state = emptyState;
        beginLink();
        broadcast();
      } else {
        savePrefs();
      }
    }
    if (action === 'serve-copy-url') {
      if (!result.url) throw new Error('请先启动该端口的私有 HTTPS。');
      clipboard.writeText(result.url);
    }
    if (action === 'serve-copy-invite') {
      if (!result.canInvite) throw new Error('请先在这个端口对应的纸条服务上创建配对，再复制异地邀请码。');
      clipboard.writeText(readdressInvitation(invitation(pairing), result.url));
    }
    return { ok: true, serve: result };
  } finally {
    serveBusy = false;
  }
}

function registerIpc() {
  ipcMain.handle('paper:current', () => viewState());
  ipcMain.handle('paper:current-alert', () => alert);
  ipcMain.handle('paper:act', async (event, action, payload = {}) => {
    if (![pet.webContents, chat.webContents, bubble.webContents].includes(event.sender)) return { ok: false };
    try {
      switch (action) {
        case 'open':
          openChat();
          if (alert?.kind === 'notes') closeAlert();
          break;
        case 'dismiss':
          closeAlert();
          break;
        case 'pet-menu':
          petMenu().popup({ window: pet });
          break;
        case 'hide':
          togglePet(false);
          break;
        case 'drag-start':
          drag = { mouse: screen.getCursorScreenPoint(), bounds: pet.getBounds() };
          break;
        case 'drag-move':
          if (drag) {
            const mouse = screen.getCursorScreenPoint();
            const next = { x: drag.bounds.x + mouse.x - drag.mouse.x, y: drag.bounds.y + mouse.y - drag.mouse.y };
            pet.setPosition(...petPosition(next));
          }
          break;
        case 'drag-end':
          if (drag) {
            const { x, y } = pet.getBounds();
            prefs.position = { x, y };
            drag = null;
            savePrefs();
          }
          break;
        case 'create':
        case 'join':
          if (config?.ready || pairing) throw new Error('配对已经在进行。');
          pairing = true;
          try {
            const next = await pair(action, payload, config, saveConfig);
            saveConfig(next);
            connection = '正在连接纸条服务…';
            broadcast();
            beginLink();
          } finally {
            pairing = false;
          }
          break;
        case 'copy':
          if (!viewState().canInvite) throw new Error('目前没有待发送的邀请。');
          clipboard.writeText(invitation(config));
          break;
        case 'send':
        case 'request':
          if (!link || connection || !state.partner?.online) throw new Error('对方离线，等 TA 上线后再发吧。');
          if (action === 'send') await link.send(payload.text, payload.clientId);
          else await link.ask(payload.text, payload.focusId);
          break;
        case 'start':
        case 'finish':
        case 'answer':
          if (!link || connection) throw new Error('暂时连不上纸条服务。');
          await link.command({ ...payload, action });
          break;
        case 'serve-status':
        case 'serve-start':
        case 'serve-stop':
        case 'serve-copy-url':
        case 'serve-copy-invite':
        case 'serve-install':
        case 'serve-dns':
        case 'serve-share':
          if (!tailscale || event.sender !== chat.webContents) throw new Error('请从 Windows 的纸条面板操作。');
          return await handleServe(action, payload);
        case 'ui-ready':
          if (event.sender === chat.webContents) readyCallback?.();
          break;
        case 'update-check':
        case 'update-restart':
        case 'update-releases':
          if (!updates || event.sender !== chat.webContents) throw new Error('更新面板暂不可用。');
          if (action === 'update-check') await updates.check();
          if (action === 'update-releases') await shell.openExternal(updateReleasePage);
          if (action === 'update-restart' && updates.state().readyVersion) {
            app.relaunch();
            app.quit();
          }
          break;
        default:
          throw new Error('无法识别这个操作。');
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function launch({ updater, releasePage, ready, failed } = {}) {
  if (!app.hasSingleInstanceLock() && !app.requestSingleInstanceLock()) return app.quit();
  updates = updater;
  updateReleasePage = releasePage;
  readyCallback = ready;
  app.on('second-instance', () => { if (chat) openChat(); });
  app.on('activate', () => { if (chat) openChat(); });
  app.on('before-quit', (event) => {
    quitting = true;
    updates?.stop();
    if (mayQuit || !link) return;
    event.preventDefault();
    mayQuit = true;
    link.stop(true).finally(() => app.quit());
  });
  app.whenReady().then(() => {
    app.dock?.hide();
    readSettings();
    registerIpc();
    createWindows();
    tray = new Tray(nativeImage.createFromPath(ui('icon.png')).resize({ width: 20, height: 20 }));
    tray.setToolTip('纸条桌宠');
    tray.setContextMenu(petMenu());
    tray.on('double-click', openChat);
    powerMonitor.on('suspend', () => {
      link?.stop(true);
      if (config?.ready) connection = '正在等电脑重新联网…';
      closeAlert();
      broadcast();
    });
    powerMonitor.on('resume', () => {
      state = { ...state, incoming: null };
      link?.start();
    });
    beginLink();
    if (!config?.ready) chat.once('ready-to-show', openChat);
    updates?.onChange(broadcast);
    updates?.start();
  }).catch((error) => {
    console.error(error);
    if (failed) failed();
    else app.quit();
  });
}

if (require.main === module) launch();
module.exports = { launch };
