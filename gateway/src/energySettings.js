// The energy settings every energy page shares — electricity price, home & solar forecast, fuel — saved
// in one place, so they can be set whether or not Smart charging is on (Administration → Energy &
// charging posts here; /planner/settings still accepts them too).
const prices = require('./prices');
const solar = require('./solarForecast');
const settings = require('./wallboxSettings');
const fuelPrice = require('./fuelPrice');
const planner = require('./planner');

const SECTIONS = ['prices', 'solar', 'fuel'];

const num = (v, def = null) => {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
};

async function saveShared(section, b) {
  if (section === 'prices') {
    await prices.saveConfig({
      source: ['energyzero', 'entsoe', 'loxone', 'fixed'].includes(b.source) ? b.source : 'energyzero',
      entsoe_token: String(b.entsoe_token || ''), markup_eur_kwh: num(b.markup_eur_kwh, 0), energy_tax_eur_kwh: num(b.energy_tax_eur_kwh, 0),
      vat_pct: num(b.vat_pct, 21), fixed_eur_kwh: num(b.fixed_eur_kwh, 0.3), calibrate_loxone: !!b.calibrate_loxone,
      fixed_low_eur_kwh: num(b.fixed_low_eur_kwh, null),
      fixed_low_from: /^\d{1,2}:\d{2}$/.test(String(b.fixed_low_from || '').trim()) ? String(b.fixed_low_from).trim() : '23:00',
      fixed_low_until: /^\d{1,2}:\d{2}$/.test(String(b.fixed_low_until || '').trim()) ? String(b.fixed_low_until).trim() : '07:00',
      fixed_low_weekend: !!b.fixed_low_weekend,
      price_interval: b.price_interval === 'quarter' ? 'quarter' : 'hour',
      chart_interval: b.chart_interval === 'quarter' ? 'quarter' : 'hour',
    });
    prices.refreshPrices().catch(() => {});
  } else if (section === 'solar') {
    await settings.set('site', { lat: num(b.lat), lon: num(b.lon) });
    await settings.patch('solar', { enabled: !!b.enabled, kwp: num(b.kwp), tilt: num(b.tilt, 35), azimuth: num(b.azimuth, 0), efficiency: num(b.efficiency, 0.85) }, solar.DEFAULTS);
    solar.refreshForecast().catch(() => {});
  } else if (section === 'fuel') {
    await planner.saveConfig({
      fuel_eur_l: num(b.fuel_eur_l, 2.1), fuel_auto: !!b.fuel_auto, default_kwh_per_km: num(b.default_kwh_per_km, 0.2),
      fuel_type: Object.keys(fuelPrice.FUEL_TYPES).includes(b.fuel_type) ? b.fuel_type : 'euro95',
      fuel_markup_eur_l: Math.max(-1, Math.min(2, num(b.fuel_markup_eur_l, 0))),
    });
    if (b.fuel_auto) fuelPrice.refreshFuelPrice().catch(() => {});
  } else return false;
  return true;
}

module.exports = { SECTIONS, saveShared, num };
