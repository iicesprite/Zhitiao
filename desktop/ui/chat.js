const $ = (id) => document.getElementById(id);
const buttons = (selector) => [...document.querySelectorAll(selector)];
let data = null;
let tab = 'join';
let pairing = false;
let sending = false;
let pickingImage = false;
let attachment = null;
let requesting = false;
let focusBusy = false;
let moodBusy = false;
let pendingDraft = null;
let noteSignature = '';
let partnerFocus = null;
let feedbackTimer;
let showServe = false;
let showUpdates = false;
let updateBusy = false;
let initializedPorts = false;
let serveLoading = false;
let serveState = null;
const imageViews = new Map();
const imageObserver = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    const view = imageViews.get(Number(target.dataset.noteId));
    if (view?.container !== target) continue;
    view.nearby = isIntersecting;
    if (isIntersecting && !view.failed) loadNoteImage(view);
    else if (!isIntersecting && view.image.hasAttribute('src')) resetNoteImage(view);
  }
}, { root: $('notes'), rootMargin: '80px' });

function feedback(message) {
  clearTimeout(feedbackTimer);
  $('feedback').textContent = message ?? '';
  if (message) feedbackTimer = setTimeout(() => { $('feedback').textContent = ''; }, 8000);
}

async function act(name, fields) {
  feedback('');
  try {
    const result = await window.paper.act(name, fields);
    if (result.ok) return true;
    feedback(result.error ?? '操作失败，请再试一次。');
  } catch {
    feedback('暂时无法完成，请再试一次。');
  }
  return false;
}

