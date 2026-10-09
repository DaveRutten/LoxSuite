// Explanations (.hint paragraphs) are hidden behind ONE ⓘ per tile: next to the title of the card they
// are in (or of the fold-out, when they are not in a card). A tap on it shows or hides all explanations
// of that tile; hovering it says how many. The lightbulb in the top bar (help text on/off, remembered per
// device) shows them all. Explanations that no tile title can be found for fold to one line with an ⓘ
// of their own (hover = whole text, click = unfold).
// Only explanations that are on the page when it loads; status lines that scripts write later, coloured
// warnings/errors, and hints with buttons or form fields in them stay as they are. data-hint-keep on a
// hint (or around it) opts out.
(function () {
  var MIN_CHARS = 90;
  function eligible(el) {
    if (el.closest('[data-hint-keep], table, .tooltip, .card-collapsed-keep, .dash-panel, .login-box')) return false;
    if (el.querySelector('input, select, textarea, button, form, table, ul, ol, pre')) return false;
    if (el.id || el.querySelector('[id]')) return false; // filled in by a script
    if (Array.prototype.some.call(el.attributes, function (a) { return /^data-(?!show-if)/.test(a.name); })) return false; // ditto
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
  // The tile an explanation belongs to — its card, else its fold-out — and the title to put the one ⓘ after.
  function blockOf(el) {
    var block = el.closest('.card') || el.closest('details');
    if (!block) return null;
    var title = block.tagName === 'DETAILS'
      ? block.querySelector(':scope > summary')
      : block.querySelector(':scope > .card-head h2, :scope > h2, :scope > .card-head, :scope > div > h2');
    return title ? { block: block, title: title } : null;
  }
  function setupField(el) {
    if (el.dataset.hintInfo) return false;
    var b = blockOf(el);
    if (!b) return false;
    el.dataset.hintInfo = '1';
    el.classList.add('hint-field');
    var btn = b.title.querySelector(':scope > .hint-i');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hint-i';
      btn.textContent = 'ⓘ';
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation(); // in a <summary>: don't fold the block
        var open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        Array.prototype.forEach.call(b.block.querySelectorAll('.hint-field'), function (h) { var hb = blockOf(h); if (hb && hb.block === b.block) h.classList.toggle('hint-field-open', open); });
        if (open && b.block.tagName === 'DETAILS') b.block.open = true;
      });
      b.title.appendChild(btn);
      btn.dataset.count = '0';
    }
    btn.dataset.count = String(Number(btn.dataset.count) + 1);
    var label = (window.LS_I18N && window.LS_I18N['Show the explanations ({0})']) || 'Show the explanations ({0})';
    btn.title = label.replace('{0}', btn.dataset.count);
    btn.setAttribute('aria-label', btn.title);
    return true;
  }
  function run() {
    var main = document.querySelector('main') || document.body;
    var n = 0;
    Array.prototype.forEach.call(main.querySelectorAll('p.hint, div.hint'), function (el) {
      if (el.dataset.hintInfo) return;
      var plain = !el.querySelector('input, select, textarea, button, form, table') && !el.id && !(el.getAttribute('style') || '').match(/color\s*:/) &&
        !Array.prototype.some.call(el.attributes, function (a) { return /^data-(?!show-if)/.test(a.name); }) && !el.closest('[data-hint-keep], .dash-panel, .login-box, table, .tooltip');
      if (!plain) return;
      // a short explanation outside a form field (a status, "Saved.") stays as it is
      var inField = el.parentElement && el.parentElement.querySelector(':scope > label') && el.parentElement.querySelector('input, select, textarea');
      if (!inField && el.textContent.replace(/\s+/g, ' ').trim().length < 40) return;
      if (setupField(el)) { n++; return; }
      if (eligible(el)) { setup(el); n++; }
    });
    var bulb = document.getElementById('topbar-hints-toggle');
    if (n && bulb && !document.querySelector('.dash-panel')) bulb.hidden = false;
  }
  // After the translator (i18n.js) has done the page, so the tooltip holds the translated text.
  if (document.readyState === 'complete') setTimeout(run, 0); else window.addEventListener('load', function () { setTimeout(run, 0); });
})();
