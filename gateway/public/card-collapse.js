// Fold a card (tile) away: every .card whose header holds an <h2> gets a small chevron button. A folded
// card shows only its header. The choice is remembered on this device/browser (localStorage), per page
// and card — so the phone and the PC can each have their own layout. data-no-collapse on a card opts
// out. Cards added later by a page's own script are picked up too.
(function () {
  var PREFIX = 'ls-card:';
  function store(key, val) {
    try { if (val) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch (e) { /* private mode */ }
  }
  function stored(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
  }
  function slug(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40); }
  var CHEVRON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  // The direct child of the card that holds its title: the <h2> itself or a header row around it.
  function headOf(card) {
    for (var i = 0; i < Math.min(2, card.children.length); i++) {
      var c = card.children[i];
      if (c.tagName === 'H2') return { head: c, h2: c };
      if (c.tagName !== 'FORM' && c.querySelector && c.children.length <= 4) {
        var h = c.querySelector(':scope > h2');
        if (h) return { head: c, h2: h };
      }
    }
    return null;
  }

  var seen = 0;
  function setup(card, index) {
    if (card.dataset.collapseReady || card.hasAttribute('data-no-collapse') || card.closest('.login-box, .dash-panel')) return;
    var hd = headOf(card);
    if (!hd || card.children.length < 2) return;
    card.dataset.collapseReady = '1';
    // Key: page + position + the card's own key (data-card-key) or its title as first rendered.
    var key = PREFIX + location.pathname + ':' + (card.dataset.cardKey || index + ':' + slug(hd.h2.textContent));
    hd.head.classList.add('card-head');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card-collapse-btn';
    btn.innerHTML = CHEVRON;
    var apply = function (folded) {
      card.classList.toggle('card-collapsed', folded);
      btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
      btn.title = folded ? (window.lsT ? window.lsT('Unfold') : 'Unfold') : (window.lsT ? window.lsT('Fold') : 'Fold');
    };
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var folded = !card.classList.contains('card-collapsed');
      apply(folded);
      store(key, folded);
    });
    hd.h2.classList.add('card-collapse-title');
    hd.h2.appendChild(btn);
    apply(stored(key));
  }

  function scan() {
    var cards = document.querySelectorAll('main .card, .content .card, .main .card');
    if (!cards.length) cards = document.querySelectorAll('.card');
    Array.prototype.forEach.call(cards, function (c, i) { setup(c, i); });
    seen = cards.length;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  var timer = null;
  new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(function () { timer = null; if (document.querySelectorAll('.card').length !== seen) scan(); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
