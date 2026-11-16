// Pointer gestures adapted from PetLink. See THIRD-PARTY-NOTICES.txt.
const button = document.getElementById('pet-button');
const avatar = document.getElementById('avatar');
const speech = document.getElementById('pet-speech');
const speechTitle = document.getElementById('pet-speech-title');
const speechText = document.getElementById('pet-speech-text');
const speechOpen = document.getElementById('pet-speech-open');
let origin = null;
let dragging = false;
let start = Promise.resolve();
let clickTimer;
let shownNotice = null;
let jump;

function cancelClick() {
  clearTimeout(clickTimer);
  clickTimer = null;
}

function clickPet() {
  if (clickTimer) {
    cancelClick();
    window.paper.act('open');
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    window.paper.act('mood-peek');
  }, 350);
}

button.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  button.setPointerCapture(event.pointerId);
  origin = { x: event.screenX, y: event.screenY };
  dragging = false;
  start = window.paper.act('drag-start');
});
button.addEventListener('pointermove', (event) => {
  if (!origin) return;
  if (!dragging && Math.hypot(event.screenX - origin.x, event.screenY - origin.y) > 4) {
    dragging = true;
    cancelClick();
  }
  if (dragging) start.then(() => window.paper.act('drag-move'));
});
function release(event) {
  if (!origin) return;
  const wasDragging = dragging;
  origin = null;
  dragging = false;
  start.then(() => window.paper.act('drag-end'));
  if (!wasDragging && event.type === 'pointerup') clickPet();
}
button.addEventListener('pointerup', release);
button.addEventListener('pointercancel', release);
button.addEventListener('click', (event) => { if (!event.detail) clickPet(); });
button.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  cancelClick();
  window.paper.act('pet-menu');
});
speechOpen.addEventListener('click', () => window.paper.act('open'));

function renderDisplay(display) {
  if (!display) return;
  button.style.left = display.x + 'px';
  button.style.top = display.y + 'px';
  const notice = display.notice;
  speech.hidden = !notice;
  if (!notice) return;
  speech.style.left = display.speech.x + 'px';
  speech.style.bottom = display.speech.bottom + 'px';
  speech.style.width = display.speech.width + 'px';
  speech.style.setProperty('--tail-x', display.speech.tailX + 'px');
  speechTitle.textContent = notice.title;
  speechText.textContent = notice.text;
  speechText.hidden = !notice.text;
  speechOpen.hidden = notice.kind !== 'notes';
  if (notice.id !== shownNotice && notice.kind === 'notes' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    jump?.cancel();
    jump = avatar.animate([
      { translate: '0 0' }, { translate: '0 -12px', offset: 0.46 }, { translate: '0 0' }
    ], { duration: 420, easing: 'ease-in-out' });
  }
  shownNotice = notice.id;
}

function render(state) {
  const src = state.role === 2 ? 'bunny.svg' : 'pet.svg';
  if (avatar.getAttribute('src') !== src) avatar.src = src;
  const status = !state.configured ? '纸条'
    : state.incoming ? '有解除请求'
    : state.connection ? '连接中'
    : !state.partner ? '等对方配对'
    : !state.partner.online ? '对方离线'
    : state.partner.focusId ? '对方闭关'
    : state.me?.focusId ? '闭关中' : '对方在线';
  document.getElementById('pet-status').textContent = status;
}
window.paper.onState(render);
window.paper.current().then(render);
window.paper.onPetDisplay(renderDisplay);
window.paper.currentPetDisplay().then(renderDisplay);
