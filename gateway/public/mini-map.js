// A small street map (OpenStreetMap tiles, no satellite) with a pin per car. No library: the tiles
// around the point are laid out as plain images. lsMiniMap(el, [{ lat, lon, label }], { height })
// One point: zoom 15. Several: the closest zoom that shows them all. Click opens openstreetmap.org.
(function () {
  var TILE = 256;
  function px(lat, lon, z) {
    var n = Math.pow(2, z) * TILE;
    var s = Math.sin(lat * Math.PI / 180);
    return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  window.lsMiniMap = function (el, points, opt) {
    opt = opt || {};
    points = (points || []).filter(function (p) { return Number.isFinite(p.lat) && Number.isFinite(p.lon) && !(p.lat === 0 && p.lon === 0); });
    if (!points.length) { el.hidden = true; return; }
    el.hidden = false;
    var W = Math.max(200, el.clientWidth || 400), H = opt.height || 200;
    var z = 15;
    if (points.length > 1) {
      for (z = 16; z > 3; z--) {
        var ps = points.map(function (p) { return px(p.lat, p.lon, z); });
        var xs = ps.map(function (p) { return p.x; }), ys = ps.map(function (p) { return p.y; });
        if (Math.max.apply(null, xs) - Math.min.apply(null, xs) < W - 60 && Math.max.apply(null, ys) - Math.min.apply(null, ys) < H - 60) break;
      }
    }
    var pts = points.map(function (p) { return px(p.lat, p.lon, z); });
    var cx = pts.reduce(function (a, p) { return a + p.x; }, 0) / pts.length;
    var cy = pts.reduce(function (a, p) { return a + p.y; }, 0) / pts.length;
    var left = cx - W / 2, top = cy - H / 2, max = Math.pow(2, z);
    var html = '';
    for (var tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
      for (var ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) {
        if (ty < 0 || ty >= max) continue;
        var wx = ((tx % max) + max) % max;
        html += '<img src="https://tile.openstreetmap.org/' + z + '/' + wx + '/' + ty + '.png" alt="" loading="lazy" draggable="false" style="position:absolute; left:' + Math.round(tx * TILE - left) + 'px; top:' + Math.round(ty * TILE - top) + 'px; width:256px; height:256px;">';
      }
    }
    points.forEach(function (p, i) {
      var x = Math.round(pts[i].x - left), y = Math.round(pts[i].y - top);
      html += '<div class="mini-map-pin" style="left:' + x + 'px; top:' + y + 'px;" title="' + esc(p.label) + '"></div>' +
        (p.label ? '<div class="mini-map-label" style="left:' + x + 'px; top:' + (y + 6) + 'px;">' + esc(p.label) + '</div>' : '');
    });
    var c = points.length === 1 ? points[0] : { lat: points.reduce(function (a, p) { return a + p.lat; }, 0) / points.length, lon: points.reduce(function (a, p) { return a + p.lon; }, 0) / points.length };
    html += '<a class="mini-map-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';
    el.className = 'mini-map';
    el.style.height = H + 'px';
    el.innerHTML = '<a class="mini-map-open" href="https://www.openstreetmap.org/?mlat=' + c.lat.toFixed(5) + '&mlon=' + c.lon.toFixed(5) + '#map=' + z + '/' + c.lat.toFixed(5) + '/' + c.lon.toFixed(5) + '" target="_blank" rel="noopener" aria-label="OpenStreetMap"></a>' + html;
  };
})();