function showTab(next) {
  tab = next;
  const create = tab === 'create';
  $('join-fields').hidden = create;
  $('create-fields').hidden = !create;
  for (const input of $('create-fields').querySelectorAll('input')) input.disabled = !create;
  $('pair-form').elements.invite.disabled = create;
  $('pair-submit').textContent = create ? '生成邀请码' : '完成配对';
  buttons('[data-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tab === tab)));
}

function label(member, online, serverNow) {
  if (!online) return member?.focusId ? '离线 · 闭关中' : '离线';
  if (!member?.focusId) return '在线';
  if (!member.focusUntil) return '闭关中';
  const minutes = Math.max(0, Math.ceil((member.focusUntil - serverNow) / 60_000));
  return minutes ? '闭关中 · 约 ' + minutes + ' 分钟' : '闭关即将结束';
}

function resetNoteImage(view) {
  view.image.removeAttribute('src');
  view.image.hidden = true;
  view.button.hidden = false;
  view.button.textContent = view.failed ? '重试加载图片' : '查看图片';
}

async function loadNoteImage(view) {
  if (view.loading || view.image.hasAttribute('src')) return;
  view.loading = true;
  view.failed = false;
  view.button.disabled = true;
  view.button.textContent = '正在读取图片…';
  try {
    const result = await window.paper.act('note-image', { id: view.id });
    if (!result.ok) throw new Error(result.error);
    if (view.nearby && imageViews.has(view.id)) {
      view.image.src = result.src;
      view.image.hidden = false;
      view.button.hidden = true;
    }
  } catch {
    view.failed = true;
  } finally {
    view.loading = false;
    view.button.disabled = false;
    if (view.image.hidden) resetNoteImage(view);
  }
}

function noteImage(id) {
  const existing = imageViews.get(id);
  if (existing) return existing.container;
  const container = document.createElement('div');
  container.className = 'note-image';
  container.dataset.noteId = id;
  const image = document.createElement('img');
  image.alt = '纸条图片';
  const button = document.createElement('button');
  button.type = 'button';
  const view = { id, container, image, button, nearby: false, loading: false, failed: false };
  button.addEventListener('click', () => loadNoteImage(view));
  image.addEventListener('error', () => {
    if (!image.hasAttribute('src')) return;
    view.failed = true;
    resetNoteImage(view);
  });
  resetNoteImage(view);
  container.append(image, button);
  imageViews.set(id, view);
  imageObserver.observe(container);
  return container;
}

function renderNotes(info) {
  const signature = info.notes.map((note) => [note.id, note.availableAt, note.deliveredAt, note.hasImage].join('.')).join(',')
    + ':' + Boolean(info.me?.focusId);
  if (signature === noteSignature) return;
  noteSignature = signature;
  const panel = $('notes');
  const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 55;
  const fragment = document.createDocumentFragment();
  const activeImages = new Set();
  if (!info.notes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = info.me?.focusId ? '闭关期间的新纸条会在出关后一起收到。' : '还没有纸条。';
    fragment.append(empty);
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const note of info.notes) {
    const mine = note.sender === info.me?.id;
    const card = document.createElement('article');
    card.className = mine ? 'note mine' : 'note';
    const timestamp = document.createElement('time');
    timestamp.dateTime = new Date(note.createdAt).toISOString();
    const status = note.availableAt === null ? ' · 已暂存' : note.deliveredAt ? ' · 已送达' : ' · 等待送达';
    timestamp.textContent = formatter.format(note.createdAt) + (mine ? status : '');
    card.append(timestamp);
    if (!note.hasImage || note.text !== '[图片]') {
      const text = document.createElement('p');
      text.textContent = note.text;
      card.append(text);
    }
    if (note.hasImage) {
      card.append(noteImage(note.id));
      activeImages.add(note.id);
    }
    fragment.append(card);
  }
  for (const [id, view] of imageViews) {
    if (!activeImages.has(id)) {
      imageObserver.unobserve(view.container);
      imageViews.delete(id);
    }
  }
  panel.replaceChildren(fragment);
  if (nearBottom) panel.scrollTop = panel.scrollHeight;
}

function render(info = data) {
  if (!info) return;
  data = info;
  $('network').hidden = !info.tailscaleAvailable;
  $('network').textContent = showServe ? '返回纸条' : '异地连接';
  $('serve-panel').hidden = !showServe;
  $('updates').hidden = !info.updates;
  $('updates').textContent = showUpdates ? '返回纸条' : info.updates?.readyVersion ? '新版已就绪' : '软件更新';
  $('updates-panel').hidden = !showUpdates;
  $('update-version').textContent = info.updates ? '当前版本 ' + info.updates.version : '';
  $('update-status').textContent = info.updates?.message ?? '';
  $('update-restart').hidden = !info.updates?.readyVersion;
  $('update-check').disabled = updateBusy;
  const panelOpen = showServe || showUpdates;
  $('setup').hidden = panelOpen || info.configured;
  $('waiting').hidden = panelOpen || !info.configured || info.partner !== null;
  $('room').hidden = panelOpen || !info.partner;
  $('copy-invite').hidden = !info.canInvite;
  $('subtitle').textContent = info.partner ? info.me.name + ' 和 ' + info.partner.name : '两个人的收件箱';
  $('avatar').src = info.role === 2 ? 'bunny.svg' : 'pet.svg';
  $('hide').hidden = info.hidden;
  if (panelOpen) return;
  if (!info.partner) {
    if (info.configured) feedback(info.connection);
    return;
  }

  const me = info.me;
  const online = !info.connection && info.partner.online;
  const selfOnline = !info.connection;
  $('my-status').textContent = label(me, selfOnline, info.time);
  $('my-mood').textContent = $('my-mood').title = me.mood?.label ?? '';
  $('my-mood').hidden = !me.mood;
  $('partner-name').textContent = info.partner.name;
  $('partner-status').textContent = label(info.partner, online, info.time);
  for (const button of buttons('[data-focus]')) {
    button.hidden = Boolean(me.focusId);
    button.disabled = !selfOnline || focusBusy;
  }
  $('finish').hidden = !me.focusId;
  $('finish').disabled = !selfOnline || focusBusy;
  const canAsk = online && Boolean(info.partner.focusId) && info.outgoing?.status !== 'pending';
  $('ask').hidden = !info.partner.focusId;
  $('ask').disabled = !canAsk || requesting;
  if (partnerFocus !== info.partner.focusId || !canAsk) $('request-form').hidden = true;
  partnerFocus = info.partner.focusId;
  $('ask-submit').disabled = !canAsk || requesting;
  const messages = {
    pending: '请求已发出，等待对方决定。',
    accepted: '对方已同意结束闭关。',
    declined: '对方选择继续闭关。',
    expired: '这次解除请求已失效。'
  };
  $('outgoing').hidden = !info.outgoing;
  $('outgoing').textContent = messages[info.outgoing?.status] ?? '';
  $('incoming').hidden = !info.incoming;
  $('incoming-title').textContent = info.partner.name + ' 想请你出关';
  $('incoming-text').textContent = info.incoming?.text ?? '';
  $('incoming-text').hidden = !info.incoming?.text;
  for (const button of buttons('[data-answer]')) button.disabled = !selfOnline || focusBusy;
  $('mood-edit').disabled = moodBusy;
  $('mood-save').disabled = !selfOnline || moodBusy;
  $('attachment').hidden = !attachment;
  $('attachment-name').textContent = $('attachment-name').title = attachment?.name ?? '';
  $('attachment-remove').disabled = sending || pickingImage;
  $('image-pick').disabled = sending || pickingImage;
  $('draft').required = !attachment;
  $('send').disabled = !online || sending || pickingImage || (!attachment && !$('draft').value.trim());
  $('compose-status').textContent = sending && attachment ? '正在发送图片…' : info.connection || (online
    ? info.partner.focusId ? '这张纸条会在对方出关后送达。' : ''
    : '对方离线，等 TA 上线后再发。');
  renderNotes(info);
}

buttons('[data-tab]').forEach((button) => button.addEventListener('click', () => showTab(button.dataset.tab)));
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pairing) return;
  pairing = true;
  $('pair-submit').disabled = true;
  const fields = Object.fromEntries(new FormData(event.target));
  if (await act(tab, fields)) event.target.reset();
  pairing = false;
  $('pair-submit').disabled = false;
});
$('copy-invite').addEventListener('click', async () => {
  if (await act('copy')) feedback('已复制邀请码。');
});
$('hide').addEventListener('click', () => act('hide'));
$('image-pick').addEventListener('click', async () => {
  if (pickingImage || sending) return;
  pickingImage = true;
  feedback('');
  render();
  try {
    const result = await window.paper.act('image-pick');
    if (!result.ok) feedback(result.error ?? '暂时无法选择图片。');
    else if (result.image) attachment = result.image;
  } catch {
    feedback('暂时无法选择图片。');
  } finally {
    pickingImage = false;
    render();
  }
});
$('attachment-remove').addEventListener('click', () => {
  if (!attachment || sending || pickingImage) return;
  window.paper.act('image-remove', { id: attachment.id });
  attachment = null;
  render();
});
$('draft').addEventListener('input', () => render());
$('draft').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing && (event.ctrlKey || event.metaKey) && !$('send').disabled) {
    event.preventDefault();
    $('compose').requestSubmit();
  }
});
$('compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('send').disabled) return;
  sending = true;
  const text = $('draft').value.trim();
  const imageId = attachment?.id;
  if (pendingDraft?.text !== text || pendingDraft?.imageId !== imageId) {
    pendingDraft = { text, imageId, clientId: crypto.randomUUID() };
  }
  render();
  if (await act(imageId ? 'send-image' : 'send', pendingDraft)) {
    if ($('draft').value.trim() === text) $('draft').value = '';
    if (attachment?.id === imageId) attachment = null;
    pendingDraft = null;
  }
  sending = false;
  render();
});

