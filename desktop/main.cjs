const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, powerMonitor, safeStorage, screen, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { open } = require('node:fs/promises');
const path = require('node:path');
const { imageLimit, imageType, imageTypeMessage } = require('../shared/media.cjs');
const { moods } = require('../shared/moods.cjs');
const { invitation, pair, NoteLink, readdressInvitation } = require('./link.cjs');
const { createTailscale, servePorts } = require('./tailscale.cjs');
const { sourceEntry, restartLocalServer } = require('./local-server.cjs');

if (process.env.ZHITIAO_PROFILE) app.setPath('userData', path.resolve(process.env.ZHITIAO_PROFILE));
if (process.platform === 'win32') app.setAppUserModelId('local.zhitiao.desktop');

const ui = (file) => path.join(__dirname, 'ui', file);
const emptyState = { me: null, partner: null, notes: [], incoming: null, outgoing: null };
const petSize = { width: 104, height: 110 };
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
let credentialsExpired = false;
let alert = null;
let petAnchor, visiblePetAnchor, petDisplay;
let petNotice = null;
let petNoticeTimer, hiddenNoteCount = 0, noticeId = 0;
let drag;
let selectedImage;
let pairing = false;
let quitting = false;
let mayQuit = false;
let serveBusy = false;
let localServerBusy = false;
let quitAfterLocalServer = false;
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
  prefs = { hidden: Boolean(data.hidden), position: data.position, link: data.link, serve,
    serverDirectory: data.serverDirectory, serverDatabase: data.serverDatabase };
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
    moods, credentialsExpired, tailscaleAvailable: windowsServer, servePorts: prefs.serve, updates: updates?.state(),
    serverDirectory: prefs.serverDirectory, serverDatabase: prefs.serverDatabase };
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
    clamp(valid ? saved.x : x + width - 132, x, x + width - petSize.width),
    clamp(valid ? saved.y : y + height - 140, y, y + height - petSize.height)
  ];
}

function layoutPet() {
  visiblePetAnchor = petAnchor;
  let bounds = { ...petAnchor, ...petSize };
  petDisplay = { x: 0, y: 0, notice: petNotice };
  if (petNotice) {
    const area = workArea(petAnchor);
    const width = Math.min(284, area.width - 12);
    const height = petNotice.kind === 'notes' ? 124 : 93;
    const center = petAnchor.x + petSize.width / 2;
    const left = clamp(Math.round(center - width / 2), area.x + 6, area.x + area.width - width - 6);
    const y = Math.max(petAnchor.y, area.y + height + 16);
    const top = y - height - 12;
    visiblePetAnchor = { x: petAnchor.x, y };
    bounds.x = Math.min(petAnchor.x, left - 5);
    bounds.y = top - 4;
    bounds.width = Math.max(petAnchor.x + petSize.width, left + width + 5) - bounds.x;
    bounds.height = y + petSize.height - bounds.y;
    petDisplay = {
      x: petAnchor.x - bounds.x, y: y - bounds.y, notice: petNotice,
      speech: { x: left - bounds.x, bottom: petSize.height + 12, width, tailX: center - left }
    };
  }
  const current = pet.getBounds();
  if (Object.keys(bounds).some((key) => bounds[key] !== current[key])) pet.setBounds(bounds);
  pet.webContents.send('paper:pet-display', petDisplay);
  if (bubble?.isVisible()) positionBubble();
}

function closePetNotice() {
  if (!petNotice) return;
  clearTimeout(petNoticeTimer);
  petNotice = null;
  layoutPet();
}

function showPetNotice(kind, title, text) {
  if (prefs.hidden) return;
  clearTimeout(petNoticeTimer);
  petNotice = { id: ++noticeId, kind, title, text };
  layoutPet();
  petNoticeTimer = setTimeout(closePetNotice, kind === 'notes' ? 7500 : 4800);
}

function createWindows() {
  const [x, y] = petPosition(prefs.position);
  petAnchor = visiblePetAnchor = { x, y };
  petDisplay = { x: 0, y: 0, notice: null };
  pet = openWindow('pet', {
    x, y, ...petSize, acceptFirstMouse: true,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, minimizable: false
  });
  pet.once('ready-to-show', () => { if (!prefs.hidden) pet.showInactive(); });
  pet.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    togglePet(false);
  });

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
  hiddenNoteCount = 0;
  tray?.setToolTip('纸条桌宠');
  closePetNotice();
  chat.show();
  chat.focus();
}

function positionBubble() {
  const { x, y } = visiblePetAnchor;
  const { width, height } = petSize;
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
  alert = null;
  if (bubble && !bubble.isDestroyed()) bubble.hide();
}

