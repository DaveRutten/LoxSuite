// Sub-menus that jump within a page (.section-nav with #anchors): the chip of the part you are looking at
// is lit. That is the last part whose heading has scrolled up to just below the bars; at the very bottom
// of the page the last part (a short last card never reaches the top); and after a click the chip you
// clicked, until you scroll yourself. The lit chip is kept in view when the menu scrolls sideways.
(function () {
  function init(nav) {
    var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
    if (!links.length) return;
    var targets = links.map(function (a) { return document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))); });
    var clicked = null;
    function shown(t) { return t && t.offsetParent !== null; }
    function set(i) {
      links.forEach(function (a, j) { a.classList.toggle('on', j === i); });
      var a = links[i];
      if (a && nav.scrollWidth > nav.clientWidth) {
        var l = a.offsetLeft - nav.offsetLeft, r = l + a.offsetWidth;
        if (l < nav.scrollLeft || r > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: Math.max(0, l - 16), behavior: 'smooth' });
      }
    }
    function pick() {
      if (clicked !== null) { set(clicked); return; }
      var tb = document.querySelector('.topbar');
      var line = (tb ? tb.getBoundingClientRect().bottom : 0) + nav.offsetHeight + 24;
      var idx = -1;
      targets.forEach(function (t, i) { if (shown(t) && t.getBoundingClientRect().top <= line) idx = i; });
      var doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
        for (var i = targets.length - 1; i >= 0; i--) if (shown(targets[i])) { idx = i; break; }
      }
      if (idx < 0) idx = targets.findIndex(shown);
      set(Math.max(0, idx));
    }
    links.forEach(function (a, i) { a.addEventListener('click', function () { clicked = i; set(i); }); });
    // your own scrolling takes over again from a click
    ['wheel', 'touchmove', 'keydown'].forEach(function (ev) { window.addEventListener(ev, function () { clicked = null; }, { passive: true }); });
    var queued = false;
    window.addEventListener('scroll', function () { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; pick(); }); }, { passive: true });
    window.addEventListener('resize', pick);
    if (location.hash) { var h = links.findIndex(function (a) { return a.getAttribute('href') === location.hash; }); if (h >= 0) clicked = h; }
    pick();
  }
  function run() { Array.prototype.forEach.call(document.querySelectorAll('.section-nav'), init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
