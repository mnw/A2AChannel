// emoji.js — emoji picker popover for the composer. Tier 2 of index.html.
//
// Depends on (declared earlier):
//   from state.js — input, emojiBtn, emojiPop, EMOJIS
//
// Exposes:
//   buildEmojiPicker, insertAtCursor

function buildEmojiPicker() {
  emojiPop.innerHTML = '';
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => {
      insertAtCursor(input, e);
      emojiPop.classList.remove('open');
      input.focus();
    });
    emojiPop.appendChild(b);
  }
}
buildEmojiPicker();

function insertAtCursor(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + text.length;
}

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPop.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!emojiPop.contains(e.target) && e.target !== emojiBtn) emojiPop.classList.remove('open');
});
