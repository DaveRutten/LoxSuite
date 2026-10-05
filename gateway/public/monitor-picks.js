// "Use in Monitor" pickers (vehicle page, OCPP statistics): one compact tile per published value.
// Values that already have a monitor are shown checked with a link to it; the button adds the newly
// ticked ones, after which they turn into links too. lsMonitorPicks(el, { items, postUrl, button, out })
// items: [{ key, label, topic, monitorId }]
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function T(s) { return window.lsT ? window.lsT(s) : s; }
  window.lsMonitorPicks = function (el, opt) {
    var items = opt.items || [];
    function draw() {
      el.className = 'pick-grid';
      el.innerHTML = items.map(function (it) {
        var on = !!it.monitorId;
        return '<label class="pick' + (on ? ' pick-on' : '') + '"><input type="checkbox" value="' + esc(it.key) + '"' + (on ? ' checked disabled' : '') + '>' +
          '<span class="pick-text"><span class="pick-name">' + esc(it.label) + '</span>' +
          (on ? '<a class="pick-link" href="/monitor/' + it.monitorId + '">' + esc(T('in Monitor')) + ' →</a>' : '') +
          (it.topic ? '<code class="pick-topic">' + esc(it.topic) + '</code>' : '') + '</span></label>';
      }).join('');
      var free = items.filter(function (it) { return !it.monitorId; }).length;
      if (opt.button) opt.button.hidden = free === 0;
    }
    draw();
    if (opt.button) opt.button.addEventListener('click', function () {
      var metrics = Array.prototype.slice.call(el.querySelectorAll('input:checked:not(:disabled)')).map(function (c) { return c.value; });
      if (!metrics.length) { if (opt.out) opt.out.textContent = T('Pick at least one value.'); return; }
      opt.button.disabled = true;
      fetch(opt.postUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metrics: metrics }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) { if (opt.out) opt.out.textContent = d.message || 'Error'; return; }
          items.forEach(function (it) { if (d.ids && d.ids[it.key]) it.monitorId = d.ids[it.key]; });
          draw();
          if (opt.out) opt.out.innerHTML = esc(T('Added {0} monitor(s).').replace('{0}', d.created.length)) + ' <a href="/monitor">' + esc(T('Open Monitor')) + '</a>';
        })
        .catch(function (e) { if (opt.out) opt.out.textContent = e.message; })
        .finally(function () { opt.button.disabled = false; });
    });
  };
})();