function showMoodForm(show) {
  $('mood-form').hidden = !show;
  $('mood-edit').setAttribute('aria-expanded', String(show));
}

function renderMoodField() {
  const custom = $('mood-kind').value === 'custom';
  $('custom-mood').hidden = !custom;
  $('mood-text').disabled = !custom;
  $('mood-text').required = custom;
}

$('mood-edit').addEventListener('click', () => {
  const show = $('mood-form').hidden;
  if (show) {
    $('request-form').hidden = true;
    const select = $('mood-kind');
    if (!select.options.length) {
      for (const [kind, label] of Object.entries(data.moods)) select.add(new Option(label, kind));
      select.add(new Option('自定义', 'custom'));
    }
    select.value = data.me.mood?.kind ?? 'happy';
    $('mood-text').value = data.me.mood?.text ?? '';
    renderMoodField();
    showMoodForm(true);
    select.focus();
  } else {
    showMoodForm(false);
  }
});
$('mood-kind').addEventListener('change', renderMoodField);
$('mood-cancel').addEventListener('click', () => showMoodForm(false));
$('mood-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (moodBusy || $('mood-save').disabled) return;
  moodBusy = true;
  render();
  if (await act('set-mood', { kind: $('mood-kind').value, text: $('mood-text').value })) showMoodForm(false);
  moodBusy = false;
  render();
});

async function changeFocus(action, fields) {
  if (focusBusy) return;
  focusBusy = true;
  render();
  await act(action, fields);
  focusBusy = false;
  render();
}

