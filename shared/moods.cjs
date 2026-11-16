const moods = Object.freeze({
  happy: '开心 ヽ(・∀・)ﾉ',
  sad: '沮丧 (｡•́︿•̀｡)',
  sleepy: '困 (－_－) zzZ',
  angry: '生气 (╬ Ò﹏Ó)'
});

function parseMood(kind, text) {
  if (Object.hasOwn(moods, kind)) return { kind, label: moods[kind], text: '' };
  if (kind === 'custom' && typeof text === 'string' && text.trim() && [...text.trim()].length <= 40) {
    return { kind, label: text.trim(), text: text.trim() };
  }
  throw new Error('自定义心情可以写 1 到 40 个字。');
}

module.exports = { moods, parseMood };
