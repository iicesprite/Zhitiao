// Pointer gestures adapted from PetLink. See THIRD-PARTY-NOTICES.txt.
const button = document.getElementById('pet-button');
let origin = null;
let dragging = false;
let start = Promise.resolve();

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
  if (Math.hypot(event.screenX - origin.x, event.screenY - origin.y) > 4) dragging = true;
  if (dragging) start.then(() => window.paper.act('drag-move'));
});
function release(event) {
  if (!origin) return;
  const wasDragging = dragging;
  origin = null;
  dragging = false;
  start.then(() => window.paper.act('drag-end')).then(() => {
    if (!wasDragging && event.type === 'pointerup') window.paper.act('open');
  });
}
button.addEventListener('pointerup', release);
button.addEventListener('pointercancel', release);
button.addEventListener('click', (event) => { if (!event.detail) window.paper.act('open'); });
button.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.paper.act('pet-menu');
});

function render(state) {
  const src = state.role === 2 ? 'bunny.svg' : 'pet.svg';
  const image = document.getElementById('avatar');
  if (image.getAttribute('src') !== src) image.src = src;
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
