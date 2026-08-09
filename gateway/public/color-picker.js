// Shared color-picker control, used everywhere a color is picked (threshold rows, value-mapping
// rows, annotation rows, chart-series rows — see panel-grid.ejs). Replaces four independent copies
// of a bare native <input type="color"> with one component that adds palette swatches and a
// custom-hex fallback on top of that same native input, rather than instead of it.
//
// default/warm/bold are three validated orderings of the SAME eight hues monitor-chart.js's own
// LIGHT_PALETTE/DARK_PALETTE already uses for un-colored chart series (see that file's own
// comment) — not three different hue sets. Re-ordering (not re-hueing) is deliberate: the
// project's dataviz skill treats the slot order as the CVD-safety mechanism itself, validated as a
// whole against adjacent-pair contrast/color-vision-deficiency checks — inventing new hues here
// would mean re-deriving that validation from scratch. These three are plain rotations of the
// default order (see monitor-chart.js), each independently re-validated (scripts/validate_palette
// in the project's dataviz skill) rather than assumed safe by resemblance to the default.
//
// `vivid`/`pastel`/`muted` are different on purpose: each is eight hues spread evenly around the
// wheel at a different lightness/saturation character (fully-saturated / light-and-soft / deep-and-
// dusty), picked for looking OBVIOUSLY different from each other at a glance (e.g. picking a test
// color for an RGBW light — see mappings-loxone-to-mqtt-tabulator.js's own Test dialog) rather than
// for chart-legend legibility — none of the three has been run through the dataviz skill's own CVD/
// contrast validation the three palettes above have, so none is a substitute for them on a chart
// series; same light/dark values for all of these, since a swatch is a self-contained block of
// color rather than a line that needs contrast tuned against whatever's behind it the way a chart
// series does.
window.LoxColorPicker = (function () {
  var VIVID = ['#ff0000', '#ff8c00', '#ffd400', '#00b300', '#00c8c8', '#0066ff', '#8000ff', '#ff00b3'];
  var PASTEL = ['#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff', '#bdb2ff', '#ffc6ff'];
  var MUTED = ['#c97b6d', '#cb9d6a', '#cdbb6a', '#8fa66b', '#6b9a8f', '#6b87a6', '#8a749c', '#b57a94'];
  var PALETTES = {
    default: {
      label: 'Default',
      light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
      dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    },
    warm: {
      label: 'Starts with orange',
      light: ['#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948', '#2a78d6'],
      dark: ['#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#3987e5'],
    },
    bold: {
      label: 'Starts with red',
      light: ['#e34948', '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7'],
      dark: ['#e66767', '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
    },
    vivid: {
      label: 'Vivid (wide spread)',
      light: VIVID,
      dark: VIVID,
    },
    pastel: {
      label: 'Pastel (soft, light)',
      light: PASTEL,
      dark: PASTEL,
    },
    muted: {
      label: 'Muted (soft, deep)',
      light: MUTED,
      dark: MUTED,
    },
  };
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;

  function isDarkTheme() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark' || explicit === 'light') return explicit === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function paletteColors(key) {
    var p = PALETTES[key] || PALETTES.default;
    return isDarkTheme() ? p.dark : p.light;
  }

  // The default color a freshly-added row (threshold/value-mapping/annotation/chart-series) gets,
  // so a 2nd row never silently starts out the same color as the 1st: the first palette slot NOT
  // already used by a sibling row, in palette order — not just "the next slot by position", which
  // would still repeat a color once a row's own color was manually changed away from its original
  // slot, or once a row got deleted and the count shifted. Once every slot is taken (more rows
  // than the palette has colors), falls back to cycling by count — still deterministic, just no
  // longer collision-free past that point.
  function nextAvailableColor(usedHexes, paletteKey) {
    var palette = paletteColors(paletteKey);
    var used = {};
    (usedHexes || []).forEach(function (h) { if (h) used[h.toLowerCase()] = true; });
    for (var i = 0; i < palette.length; i++) {
      if (!used[palette[i].toLowerCase()]) return palette[i];
    }
    return palette[(usedHexes || []).length % palette.length];
  }

  // Resolves any CSS color (name, hex, rgb()/hsl()) to a strict 6-digit hex — the one canonical
  // copy of what used to be four separate identical functions in panel-grid.ejs.
  function toHexColor(color) {
    if (!color) return '#e34948';
    if (HEX_RE.test(color)) return color;
    var probe = document.createElement('div');
    probe.style.color = color;
    document.body.appendChild(probe);
    var computed = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    var m = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return '#e34948';
    function hex(n) { return Number(n).toString(16).padStart(2, '0'); }
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  }

  // Returns markup only — the caller embeds this string in whatever row it's already building via
  // innerHTML (every existing call site builds its row that way). valueClassName is the caller's
  // own pre-existing "row-color"-style class name, kept on the (now-hidden) value input so every
  // call site's existing `row.querySelector('.the-same-class-as-before').value` read/write keeps
  // working unchanged — only how the control is built changes, not how its value is read back out.
  function buildPickerHtml(currentValue, valueClassName, wrapClassName) {
    var hex = toHexColor(currentValue);
    var options = Object.keys(PALETTES).map(function (key) {
      return '<option value="' + key + '">' + PALETTES[key].label + '</option>';
    }).join('');
    return (
      '<span class="color-picker-wrap' + (wrapClassName ? ' ' + wrapClassName : '') + '">' +
        '<button type="button" class="color-picker-swatch" style="background:' + hex + '" title="Choose color" aria-label="Choose color"></button>' +
        '<input type="hidden" class="' + valueClassName + ' color-picker-value" value="' + hex + '">' +
        '<div class="color-picker-popover" hidden>' +
          '<select class="color-picker-palette-select">' + options + '</select>' +
          '<div class="color-picker-swatch-grid"></div>' +
          '<label class="color-picker-custom-row"><input type="checkbox" class="color-picker-custom-toggle"> Custom</label>' +
          '<div class="color-picker-custom-fields" hidden>' +
            '<input type="color" class="color-picker-native" value="' + hex + '">' +
            '<input type="text" class="color-picker-hex-input" placeholder="#rrggbb" maxlength="7" value="' + hex + '">' +
          '</div>' +
        '</div>' +
      '</span>'
    );
  }

  // Dims/disables the swatch button for a wrap built with a wrapClassName (currently only the
  // chart-series row, whose color is gated behind its own "give this series its own color"
  // checkbox) — the hidden value input can't carry a visible disabled look on its own since it's
  // never rendered at all.
  function setSwatchDisabled(wrap, disabled) {
    if (!wrap) return;
    wrap.classList.toggle('is-disabled', !!disabled);
  }

  // isCustomSource: true when the hex came from the native/hex "Custom" fields, false when it
  // came from a palette grid swatch — drives the Custom checkbox so it always reflects which kind
  // of color is actually showing, rather than being something you have to remember to tick before
  // the fields even work. A grid-swatch pick un-ticks it (and re-hides the fields) even if it was
  // on from a previous custom pick in the same session.
  function setColor(wrap, hex, isCustomSource) {
    if (!HEX_RE.test(hex)) return;
    wrap.querySelector('.color-picker-value').value = hex;
    wrap.querySelector('.color-picker-swatch').style.background = hex;
    var native = wrap.querySelector('.color-picker-native');
    var hexInput = wrap.querySelector('.color-picker-hex-input');
    if (native) native.value = hex;
    if (hexInput) hexInput.value = hex;
    var customToggle = wrap.querySelector('.color-picker-custom-toggle');
    var customFields = wrap.querySelector('.color-picker-custom-fields');
    if (customToggle && customToggle.checked !== !!isCustomSource) customToggle.checked = !!isCustomSource;
    if (customFields) customFields.hidden = !isCustomSource;
    wrap.querySelector('.color-picker-value').dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderGrid(wrap) {
    var select = wrap.querySelector('.color-picker-palette-select');
    var grid = wrap.querySelector('.color-picker-swatch-grid');
    grid.innerHTML = paletteColors(select.value).map(function (hex) {
      return '<button type="button" class="color-picker-grid-swatch" style="background:' + hex + '" data-hex="' + hex + '" title="' + hex + '"></button>';
    }).join('');
  }

  function closeAllPopovers() {
    document.querySelectorAll('.color-picker-popover').forEach(function (p) { p.hidden = true; p.classList.remove('color-picker-popover-align-right'); });
  }

  // Opens flush with the trigger's LEFT edge by default (see the CSS) — fine for a swatch with
  // plenty of room to its right, but a swatch sitting near the right edge of a wide row (the
  // annotation/threshold builders both run nearly full-width) pushed the fixed-width popover
  // straight off the edge of the viewport. Flips to right-aligned instead whenever there isn't
  // enough room, measured against the actual trigger position rather than assumed from context.
  function positionPopover(wrap) {
    var popover = wrap.querySelector('.color-picker-popover');
    var swatch = wrap.querySelector('.color-picker-swatch');
    popover.classList.remove('color-picker-popover-align-right');
    var swatchRect = swatch.getBoundingClientRect();
    var popoverWidth = popover.offsetWidth || 256; // 16rem fallback (see the CSS) while still hidden pre-measure
    var wouldOverflow = swatchRect.left + popoverWidth > window.innerWidth - 8;
    if (wouldOverflow) popover.classList.add('color-picker-popover-align-right');
  }

  // One delegated listener set for the whole document rather than per-instance wiring — a row
  // added later (chart-series rows are added/removed as monitors are checked/unchecked, same as
  // the threshold/value-mapping/annotation "+ Add" buttons) needs no extra setup of its own, same
  // reasoning already used for every other dynamic row list in this app (see e.g. the Common
  // Commands catalog editor's own event-delegation comment).
  document.addEventListener('click', function (e) {
    var swatchBtn = e.target.closest('.color-picker-swatch');
    if (swatchBtn) {
      e.stopPropagation();
      var wrap = swatchBtn.closest('.color-picker-wrap');
      var popover = wrap.querySelector('.color-picker-popover');
      var wasHidden = popover.hidden;
      closeAllPopovers();
      if (wasHidden) {
        renderGrid(wrap);
        popover.hidden = false;
        positionPopover(wrap);
      }
      return;
    }
    var gridSwatch = e.target.closest('.color-picker-grid-swatch');
    if (gridSwatch) {
      e.stopPropagation();
      var wrap2 = gridSwatch.closest('.color-picker-wrap');
      setColor(wrap2, gridSwatch.dataset.hex, false);
      wrap2.querySelector('.color-picker-popover').hidden = true;
      return;
    }
    if (e.target.closest('.color-picker-popover')) { e.stopPropagation(); return; }
    closeAllPopovers();
  });

  document.addEventListener('change', function (e) {
    if (e.target.classList.contains('color-picker-palette-select')) {
      renderGrid(e.target.closest('.color-picker-wrap'));
    } else if (e.target.classList.contains('color-picker-custom-toggle')) {
      // Manually toggling it directly (not as a side effect of setColor above) just shows/hides
      // the fields to let you start entering a custom value — it doesn't commit a color by itself,
      // so the swatch/value only actually change once you interact with a field inside.
      var wrap = e.target.closest('.color-picker-wrap');
      wrap.querySelector('.color-picker-custom-fields').hidden = !e.target.checked;
    } else if (e.target.classList.contains('color-picker-hex-input')) {
      setColor(e.target.closest('.color-picker-wrap'), e.target.value.trim(), true);
    }
  });

  // The native <input type="color"> fires 'input' continuously while the OS picker is open
  // (dragging in a color wheel, say) — previewing live reads much better than waiting for its
  // eventual 'change' on close, which is why this is a separate listener from the one above.
  document.addEventListener('input', function (e) {
    if (e.target.classList.contains('color-picker-native')) {
      setColor(e.target.closest('.color-picker-wrap'), e.target.value, true);
    }
  });

  return {
    PALETTES: PALETTES,
    toHexColor: toHexColor,
    buildPickerHtml: buildPickerHtml,
    setSwatchDisabled: setSwatchDisabled,
    paletteColors: paletteColors,
    nextAvailableColor: nextAvailableColor,
    isDarkTheme: isDarkTheme,
  };
})();
