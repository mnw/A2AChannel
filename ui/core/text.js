// text.js — pure text utilities. Zero dependencies on other UI modules
// (only reads ROSTER from state.js for highlightMentions/parseMentions).
// Loaded in tier 1 of ui/index.html — must come BEFORE any module that
// renders chat rows or composes outgoing messages.
//
// Exposes (as globals via classic-script lexical scope):
//   escHtml, escAttr, escRegex   — HTML / attribute / regex escapers
//   linkify                       — URL → <a>+<button> replacement
//   highlightMentions             — @name → <span class="mention">
//   parseMentions                 — extract @name list from text

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkify(s) {
  // Replacer function (not replacement string) so $-sequences in the URL aren't treated as groups.
  return s.replace(/(https?:\/\/[^\s<]+)/g, (_, url) =>
    `<a class="msg-link" href="${url}" target="_blank" rel="noopener">${url}</a>` +
    `<button type="button" class="msg-link-copy" data-href="${url}" aria-label="Copy link" title="Copy link"></button>`);
}

// Agent names can contain regex metacharacters ('.' '-'); escape before building the mention regex.
function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

function highlightMentions(html) {
  const names = ROSTER.map(a => a.name);
  if (!names.length) return html;
  const pattern = new RegExp(`@(${names.map(escRegex).join('|')})\\b`, 'g');
  return html.replace(pattern, '<span class="mention">@$1</span>');
}

function parseMentions(text) {
  const names = ROSTER.map(a => a.name);
  const found = new Set();
  const re = new RegExp(`@(${names.map(escRegex).join('|')})\\b`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return [...found];
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
