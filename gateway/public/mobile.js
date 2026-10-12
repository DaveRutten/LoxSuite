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

// Push: an id this device keeps for itself, sent with its subscription so a renewed subscription
// replaces the old one instead of both getting every notification. Once a day the current
// subscription is sent again with it (also tags subscriptions made before the id existed).
(function () {
  window.lsPushDeviceId = function () {
    try {
      var id = localStorage.getItem('ls-push-device');
      if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, ''); localStorage.setItem('ls-push-device', id); }
      return id;
    } catch (e) { return null; }
  };
  try {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    var last = Number(localStorage.getItem('ls-push-device-sent') || 0);
    if (Date.now() - last < 86400000) return;
    navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; }).then(function (sub) {
      if (!sub) return;
      return fetch('/app/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), deviceId: window.lsPushDeviceId() }) })
        .then(function (r) { if (r.ok) localStorage.setItem('ls-push-device-sent', String(Date.now())); });
    }).catch(function () {});
  } catch (e) { /* no storage */ }
})();
