// One look for the charts in the energy part (Smart charging, Meters, energy manager, consumers, Learned,
// Driving & costs, charge log): smooth lines that never overshoot (monotone cubic — a battery never seems
// to go above 100% or a meter below zero), a light wash below a line, soft columns with a rounded end,
// hairline gridlines, and a crosshair with a summary when you point at a chart. Plain functions that
// return SVG strings; the colors are the --en-* variables in style.css (light and dark, checked to be
// told apart, also with colour blindness).
(function () {
  var f = function (v) { return (Math.round(v * 10) / 10).toString(); };

  // Points [[x, y], …] in order of x -> a smooth path through all of them (Fritsch–Carlson).
  function smooth(pts) {
    var p = [];
    (pts || []).forEach(function (q) { if (q && isFinite(q[0]) && isFinite(q[1])) { if (p.length && q[0] - p[p.length - 1][0] < 0.3) p[p.length - 1] = q; else p.push(q); } });
    var n = p.length;
    if (!n) return '';
    if (n < 3) return 'M' + p.map(function (q) { return f(q[0]) + ',' + f(q[1]); }).join('L');
    var dx = [], m = [], t = [];
    for (var i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = dx[i] ? (p[i + 1][1] - p[i][1]) / dx[i] : 0; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (var j = 1; j < n - 1; j++) t[j] = m[j - 1] * m[j] <= 0 ? 0 : (m[j - 1] + m[j]) / 2;
    for (var k = 0; k < n - 1; k++) {
      if (m[k] === 0) { t[k] = 0; t[k + 1] = 0; continue; }
      var a = t[k] / m[k], b = t[k + 1] / m[k], h = a * a + b * b;
      if (h > 9) { var s = 3 / Math.sqrt(h); t[k] = s * a * m[k]; t[k + 1] = s * b * m[k]; }
    }
    var d = 'M' + f(p[0][0]) + ',' + f(p[0][1]);
    for (var q = 0; q < n - 1; q++) {
      var h3 = dx[q] / 3;
      d += 'C' + f(p[q][0] + h3) + ',' + f(p[q][1] + t[q] * h3) + ' ' + f(p[q + 1][0] - h3) + ',' + f(p[q + 1][1] - t[q + 1] * h3) + ' ' + f(p[q + 1][0]) + ',' + f(p[q + 1][1]);
    }
    return d;
  }
  function clean(pts) { return (pts || []).filter(function (q) { return q && isFinite(q[0]) && isFinite(q[1]); }); }
  // The area between a smooth line and a baseline.
  function area(pts, baseY) {
    var p = clean(pts);
    if (p.length < 2) return '';
    return smooth(p) + 'L' + f(p[p.length - 1][0]) + ',' + f(baseY) + 'L' + f(p[0][0]) + ',' + f(baseY) + 'Z';
  }
  // The area between two smooth lines (a band: low – high).
  function between(up, lo) {
    var a = smooth(clean(up)), b = smooth(clean(lo).slice().reverse());
    return a && b ? a + 'L' + b.slice(1) + 'Z' : '';
  }
  // A smooth line: 2px, round ends. o: { w, dash, opacity }
  function line(pts, color, o) {
    o = o || {};
    var d = smooth(clean(pts));
    return d ? '<path d="' + d + '" fill="none" style="stroke:' + color + ';" stroke-width="' + (o.w || 2) + '" stroke-linecap="round" stroke-linejoin="round"' + (o.dash ? ' stroke-dasharray="' + o.dash + '"' : '') + (o.opacity != null ? ' opacity="' + o.opacity + '"' : '') + '/>' : '';
  }
  var gid = 0;
  // A light wash between a line and its baseline: the color at `top` opacity at the line, fading out
  // toward the baseline (also for an area below the baseline).
  function wash(pts, baseY, color, top) {
    var p = clean(pts);
    if (p.length < 2) return '';
    var id = 'lsg' + (++gid);
    var below = p.reduce(function (s, q) { return s + q[1]; }, 0) / p.length > baseY;
    var o1 = top == null ? 0.22 : top;
    return '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:' + color + '; stop-opacity:' + (below ? 0.02 : o1) + ';"/><stop offset="1" style="stop-color:' + color + '; stop-opacity:' + (below ? o1 : 0.02) + ';"/></linearGradient></defs>' +
      '<path d="' + area(p, baseY) + '" fill="url(#' + id + ')"/>';
  }
  // A column with a rounded end (top, or bottom with o.down): square at the baseline.
  function col(x, y, w, h, o) {
    o = o || {};
    if (!(w > 0) || !(h > 0)) return '';
    var r = Math.max(0, Math.min(o.r == null ? 4 : o.r, w / 2, h));
    var d = o.down
      ? 'M' + f(x) + ',' + f(y) + 'V' + f(y + h - r) + 'Q' + f(x) + ',' + f(y + h) + ' ' + f(x + r) + ',' + f(y + h) + 'H' + f(x + w - r) + 'Q' + f(x + w) + ',' + f(y + h) + ' ' + f(x + w) + ',' + f(y + h - r) + 'V' + f(y) + 'Z'
      : 'M' + f(x) + ',' + f(y + h) + 'V' + f(y + r) + 'Q' + f(x) + ',' + f(y) + ' ' + f(x + r) + ',' + f(y) + 'H' + f(x + w - r) + 'Q' + f(x + w) + ',' + f(y) + ' ' + f(x + w) + ',' + f(y + r) + 'V' + f(y + h) + 'Z';
    return '<path d="' + d + '" style="fill:' + (o.color || 'currentColor') + ';"' + (o.opacity != null ? ' opacity="' + o.opacity + '"' : '') + '>' + (o.title ? '<title>' + o.title + '</title>' : '') + '</path>';
  }
  // A hairline (gridline): solid, one step off the surface.
  function hline(x1, x2, y, opacity) {
    return '<line x1="' + f(x1) + '" y1="' + f(y) + '" x2="' + f(x2) + '" y2="' + f(y) + '" stroke="currentColor" opacity="' + (opacity == null ? 0.07 : opacity) + '"/>';
  }

  // A legend key that looks like its mark: kind 'line' (a stripe, default), 'col' (a square: columns,
  // bars), 'dash' (a dashed stripe), 'band' (a light block). HTML, for legends, tiles and the hover card.
  function key(color, kind) {
    var k = kind && kind !== 'line' ? ' ls-key-' + kind : '';
    return '<i class="ls-key' + k + '" style="' + (kind === 'dash' ? 'border-top-color:' : 'background:') + color + ';"></i>';
  }
  function keyEl(color, kind) {
    var i = document.createElement('i');
    i.className = 'ls-key' + (kind && kind !== 'line' ? ' ls-key-' + kind : '');
    if (kind === 'dash') i.style.borderTopColor = color; else i.style.background = color;
    return i;
  }

  // Point at a chart: a vertical crosshair snaps to the nearest position and a small card lists every
  // series there. host: the element around the <svg>; o: { W (viewBox width), top, bottom (viewBox y),
  // n, x(i) (viewBox x of position i), title(i), rows(i) -> [[label, value, color?, kind?], …] (kind as
  // in key()), click(i)? }.
  function hover(host, o) {
    var svg = host && host.querySelector('svg');
    if (!svg || !o || !o.n) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var ns = 'http://www.w3.org/2000/svg';
    var xh = document.createElementNS(ns, 'line');
    xh.setAttribute('y1', o.top); xh.setAttribute('y2', o.bottom); xh.setAttribute('stroke', 'currentColor'); xh.setAttribute('stroke-width', '1'); xh.setAttribute('opacity', '0'); xh.setAttribute('pointer-events', 'none');
    svg.appendChild(xh);
    var tip = document.createElement('div');
    tip.className = 'ls-tip';
    tip.hidden = true;
    host.appendChild(tip);
    var at = function (ev) {
      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) * o.W / r.width, best = 0, bd = Infinity;
      for (var i = 0; i < o.n; i++) { var dd = Math.abs(o.x(i) - x); if (dd < bd) { bd = dd; best = i; } }
      return best;
    };
    svg.addEventListener('pointermove', function (ev) {
      var i = at(ev), cx = o.x(i);
      xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.setAttribute('opacity', '0.4');
      tip.textContent = '';
      var h = document.createElement('div'); h.className = 'ls-tip-h'; h.textContent = o.title(i); tip.appendChild(h);
      (o.rows(i) || []).forEach(function (rw) {
        if (!rw) return;
        var div = document.createElement('div');
        var l = document.createElement('span');
        l.className = 'ls-tip-l';
        if (rw[2]) l.appendChild(keyEl(rw[2], rw[3]));
        var lt = document.createElement('span'); lt.textContent = rw[0]; l.appendChild(lt);
        var v = document.createElement('strong'); v.textContent = rw[1];
        div.appendChild(l); div.appendChild(v); tip.appendChild(div);
      });
      var r = svg.getBoundingClientRect(), hr = host.getBoundingClientRect(), px = ev.clientX - hr.left;
      tip.hidden = false;
      tip.style.left = (px + 14 + tip.offsetWidth > hr.width ? Math.max(0, px - tip.offsetWidth - 14) : px + 14) + 'px';
      tip.style.top = Math.max(0, ev.clientY - hr.top - 24) + 'px';
      void r;
    });
    svg.addEventListener('pointerleave', function () { xh.setAttribute('opacity', '0'); tip.hidden = true; });
    if (o.click) { svg.style.cursor = 'pointer'; svg.addEventListener('click', function (ev) { o.click(at(ev)); }); }
  }

  window.LsChart = { smooth: smooth, area: area, between: between, line: line, wash: wash, col: col, hline: hline, hover: hover, key: key, keyEl: keyEl };
})();
