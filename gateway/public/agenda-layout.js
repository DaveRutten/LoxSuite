// Agenda layout helpers, shared by the agenda page and its tests: the text colour for an appointment
// on its calendar colour, and the lanes of overlapping appointments in the day/week view.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgendaLayout = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // black or white text, whichever reads best on this colour
  function textOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return '#fff';
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lum = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
    return L > 0.35 ? '#111' : '#fff';
  }
  // side-by-side lanes for appointments that overlap: [{ item, lane, lanes }]
  function lanes(list) {
    var sorted = list.slice().sort(function (a, b) { return new Date(a.start) - new Date(b.start) || new Date(b.end) - new Date(a.end); });
    var out = [], group = [], groupEnd = 0, ends = [];
    var flush = function () { var n = ends.length || 1; group.forEach(function (g) { g.lanes = n; }); group = []; ends = []; };
    sorted.forEach(function (it) {
      var a = new Date(it.start).getTime(), b = Math.max(new Date(it.end).getTime(), a + 30 * 60000);
      if (group.length && a >= groupEnd) flush();
      var lane = ends.findIndex(function (e) { return e <= a; });
      if (lane < 0) { lane = ends.length; ends.push(b); } else ends[lane] = b;
      var rec = { item: it, lane: lane, lanes: 1 };
      group.push(rec); out.push(rec);
      groupEnd = Math.max(groupEnd, b);
    });
    flush();
    return out;
  }

  return { textOn: textOn, lanes: lanes };
}));
