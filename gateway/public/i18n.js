// Translates the texts that the page's own scripts build (tables, charts, status lines, messages),
// using window.LS_I18N = { "English text": "translation" } from /i18n/<lang>.js. The HTML that the
// server renders is already translated (t() in the views); this covers what JavaScript adds later.
//
// Texts with placeholders ("{0} sessions", "Learned: {0} runs") match a whole text node with the
// placeholders standing for any value; the translation gets those values back in its own order.
// Also translates placeholder/title/aria-label attributes, and the messages of confirm()/alert().
(function () {
  var D = window.LS_I18N;
  if (!D) return;
  var exact = Object.create(null);
  var byWord = Object.create(null); // literal word -> patterns that contain it
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var exactKeys = []; // for prefix matches ("Plan: …" followed by more text)
  var STOP = { the: 1, and: 1, for: 1, with: 1, from: 1, this: 1, that: 1, not: 1, are: 1, was: 1, you: 1, your: 1, its: 1, has: 1, all: 1, any: 1, one: 1, can: 1, but: 1, out: 1, per: 1, into: 1, than: 1, then: 1, when: 1, only: 1 };
  var keyWords = function (str) { return (str.toLowerCase().match(/[a-zà-ÿ]{3,}/g) || []).filter(function (w) { return !STOP[w]; }); };
  Object.keys(D).forEach(function (k) {
    if (k.indexOf('{') === -1) { exact[k] = D[k]; if (k.length >= 6 && /\s/.test(k)) exactKeys.push(k); return; }
    var order = [];
    var src = k.split(/(\{\d+\})/).map(function (part) {
      var m = /^\{(\d+)\}$/.exec(part);
      if (m) { order.push(Number(m[1])); return '([\\s\\S]*?)'; }
      return esc(part);
    }).join('');
    var lit = k.replace(/\{\d+\}/g, '').length;
    var endsLiteral = !/\{\d+\}$/.test(k);
    var p = { re: new RegExp('^' + src + '$'), pre: endsLiteral ? new RegExp('^' + src) : null, to: D[k], order: order, lit: lit };
    var words = keyWords(k.replace(/\{\d+\}/g, ' '));
    if (!words.length) return;
    // indexed under every word, so any word of a text finds it
    words.forEach(function (w) { (byWord[w] = byWord[w] || []).indexOf(p) === -1 && byWord[w].push(p); });
  });
  exactKeys.sort(function (a, b) { return b.length - a.length; });

  function fill(p, r, depth) {
    // a value can itself be a translatable text ("{0} kWh/day, about {1} kW while running")
    var byNum = {};
    p.order.forEach(function (num, idx) {
      var v = r[idx + 1];
      if (depth < 2 && v && /[A-Za-z]{3}/.test(v)) { var t2 = tr(v, depth + 1); if (t2 !== null) v = t2; }
      byNum[num] = v;
    });
    // placeholder {n} in the key = the n-th value; the translation may use them in any order
    return p.to.replace(/\{(\d+)\}/g, function (all, d) { return byNum[d] !== undefined ? byNum[d] : all; });
  }

  function tr(text, depth) {
    depth = depth || 0;
    if (!text) return null;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    var core = m[2];
    if (!core || !/[A-Za-z]{2}/.test(core)) return null;
    var norm = core.replace(/\s+/g, ' ');
    if (exact[norm] !== undefined) return m[1] + exact[norm] + m[3];
    // ALL CAPS label ("NEEDS", "NO"): look up as "Needs"/"needs" and keep it in capitals
    if (norm.length > 1 && norm === norm.toUpperCase() && /[A-Z]{2}/.test(norm)) {
      var low = norm.toLowerCase(), cap = low.charAt(0).toUpperCase() + low.slice(1);
      var hit = exact[cap] !== undefined ? exact[cap] : exact[low];
      if (hit !== undefined) return m[1] + hit.toUpperCase() + m[3];
    }
    var words = keyWords(norm);
    if (!words.length) return null;
    // candidates from every word of the text, longest literal text first (most specific)
    var cand = [];
    var seen = Object.create(null);
    for (var i = 0; i < words.length; i++) {
      if (seen[words[i]]) continue;
      seen[words[i]] = 1;
      var list = byWord[words[i]];
      if (list) for (var j = 0; j < list.length; j++) if (cand.indexOf(list[j]) === -1) cand.push(list[j]);
    }
    cand.sort(function (a, b) { return b.lit - a.lit; });
    for (var c = 0; c < cand.length; c++) {
      var r = cand[c].re.exec(norm);
      if (r) return m[1] + fill(cand[c], r, depth) + m[3];
    }
    if (depth >= 2) return null;
    // a known text followed by more ("estimated from … · trip needs 11 kWh"): translate both parts
    for (var e = 0; e < exactKeys.length; e++) {
      var k = exactKeys[e];
      if (norm.length > k.length && norm.indexOf(k) === 0 && /[\s:·,.—(]/.test(norm.charAt(k.length) + k.charAt(k.length - 1))) {
        var rest = norm.slice(k.length);
        var tRest = tr(rest, depth + 1);
        return m[1] + exact[k] + (tRest !== null ? tRest : rest) + m[3];
      }
    }
    // … followed by a known text at the end ("09:57 · advise only")
    for (var e2 = 0; e2 < exactKeys.length; e2++) {
      var k2 = exactKeys[e2];
      if (norm.length > k2.length && norm.slice(-k2.length) === k2 && /[\s·,(—:]/.test(norm.charAt(norm.length - k2.length - 1))) {
        var head = norm.slice(0, norm.length - k2.length);
        var tHead = tr(head, depth + 1);
        return m[1] + (tHead !== null ? tHead : head) + exact[k2] + m[3];
      }
    }
    for (var c2 = 0; c2 < cand.length; c2++) {
      if (!cand[c2].pre) continue;
      var r2 = cand[c2].pre.exec(norm);
      if (!r2 || r2[0].length >= norm.length) continue;
      var rest2 = norm.slice(r2[0].length);
      var tRest2 = tr(rest2, depth + 1);
      return m[1] + fill(cand[c2], r2, depth) + (tRest2 !== null ? tRest2 : rest2) + m[3];
    }
    return null;
  }
  window.lsT = function (s) { var r = tr(String(s)); return r === null ? s : r; };

  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, NOSCRIPT: 1 };
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  function skipEl(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP[e.tagName] || (e.hasAttribute && e.hasAttribute('data-no-i18n')) || e.isContentEditable) return true;
    }
    return false;
  }
  function doText(node) {
    if (!node.parentNode || skipEl(node.parentNode)) return;
    var r = tr(node.nodeValue);
    if (r !== null && r !== node.nodeValue) node.nodeValue = r;
  }
  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (!v) continue;
      var r = tr(v);
      if (r !== null && r !== v) el.setAttribute(ATTRS[i], r);
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) { var rv = tr(el.value); if (rv !== null) el.value = rv; }
  }
  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 || SKIP[root.tagName]) return;
    if (skipEl(root)) return;
    doAttrs(root);
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) { return n.nodeType === 1 && (SKIP[n.tagName] || n.hasAttribute('data-no-i18n')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    var n;
    while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  var busy = false;
  var obs = new MutationObserver(function (muts) {
    if (busy) return;
    busy = true;
    try {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') { if (m.target.nodeType === 1 && !skipEl(m.target)) doAttrs(m.target); }
        else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
      }
    } finally { obs.takeRecords(); busy = false; }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  var c = window.confirm, a = window.alert, p = window.prompt;
  window.confirm = function (msg) { return c.call(window, window.lsT(msg)); };
  window.alert = function (msg) { return a.call(window, window.lsT(msg)); };
  window.prompt = function (msg, def) { return p.call(window, window.lsT(msg), def); };
})();
