const $ = (id) => document.getElementById(id);
const answer = [...document.querySelectorAll('[data-answer]')];
let alert = null;

function render(value) {
  alert = value;
  $('bubble-card').hidden = !alert;
  if (!alert) return;
  $('title').textContent = alert.title;
  $('text').textContent = alert.text || '';
  $('text').hidden = !alert.text;
  $('request-actions').hidden = alert.kind !== 'request';
  $('open').hidden = alert.kind === 'request';
  $('error').hidden = true;
}

$('dismiss').addEventListener('click', () => window.paper.act('dismiss'));
$('open').addEventListener('click', () => window.paper.act('open'));
for (const button of answer) {
  button.addEventListener('click', async () => {
    if (!alert?.id) return;
    for (const action of answer) action.disabled = true;
    try {
      const result = await window.paper.act('answer', { id: alert.id, decision: button.dataset.answer });
      if (!result.ok) {
        $('error').textContent = result.error;
        $('error').hidden = false;
      }
    } finally {
      for (const action of answer) action.disabled = false;
    }
  });
}
window.paper.onAlert(render);
window.paper.currentAlert().then(render);