buttons('[data-focus]').forEach((button) => button.addEventListener('click', () => changeFocus('start', { mode: button.dataset.focus })));
$('finish').addEventListener('click', () => changeFocus('finish'));
buttons('[data-answer]').forEach((button) => button.addEventListener('click', () => {
  if (data.incoming) changeFocus('answer', { id: data.incoming.id, decision: button.dataset.answer });
}));
$('ask').addEventListener('click', () => {
  showMoodForm(false);
  $('request-form').hidden = false;
  $('reason').focus();
});
$('ask-cancel').addEventListener('click', () => { $('request-form').hidden = true; });
$('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('ask-submit').disabled) return;
  requesting = true;
  render();
  if (await act('request', { text: $('reason').value, focusId: partnerFocus })) {
    $('request-form').reset();
    $('request-form').hidden = true;
  }
  requesting = false;
  render();
});

function currentPorts() {
  const { localPort, httpsPort } = $('serve-form').elements;
  return { localPort: localPort.value, httpsPort: httpsPort.value };
}

function renderServe() {
  const form = $('serve-form');
  const { localPort, httpsPort } = currentPorts();
  const valid = form.checkValidity();
  const httpsFlag = Number(httpsPort) === 443 ? '' : ' --https=' + Number(httpsPort);
  $('serve-command').textContent = valid
    ? 'tailscale serve --bg' + httpsFlag + ' http://127.0.0.1:' + Number(localPort)
    : '请输入有效端口。';
  const matches = Number(localPort) === serveState?.ports?.localPort
    && Number(httpsPort) === serveState?.ports?.httpsPort;
  const active = matches && serveState?.state === 'active';
  $('serve-start').disabled = serveLoading || !valid || active;
  $('serve-refresh').disabled = serveLoading || !valid;
  $('serve-stop').hidden = !active;
  $('serve-stop').disabled = serveLoading;
  $('serve-address').hidden = !active;
  $('serve-url').value = active ? serveState.url : '';
  $('serve-copy-invite').disabled = serveLoading || !active || !serveState.canInvite;
  $('serve-copy-url').disabled = serveLoading;
  for (const field of form.querySelectorAll('input')) field.readOnly = serveLoading;
}

async function serveAction(action) {
  if (serveLoading) return;
  serveLoading = true;
  $('serve-status').textContent = action === 'serve-start' ? '正在启动 Tailscale Serve…' : '正在检查…';
  renderServe();
  try {
    const response = await window.paper.act(action, currentPorts());
    if (!response.ok) {
      $('serve-status').textContent = response.error;
      return;
    }
    serveState = response.serve;
    const copied = action === 'serve-copy-invite' ? '已复制异地邀请码。'
      : action === 'serve-copy-url' ? '已复制地址。' : '';
    $('serve-status').textContent = copied || serveState.message;
  } catch {
    $('serve-status').textContent = '暂时无法操作 Tailscale，请重试。';
  } finally {
    serveLoading = false;
    renderServe();
  }
}

$('network').addEventListener('click', () => {
  showUpdates = false;
  showServe = !showServe;
  if (showServe && !initializedPorts) {
    const form = $('serve-form');
    form.elements.localPort.value = data.servePorts.localPort;
    form.elements.httpsPort.value = data.servePorts.httpsPort;
    initializedPorts = true;
  }
  render();
  if (showServe) serveAction('serve-status');
});
$('serve-form').addEventListener('input', () => {
  $('serve-status').textContent = '';
  renderServe();
});
$('serve-form').addEventListener('submit', (event) => {
  event.preventDefault();
  serveAction('serve-start');
});
for (const [button, action] of [
  ['serve-refresh', 'serve-status'], ['serve-stop', 'serve-stop'],
  ['serve-copy-url', 'serve-copy-url'], ['serve-copy-invite', 'serve-copy-invite']
]) {
  $(button).addEventListener('click', () => serveAction(action));
}
for (const action of ['serve-install', 'serve-dns', 'serve-share']) {
  $(action).addEventListener('click', () => act(action));
}

$('updates').addEventListener('click', () => {
  showServe = false;
  showUpdates = !showUpdates;
  render();
});
$('update-check').addEventListener('click', async () => {
  updateBusy = true;
  render();
  await act('update-check');
  updateBusy = false;
  render();
});
$('update-restart').addEventListener('click', () => act('update-restart'));
$('update-releases').addEventListener('click', () => act('update-releases'));

window.paper.onState(render);
window.paper.current().then((info) => {
  render(info);
  return window.paper.act('ui-ready');
});
