// What a kWh of your own solar is worth when the car (or an appliance) uses it instead of exporting it.
// One place for Smart charging, the energy manager and the cost overviews.
//
// - 'saldering' (Dutch net metering): until the end of 2026 an exported kWh is netted against one you
//   take from the grid, so it is worth the all-in price of that moment. Net metering ends on 1 January
//   2027 (Wet herziening salderingsregeling); from then on an exported kWh only earns a feed-in fee from
//   the supplier, so it is worth the bare market price of that moment (without energy tax and VAT).
// - 'market': no net metering (already now): the bare market price of that moment.
// - 'fixed': a fixed feed-in tariff (feedInEur).
//
// On top of that, "prefer own solar" (bonus, €/kWh): own solar counts this much cheaper than what
// exporting it yields — e.g. the supplier's feed-in costs, or simply a preference for using your own
// solar. Pure functions, no database.

// 1 January 2027 00:00 in the Netherlands (CET = UTC+1).
const NET_METERING_ENDS_MS = Date.UTC(2026, 11, 31, 23);
const MODES = ['saldering', 'market', 'fixed'];

const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// The bare market price back from an all-in price (all-in = (market + markup) x VAT + energy tax), for
// a price source without market prices (a fixed contract, Loxone only).
function marketFromAllin(allin, priceCfg = {}) {
  const p = num(allin);
  if (p === null) return null;
  const vat = 1 + (num(priceCfg.vat_pct) ?? 21) / 100;
  return Math.round(((p - (num(priceCfg.energy_tax_eur_kwh) ?? 0.10)) / vat - (num(priceCfg.markup_eur_kwh) ?? 0.02)) * 10000) / 10000;
}

// Which rule applies at a moment: net metering turns into the market price on 1 January 2027.
function ruleAt(feedIn, atMs) {
  const mode = MODES.includes(feedIn) ? feedIn : 'saldering';
  return mode === 'saldering' && Number.isFinite(atMs) && atMs >= NET_METERING_ENDS_MS ? 'market' : mode;
}

// € an exported kWh yields at `atMs`. price: all-in €/kWh of that moment; market: bare market €/kWh
// (null = derived from the price). Without any price: the feed-in tariff as a rough stand-in.
function exportWorth({ atMs, price = null, market = null, feedIn = 'saldering', feedInEur = 0.05, priceCfg = {} } = {}) {
  const rule = ruleAt(feedIn, atMs);
  const fixed = num(feedInEur) ?? 0.05;
  if (rule === 'fixed') return fixed;
  const p = num(price);
  if (rule === 'saldering') return p ?? fixed;
  const m = num(market) ?? marketFromAllin(p, priceCfg);
  return m ?? fixed;
}

// What using a kWh of own solar costs in a plan: what exporting it would yield, minus the preference.
// Not below zero because of the preference — but a negative market price stays negative (exporting
// then costs money, so using it yourself is worth even more).
function ownSolarCost(worth, bonus = 0) {
  const w = num(worth) ?? 0;
  const b = Math.max(0, num(bonus) ?? 0);
  return w < 0 ? w : Math.max(0, Math.round((w - b) * 10000) / 10000);
}

// What exporting a kWh really yields under the contract at `atMs`: its worth (exportWorth) minus the
// supplier's feed-in costs. -> { value, worth, rule, cost } — rule: 'saldering' (net metering: the
// all-in price of that moment, so a normal price means export all), 'market' (the market price, a
// dynamic contract after net metering) or 'fixed' (the feed-in tariff).
function exportNet({ atMs, price = null, market = null, feedIn = 'saldering', feedInEur = 0.05, feedInCostEur = 0, priceCfg = {} } = {}) {
  const rule = ruleAt(feedIn, atMs);
  const worth = exportWorth({ atMs, price, market, feedIn, feedInEur, priceCfg });
  const cost = Math.max(0, num(feedInCostEur) ?? 0);
  return { value: worth === null ? null : Math.round((worth - cost) * 10000) / 10000, worth, rule, cost };
}

module.exports = { NET_METERING_ENDS_MS, MODES, marketFromAllin, ruleAt, exportWorth, exportNet, ownSolarCost };
