// Small line icons for the energy pages (24×24, stroke = currentColor), in the energy colours.
//   enIcon(name, color)                  the dashboard style: icon on a light square of its own colour
//   enIcon(name, color, { plain: true }) only the icon, for in front of a heading (subtle)
const PATHS = {
  grid: '<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  house: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  euro: '<path d="M17 6.5A7 7 0 1 0 17 17.5"/><path d="M4 10h9M4 14h9"/>',
  heat: '<path d="M12 3c2 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-7.5z"/>',
  panel: '<path d="M4 15l2-9h12l2 9z"/><path d="M5 10.5h14M10 6l-1 9M14 6l1 9M12 15v5M8 20h8"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 11v2"/>',
  tank: '<rect x="6" y="3" width="12" height="18" rx="5"/><path d="M6 12h12"/><path d="M10 16c0 1 1 1.5 2 1.5s2-.5 2-1.5-2-3-2-3-2 2-2 3z"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  snow: '<path d="M12 2v20M4.9 7l14.2 10M4.9 17L19.1 7"/><path d="M9 4l3 2 3-2M9 20l3-2 3 2"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
  bolt: '<path d="M13 2L5 13h6l-1 9 8-11h-6z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  bug: '<path d="M8 8a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0z"/><path d="M4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2"/>',
  tune: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

function enIcon(name, color = 'currentColor', { plain = false, size } = {}) {
  const p = PATHS[name];
  if (!p) return '';
  const px = size || (plain ? 16 : 20);
  const svg = `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  return plain ? `<span class="en-ic-plain" style="color:${color};">${svg}</span>` : `<span class="en-ic" style="color:${color};">${svg}</span>`;
}

module.exports = { enIcon, PATHS };
