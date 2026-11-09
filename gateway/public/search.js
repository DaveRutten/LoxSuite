// Search (Ctrl+K, "/" or the magnifier in the top bar): find a page, a setting or a section and go
// straight there. The list comes from /api/search-index (src/searchIndex.js) the first time the
// search opens. A result for a section opens its page and jumps to that heading: it unfolds the
// <details> it is in, switches to its tab, scrolls it into view and lights it up for a moment.
(function () {
  // texts come translated with the button (data-t), so they need no entry in the browser catalog
  var TD = {};
  try { TD = JSON.parse((document.getElementById('ls-search-btn') || {}).getAttribute('data-t') || '{}'); } catch (e) { TD = {}; }
  var T = function (k) { return TD[k] || (window.LS_I18N && window.LS_I18N[k]) || k; };
  var FIND_KEY = 'ls-find';

  // ---- arriving on a page from a search result: jump to the heading ----
  function jump() {
    var want;
    try { want = sessionStorage.getItem(FIND_KEY); sessionStorage.removeItem(FIND_KEY); } catch (e) { return; }
    if (!want) return;
    var norm = function (x) { return String(x || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
    var w = norm(want);
    var cands = Array.prototype.slice.call(document.querySelectorAll('main h2, main h3, main summary, main .en-h3, main strong'));
    var el = cands.find(function (e) { return norm(e.textContent) === w; }) || cands.find(function (e) { return norm(e.textContent).indexOf(w) === 0; });
    if (!el) return;
    // a tab that hides it: click its tab link
    var tab = el.closest('[data-tab]');
    if (tab && tab.hidden) { var l = document.querySelector('[data-tab-link="' + tab.getAttribute('data-tab') + '"]'); if (l) l.click(); }
    // folded <details> around it, and the one it heads
    for (var d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    var target = el.tagName === 'SUMMARY' ? el.parentElement : el;
    setTimeout(function () {
      // below the sticky top bar and a sticky section menu (.section-nav), not behind them
      var tb = document.querySelector('.topbar'), sn = document.querySelector('.section-nav');
      var cover = (tb ? tb.getBoundingClientRect().height : 0) + (sn && getComputedStyle(sn).position === 'sticky' ? sn.getBoundingClientRect().height : 0) + 16;
      window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - cover), behavior: 'smooth' });
      target.classList.add('ls-found');
      setTimeout(function () { target.classList.remove('ls-found'); }, 2600);
    }, 60);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', jump); else jump();

  // ---- the search dialog ----
  var btn = document.getElementById('ls-search-btn');
  if (!btn) return;
  var index = null, loading = null, dlg, input, list, items = [], sel = 0;

  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) loading = fetch('/api/search-index', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { index = (d || []).map(function (e) { e._h = fold([e.label, e.where, e.kw || ''].join(' ')); e._l = fold(e.label); return e; }); return index; })
      .catch(function () { loading = null; return []; });
    return loading;
  }
  function fold(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'ls-search';
    dlg.setAttribute('aria-label', T('Search'));
    dlg.innerHTML = '<div class="ls-search-box"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
      + '<input type="search" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="ls-search-list"><kbd>Esc</kbd></div>'
      + '<ul id="ls-search-list" class="ls-search-list" role="listbox"></ul>'
      + '<div class="ls-search-foot"><span><kbd>↑</kbd><kbd>↓</kbd> ' + esc(T('choose')) + '</span><span><kbd>Enter</kbd> ' + esc(T('open')) + '</span></div>';
    document.body.appendChild(dlg);
    input = dlg.querySelector('input');
    input.placeholder = T('Search pages and settings…');
    list = dlg.querySelector('ul');
    input.addEventListener('input', render);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); go(items[sel]); }
    });
    list.addEventListener('click', function (ev) { var li = ev.target.closest('li[data-i]'); if (li) go(items[Number(li.getAttribute('data-i'))]); });
    list.addEventListener('mousemove', function (ev) { var li = ev.target.closest('li[data-i]'); if (li && Number(li.getAttribute('data-i')) !== sel) { sel = Number(li.getAttribute('data-i')); mark(); } });
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });
  }
  function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function score(e, words, q) {
    for (var i = 0; i < words.length; i++) if (e._h.indexOf(words[i]) < 0) return -1;
    var s = 0;
    if (e._l === q) s += 100; else if (e._l.indexOf(q) === 0) s += 60; else if (e._l.indexOf(q) >= 0) s += 30;
    if (e.page) s += 15;
    if (e.off) s -= 20;
    return s - e.label.length / 50;
  }
  function render() {
    var q = fold(input.value.trim());
    if (!index) { list.innerHTML = '<li class="ls-search-empty">' + esc(T('Loading…')) + '</li>'; return; }
    if (!q) {
      items = index.filter(function (e) { return e.page; }).slice(0, 8);
    } else {
      var words = q.split(/\s+/);
      items = index.map(function (e) { return { e: e, s: score(e, words, q) }; }).filter(function (x) { return x.s >= 0; })
        .sort(function (a, b) { return b.s - a.s; }).slice(0, 12).map(function (x) { return x.e; });
    }
    sel = 0;
    if (!items.length) { list.innerHTML = '<li class="ls-search-empty">' + esc(T('Nothing found. Try another word.')) + '</li>'; return; }
    list.innerHTML = items.map(function (e, i) {
      var kind = e.off ? T('switched off') : e.find ? T('setting') : T('page');
      return '<li role="option" data-i="' + i + '"><span class="ls-search-label">' + esc(e.label) + '</span>'
        + '<span class="ls-search-where">' + esc(e.off ? T('Switch on under Administration › Modules') : (e.where || '')) + '</span>'
        + '<span class="ls-search-kind' + (e.off ? ' off' : '') + '">' + esc(kind) + '</span></li>';
    }).join('');
    mark();
  }
  function mark() {
    Array.prototype.forEach.call(list.querySelectorAll('li[data-i]'), function (li, i) {
      li.classList.toggle('on', i === sel); li.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      if (i === sel) li.scrollIntoView({ block: 'nearest' });
    });
  }
  function move(d) { if (!items.length) return; sel = (sel + d + items.length) % items.length; mark(); }
  function go(e) {
    if (!e) return;
    try { if (e.find) sessionStorage.setItem(FIND_KEY, e.find); } catch (x) { /* no storage */ }
    var here = location.pathname + location.hash, to = e.href;
    dlg.close();
    if (to === here || (to.split('#')[0] === location.pathname && e.find)) {
      if (to.indexOf('#') >= 0 && to !== here) location.hash = to.split('#')[1];
      jump();
    } else location.href = to;
  }
  function open() {
    if (!dlg) build();
    input.value = '';
    dlg.showModal();
    input.focus();
    render();
    load().then(render);
  }
  btn.addEventListener('click', open);
  document.addEventListener('keydown', function (ev) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '') || (ev.target && ev.target.isContentEditable);
    if ((ev.key === 'k' || ev.key === 'K') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); open(); }
    else if (ev.key === '/' && !typing && !(dlg && dlg.open)) { ev.preventDefault(); open(); }
  });
  // warm the list when the pointer comes near, so it is there on click
  btn.addEventListener('pointerenter', load, { once: true });
})();
