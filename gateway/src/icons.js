// Small hand-picked set of outline icons (Feather-style paths), inlined as SVG
// so the app stays fully self-contained — no icon font or CDN dependency.
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  link: '<path d="M10 14 21 3"/><path d="M21 3h-7M21 3v7"/><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>',
  power: '<path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  theme: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  edit: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 2-3 4"/><path d="M12 17h.01"/>',
  // The "show/hide help text" toggle (see foot.ejs's hints-toggle-btn) — a lightbulb reads more
  // immediately as "tips/hints" at a glance than the generic "?" (help) icon above, which already
  // means something more specific elsewhere (the topbar's own "explain this page" link).
  lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A6 6 0 1 0 8.5 12c.76.76 1.23 1.52 1.41 2.5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  gripVertical: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6 15.4 6.4M8.6 13.4 15.4 17.6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  // Three plain bars — distinct from `list` above (which has dots, meant for an actual list of
  // items) so it reads unambiguously as a nav/menu toggle rather than "view as list".
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  // Outline by default like every other icon here — a favorited dashboard's own button toggles a
  // CSS class (.is-favorited, see style.css) that fills it instead, rather than this needing a
  // second icon definition just for that.
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  // Two sources bridging into one hub — Loxone and MQTT devices merging into this gateway. An
  // original mark (not the Loxone logo), square-cropped from the same connection mark used in
  // docs/logo-light.svg and docs/logo-dark.svg (the README banner) and gateway/public/favicon.svg
  // — kept in sync with those if the mark itself ever changes.
  logo: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="2" stroke-width="1.5"/><circle cx="21" cy="12" r="2" stroke-width="1.5"/><path d="M5 12h2.5M16.5 12h2.5" stroke-width="1.5"/>',
  // The topbar Notification Center toggle (see partials/head.ejs) — its own unread-count badge is
  // a separate small element layered on top by CSS, not part of this icon.
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
};

function icon(name, opts) {
  const svgBody = ICONS[name];
  if (!svgBody) return '';
  const size = (opts && opts.size) || 15;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgBody}</svg>`;
}

module.exports = { icon };
