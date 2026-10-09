// 24-hour times and readable dates everywhere (v0.55). A browser draws <input type="time"> and
// "datetime-local" in the language of the browser itself — "02:00 PM" on an English Windows, whatever
// LoxSuite's language. So:
// - a time becomes a text field "14:30": type 1430, 14.30, 14:30 or just 9; ↑ / ↓ step a quarter (or the
//   field's step); the value stays "HH:MM", like a time field's;
// - a date and time (datetime-local) becomes a date ("wed 7 Oct 2026", ‹ › a day, a click opens the
//   browser's calendar) plus such a time; the original field stays, hidden, with the same name, id,
//   value ("YYYY-MM-DDTHH:MM") and events, so forms and scripts keep working;
// - <input type="date" data-ls-date> gets the same readable date (opt in).
// Also for fields added later (a MutationObserver). data-native keeps a field as the browser draws it.
(function () {
  if (window.LsTime) return;
  var LANG = document.documentElement.lang || undefined;
  var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  var get = function (el) { return desc.get.call(el); };
  var set = function (el, v) { desc.set.call(el, v); };
  function pad(n) { return String(n).padStart(2, '0'); }

  // '1430', '14:30', '14.30', '14u30', '9', '930', '9:5' -> 'HH:MM'; '' -> ''; anything else -> null
  function parseTime(s) {
    var t = String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
    if (!t) return '';
    var h;
    var mi;
    var m = /^(\d{1,2})[:.,hu](\d{1,2})$/.exec(t);
    if (m) { h = +m[1]; mi = m[2].length === 1 ? +m[2] * 10 : +m[2]; } else if (/^\d{1,2}$/.test(t)) { h = +t; mi = 0; } else if (/^\d{3,4}$/.test(t)) { h = +t.slice(0, -2); mi = +t.slice(-2); } else return null;
    if (h > 23 || mi > 59) return null;
    return pad(h) + ':' + pad(mi);
  }
  function addMinutes(hm, n) { var p = hm.split(':'); var t = (((+p[0] * 60 + +p[1] + n) % 1440) + 1440) % 1440; return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
  function fire(el, type) { var e = new Event(type, { bubbles: true }); e.lsTime = true; el.dispatchEvent(e); }

  // ------------------------------------------------------------ time: a 24-hour text field
  var lastOf = new WeakMap();
  function timeField(inp) {
    if (inp.classList.contains('ls-time')) return;
    var stepMin = Math.round((Number(inp.getAttribute('step')) || 0) / 60);
    if (stepMin < 5) stepMin = 15;
    var v0 = parseTime(get(inp)) || '';
    inp.type = 'text';
    inp.inputMode = 'numeric';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.maxLength = 5;
    if (!inp.placeholder) inp.placeholder = '--:--';
    inp.classList.add('ls-time');
    set(inp, v0);
    lastOf.set(inp, v0);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        var cur = parseTime(get(inp)) || lastOf.get(inp) || '08:00';
        // to the next whole step first (08:10 ↑ 08:15), then by steps
        var p = cur.split(':');
        var mins = +p[0] * 60 + +p[1];
        var next = e.key === 'ArrowUp' ? Math.floor(mins / stepMin) * stepMin + stepMin : Math.ceil(mins / stepMin) * stepMin - stepMin;
        commit(inp, addMinutes('00:00', next));
      } else if (e.key === 'Enter') {
        commit(inp, null);
      }
    });
  }
  // the value typed (or v), tidied up; an unreadable one goes back to the last good one
  function commit(inp, v) {
    var nv = v != null ? v : parseTime(get(inp));
    if (nv === null) {
      set(inp, lastOf.get(inp) || '');
      inp.classList.add('ls-bad');
      setTimeout(function () { inp.classList.remove('ls-bad'); }, 900);
      return false;
    }
    if (get(inp) !== nv) set(inp, nv);
    if (nv !== lastOf.get(inp)) { lastOf.set(inp, nv); fire(inp, 'input'); fire(inp, 'change'); }
    return true;
  }
  // while typing ("1", "14", "143") nobody else needs to hear it — only the tidied-up time, on leaving
  // the field (or Enter / an arrow key)
  window.addEventListener('input', function (e) {
    if (!e.lsTime && e.target && e.target.classList && e.target.classList.contains('ls-time')) e.stopImmediatePropagation();
  }, true);
  window.addEventListener('change', function (e) {
    if (e.lsTime || !e.target || !e.target.classList || !e.target.classList.contains('ls-time')) return;
    // the browser's own change: ours (tidied up) goes instead
    e.stopImmediatePropagation();
    commit(e.target, null);
  }, true);
  window.addEventListener('blur', function (e) { if (e.target && e.target.classList && e.target.classList.contains('ls-time')) commit(e.target, null); }, true);
  // a form sent with Enter or a click: its times tidied up first
  window.addEventListener('submit', function (e) { if (e.target && e.target.querySelectorAll) e.target.querySelectorAll('input.ls-time').forEach(function (t) { commit(t, null); }); }, true);

  // ------------------------------------------------------------ date: "wed 7 Oct 2026", ‹ ›, a calendar
  function dateLabel(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return '—';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(LANG, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function shiftDate(v, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3] + n) : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dateField(inp) {
    if (inp.classList.contains('ls-date-native')) return;
    var wrap = document.createElement('span');
    wrap.className = 'ls-datepick';
    inp.parentNode.insertBefore(wrap, inp);
    var prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'ls-step'; prev.textContent = '‹'; prev.setAttribute('aria-label', '-1');
    var label = document.createElement('span');
    label.className = 'ls-date-label'; label.tabIndex = 0; label.setAttribute('role', 'button');
    var next = document.createElement('button');
    next.type = 'button'; next.className = 'ls-step'; next.textContent = '›'; next.setAttribute('aria-label', '+1');
    wrap.appendChild(prev); wrap.appendChild(label); wrap.appendChild(next); wrap.appendChild(inp);
    inp.classList.add('ls-date-native');
    inp.tabIndex = -1;
    var paint = function () { label.textContent = dateLabel(get(inp)); };
    Object.defineProperty(inp, 'value', { configurable: true, get: function () { return get(inp); }, set: function (v) { set(inp, v); paint(); } });
    inp.addEventListener('input', paint);
    inp.addEventListener('change', paint);
    var step = function (n) { set(inp, shiftDate(get(inp), n)); paint(); fire(inp, 'input'); fire(inp, 'change'); };
    prev.onclick = function () { step(-1); };
    next.onclick = function () { step(1); };
    var open = function () { try { inp.showPicker(); } catch (e) { inp.focus(); inp.click(); } };
    label.onclick = open;
    label.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); };
    paint();
  }

  // ------------------------------------------------------------ date and time: both, in sync with the original
  function dateTimeField(orig) {
    if (orig.dataset.lsDt) return;
    orig.dataset.lsDt = '1';
    var wrap = document.createElement('span');
    wrap.className = 'ls-dt';
    var date = document.createElement('input');
    date.type = 'date';
    var time = document.createElement('input');
    time.type = 'time';
    if (orig.required) { date.required = true; time.required = true; }
    var min = orig.getAttribute('min');
    var max = orig.getAttribute('max');
    if (min) date.min = min.slice(0, 10);
    if (max) date.max = max.slice(0, 10);
    var v0 = get(orig);
    orig.type = 'hidden';
    orig.parentNode.insertBefore(wrap, orig.nextSibling);
    wrap.appendChild(date);
    wrap.appendChild(time);
    var split = function (v) { var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v || ''); return m ? [m[1], m[2]] : ['', '']; };
    var paint = function () { var p = split(get(orig)); date.value = p[0]; set(time, p[1]); lastOf.set(time, p[1]); };
    Object.defineProperty(orig, 'value', { configurable: true, get: function () { return get(orig); }, set: function (v) { set(orig, v); paint(); } });
    var sync = function () {
      var d = date.value;
      var t = parseTime(get(time));
      // a day chosen without a time: the time it had, else nine o'clock
      if (d && !t) { t = split(get(orig))[1] || '09:00'; set(time, t); lastOf.set(time, t); }
      var v = d && t ? d + 'T' + t : '';
      if (v === get(orig)) return;
      set(orig, v);
      fire(orig, 'input');
      fire(orig, 'change');
    };
    date.addEventListener('change', sync);
    time.addEventListener('change', sync);
    dateField(date);
    timeField(time);
    set(orig, v0);
    paint();
  }

  function enhance(root) {
    if (!root || !root.querySelectorAll) return;
    var list = root.matches && root.matches('input') ? [root] : root.querySelectorAll('input[type="time"], input[type="datetime-local"], input[type="date"][data-ls-date]');
    Array.prototype.forEach.call(list, function (inp) {
      if (inp.hasAttribute('data-native')) return;
      if (inp.type === 'time') timeField(inp);
      else if (inp.type === 'datetime-local') dateTimeField(inp);
      else if (inp.type === 'date' && inp.hasAttribute('data-ls-date')) dateField(inp);
    });
  }
  enhance(document);
  new MutationObserver(function (muts) {
    muts.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) enhance(n); }); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.LsTime = { parseTime: parseTime, addMinutes: addMinutes, enhance: enhance };
})();
