// Long explanations (.hint paragraphs) take one line: the first part with "…" and an ⓘ. Hover shows
// the whole text (tooltip); a click or tap unfolds it in place, and a second click folds it again.
// The lightbulb in the top bar (help text on/off, remembered per device) shows them all in full.
// Only explanations that are on the page when it loads; status lines that scripts write later, coloured
// warnings/errors, and hints with buttons or form fields in them stay as they are. data-hint-keep on a
// hint (or around it) opts out.
(function () {
  var MIN_CHARS = 140;
  function eligible(el) {
    if (el.closest('[data-hint-keep], table, .tooltip, .card-collapsed-keep, .dash-panel, .login-box')) return false;
    if (el.querySelector('input, select, textarea, button, form, table, ul, ol, pre')) return false;
    if (el.id || el.querySelector('[id]')) return false; // filled in by a script
    var st = (el.getAttribute('style') || '').toLowerCase();
    if (/color\s*:/.test(st)) return false; // a coloured warning / success line
    var text = el.textContent.replace(/\s+/g, ' ').trim();
    return text.length >= MIN_CHARS;
  }
  function setup(el) {
    if (el.dataset.hintInfo) return;
    el.dataset.hintInfo = '1';
    el.classList.add('hint-clamp');
    el.title = el.textContent.replace(/\s+/g, ' ').trim();
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-expanded', 'false');
    var toggle = function (e) {
      if (e && e.target.closest && e.target.closest('a')) return; // links inside keep working
      var open = !el.classList.contains('hint-open');
      el.classList.toggle('hint-open', open);
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) el.removeAttribute('title'); else el.title = el.textContent.replace(/\s+/g, ' ').trim();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
  }
  function run() {
    var main = document.querySelector('main') || document.body;
    var n = 0;
    Array.prototype.forEach.call(main.querySelectorAll('p.hint, div.hint'), function (el) { if (eligible(el)) { setup(el); n++; } });
    var bulb = document.getElementById('topbar-hints-toggle');
    if (n && bulb && !document.querySelector('.dash-panel')) bulb.hidden = false;
  }
  // After the translator (i18n.js) has done the page, so the tooltip holds the translated text.
  if (document.readyState === 'complete') setTimeout(run, 0); else window.addEventListener('load', function () { setTimeout(run, 0); });
})();