function showAlert(value) {
  alert = value;
  positionBubble();
  bubble.webContents.send('paper:alert', alert);
  bubble.showInactive();
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
  if (visible) {
    pet.showInactive();
    if (hiddenNoteCount) showPetNotice('notes', '收到了 ' + hiddenNoteCount + ' 张纸条', '');
    hiddenNoteCount = 0;
    tray?.setToolTip('纸条桌宠');
  } else {
    pet.hide();
    closePetNotice();
  }
  savePrefs();
  tray?.setContextMenu(petMenu());
  broadcast();
}

function beginLink() {
  if (!config?.ready) return;
  link = new NoteLink(config, {
    onConnection(error, status) {
      connection = error;
      credentialsExpired = status === 401;
      closeAlert();
      broadcast();
    },
    onState(next) {
      const before = state.incoming?.id;
      const reconnected = Boolean(connection);
      state = next;
      connection = null;
      credentialsExpired = false;
      broadcast();
      if (state.incoming && (reconnected || before !== state.incoming.id)) {
        showAlert({ kind: 'request', id: state.incoming.id, title: (state.partner?.name ?? '对方') + ' 想请你出关',
          text: state.incoming.text });
      } else if (!state.incoming && alert) {
        closeAlert();
      }
    },
    onNotice(notes) {
      if (prefs.hidden) {
        hiddenNoteCount += notes.length;
        tray?.setToolTip('纸条桌宠 · ' + hiddenNoteCount + ' 张新纸条');
        return;
      }
      const fromFocus = notes.filter((note) => note.focusId).length;
      const who = state.partner?.name ?? '对方';
      const single = notes.length === 1 && !fromFocus ? notes[0] : null;
      const title = fromFocus === notes.length ? '闭关期间收到了 ' + fromFocus + ' 张纸条'
        : single ? who + (single.hasImage ? ' 给你递了张图片' : ' 给你递了张纸条')
        : who + ' 给你递了 ' + notes.length + ' 张纸条';
      const text = single?.hasImage && single.text === '[图片]' ? '' : single?.text;
      showPetNotice('notes', title, text ?? '');
    }
  });
  link.start();
}

