// Phone tweaks (see the "Phone / installed app" block in style.css): live status badges become just
// their coloured dot, with the word kept as tooltip + accessible label. Also for badges that tables
// render later (Tabulator), hence the observer.
(function () {
  var mq = window.matchMedia('(max-width: 768px)');
  var STATUS = /^(online|offline|connected|disconnected|connecting|live|enabled|disabled|active|inactive|open|closed|running|stopped|ok|failing|up|down)$/i;
  function mark(root) {
    if (!mq.matches) return;
    (root.querySelectorAll ? root.querySelectorAll('.badge-live') : []).forEach(function (b) {
      var t = (b.textContent || '').trim();
      if (!t || !STATUS.test(t) || b.classList.contains('badge-dot')) return;
      b.classList.add('badge-dot');
      b.title = t;
      b.setAttribute('aria-label', t);
    });
  }
  mark(document);
  new MutationObserver(function (list) { list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) mark(n.parentElement || n); }); }); })
    .observe(document.body, { childList: true, subtree: true });
  // Highlight the tab of the current section.
  var path = location.pathname;
  document.querySelectorAll('.mobile-tabbar a').forEach(function (a) {
    var h = a.getAttribute('href');
    if (h === '/' ? path === '/' : path === h || path.indexOf(h + '/') === 0) a.classList.add('active');
  });
  var more = document.getElementById('mobile-tabbar-more');
  if (more) more.addEventListener('click', function () { var t = document.getElementById('mobile-nav-toggle'); if (t) t.click(); });
})();