async function copyDeviceInvite() {
  if (!link || connection || !state.devices) throw new Error('请先连接支持多设备的纸条服务。');
  let address = new URL(config.url);
  if (['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) {
    if (!tailscale || Number(address.port || 80) !== prefs.serve.localPort) {
      throw new Error('请在「异地连接」配置纸条服务对应端口的 Tailscale 私有 HTTPS。');
    }
    const result = await tailscale.update('status', prefs.serve, config);
    if (!result.url) throw new Error('请先在「异地连接」启动 Tailscale Serve。');
    if (!result.localReady) throw new Error('请确认 Tailscale Serve 指向当前配对使用的纸条服务。');
    address = new URL(result.url);
  }
  clipboard.writeText(await link.inviteDevice(address.origin));
}

async function handleServe(action, payload) {
  if (tailscalePages.has(action)) {
    await shell.openExternal(tailscalePages.get(action));
    return { ok: true };
  }
  if (serveBusy || localServerBusy) throw new Error('正在处理连接操作，请稍等。');
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

async function handleLocalServer(action, payload) {
  if (serveBusy || localServerBusy) throw new Error('正在处理连接操作，请稍等。');
  localServerBusy = true;
  try {
    if (action === 'server-directory' || action === 'server-database') {
      const directory = action === 'server-directory';
      const result = await dialog.showOpenDialog(chat, {
        title: directory ? '选择纸条源码目录' : '选择现有纸条数据库',
        properties: [directory ? 'openDirectory' : 'openFile']
      });
      if (result.canceled || !result.filePaths[0]) return { ok: true };
      if (directory) {
        const source = await sourceEntry(result.filePaths[0]).catch(() => { throw new Error('请选择包含 package.json 和 server 文件夹的纸条源码目录。'); });
        prefs.serverDirectory = source.root;
      } else {
        prefs.serverDatabase = result.filePaths[0];
      }
      savePrefs();
      broadcast();
      return { ok: true };
    }
    if (!prefs.serverDirectory || !config?.ready) throw new Error('请先选择纸条源码目录并完成本机配对。');
    const { localPort } = servePorts(payload);
    const result = await restartLocalServer({
      directory: prefs.serverDirectory, database: prefs.serverDatabase, config, port: localPort,
      logFile: path.join(app.getPath('userData'), 'paper-server.log')
    });
    return { ok: true, message: '纸条服务 ' + result.version + ' 已在端口 ' + result.port + ' 启动。' };
  } finally {
    localServerBusy = false;
    if (quitAfterLocalServer) app.quit();
  }
}

async function chooseImage() {
  const result = await dialog.showOpenDialog(chat, {
    title: '给纸条选一张图片', properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: true };
  const file = result.filePaths[0];
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > imageLimit) throw new Error(imageTypeMessage);
    const chunks = [];
    for await (const chunk of handle.createReadStream({ end: imageLimit, autoClose: false })) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (!imageType(bytes)) throw new Error(imageTypeMessage);
    const id = randomUUID();
    selectedImage = { id, bytes };
    return { ok: true, image: { id, name: path.basename(file) } };
  } finally {
    await handle.close();
  }
}

function registerIpc() {
  ipcMain.handle('paper:current', () => viewState());
  ipcMain.handle('paper:current-alert', () => alert);
  ipcMain.handle('paper:current-pet-display', () => petDisplay);
  ipcMain.handle('paper:act', async (event, action, payload = {}) => {
    if (![pet.webContents, chat.webContents, bubble.webContents].includes(event.sender)) return { ok: false };
    try {
      switch (action) {
        case 'open':
          openChat();
          break;
        case 'mood-peek':
          if (event.sender !== pet.webContents) break;
          if (state.partner) {
            showPetNotice('mood', state.partner.name + ' 的心情', state.partner.mood?.label ?? '对方还没设置心情。');
          } else {
            showPetNotice('mood', '对方的心情', connection ?? '配对后就能看到对方的心情。');
          }
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
          drag = { mouse: screen.getCursorScreenPoint(), origin: visiblePetAnchor, moved: false };
          break;
        case 'drag-move':
          if (drag) {
            const mouse = screen.getCursorScreenPoint();
            const next = { x: drag.origin.x + mouse.x - drag.mouse.x, y: drag.origin.y + mouse.y - drag.mouse.y };
            const [x, y] = petPosition(next);
            petAnchor = { x, y };
            drag.moved = true;
            if (petNotice) closePetNotice();
            else layoutPet();
          }
          break;
        case 'drag-end':
          if (drag?.moved) {
            prefs.position = petAnchor;
            savePrefs();
          }
          drag = null;
          break;
        case 'create':
        case 'join':
        case 'join-device':
          if (event.sender !== chat.webContents) throw new Error('请在纸条窗口里配对。');
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
        case 'copy-device-invite':
          if (event.sender !== chat.webContents) break;
          await copyDeviceInvite();
          break;
        case 'remove-device': {
          if (event.sender !== chat.webContents || !link || connection) throw new Error('暂时连不上纸条服务。');
          const device = state.devices?.find(({ id }) => id === payload.id && id !== state.deviceId);
          if (!device) throw new Error('找不到这台设备。');
          const answer = await dialog.showMessageBox(chat, { type: 'question', message: '移除「' + device.name + '」？', detail: '这台设备下次使用时需要重新添加。', buttons: ['取消', '移除'], defaultId: 0, cancelId: 0 });
          if (answer.response === 1) await link.command({ action: 'remove-device', deviceId: device.id });
          break;
        }
        case 'reset-device':
          if (event.sender !== chat.webContents || !credentialsExpired) break;
          await link?.stop();
          delete prefs.link;
          savePrefs();
          link = config = null;
          state = emptyState;
          connection = null;
          credentialsExpired = false;
          broadcast();
          break;
        case 'send':
        case 'send-image':
        case 'request':
          if (!link || connection || !state.partner?.online) throw new Error('对方离线，等 TA 上线后再发吧。');
          if (action === 'send') await link.send(payload.text, payload.clientId);
          else if (action === 'request') await link.ask(payload.text, payload.focusId);
          else {
            const image = selectedImage;
            if (event.sender !== chat.webContents || !image || payload.imageId !== image.id) throw new Error('请重新选择图片。');
            await link.sendImage(image.bytes, payload.text, payload.clientId);
            if (selectedImage === image) selectedImage = null;
          }
          break;
        case 'image-pick':
          if (event.sender !== chat.webContents) throw new Error('请在纸条窗口里选择图片。');
          return await chooseImage();
        case 'image-remove':
          if (event.sender === chat.webContents && selectedImage?.id === payload.id) selectedImage = null;
          break;
        case 'note-image': {
          if (event.sender !== chat.webContents || !link || connection) throw new Error('暂时连不上纸条服务。');
          const note = state.notes.find(({ id, hasImage }) => id === payload.id && hasImage);
          if (!note) throw new Error('找不到这张图片。');
          return { ok: true, src: await link.readImage(note) };
        }
        case 'set-mood':
          if (event.sender !== chat.webContents || !link || connection) throw new Error('暂时连不上纸条服务。');
          await link.setMood(payload.kind, payload.text);
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
        case 'server-directory':
        case 'server-database':
        case 'server-restart':
          if (!windowsServer || event.sender !== chat.webContents) throw new Error('请从 Windows 的纸条面板操作。');
          return await handleLocalServer(action, payload);
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
  app.on('activate', (_, hasVisibleWindows) => { if (chat && !hasVisibleWindows) openChat(); });
  app.on('before-quit', (event) => {
    if (localServerBusy) {
      event.preventDefault();
      quitAfterLocalServer = true;
      return;
    }
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
      closePetNotice();
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
