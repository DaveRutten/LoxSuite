// Wallbox > Planner (planner.js): mode, live status, the plan for the connected car, and all
// settings of smart charging (charger, output to Loxone, prices, solar, fuel, reminders).
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const planner = require('../planner');
const prices = require('../prices');
const solar = require('../solarForecast');
const settings = require('../wallboxSettings');
const reminders = require('../reminders');
const fuelPrice = require('../fuelPrice');
const { logSystemEvent } = require('../auditLog');

const router = express.Router();

const num = (v, def = null) => {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
};

router.get('/', asyncHandler(async (req, res) => {
  const pcfg = await prices.getConfig();
  const miniservers = await require('../db').prepare('SELECT id, name FROM miniservers ORDER BY id').all().catch(() => []);
  res.render('planner', {
    miniservers,
    cfg: await planner.getConfig(), priceCfg: { ...pcfg, entsoe_token: undefined, hasEntsoeToken: !!pcfg.entsoe_token },
    solarCfg: await solar.getConfig(), site: await solar.getSite(), remCfg: await reminders.getConfig(),
    priceStatus: await settings.get('prices_status', null), solarStatus: await settings.get('solar_status', null),
    fuel: await fuelPrice.currentFuelPrice(), fuelTypes: fuelPrice.FUEL_TYPES, spo: await prices.findSpotOptimizer().catch(() => null),
    saved: req.query.saved || null, error: req.query.error || null,
  });
}));

router.get('/status.json', asyncHandler(async (req, res) => {
  const rt = planner.getRuntime();
  if (!rt.status) await planner.tick().catch(() => {});
  const r = planner.getRuntime();
  const plan = r.plan ? { ...r.plan } : null;
  res.json({ status: r.status, plan, override: r.override, readyOverride: r.readyOverride, readyOverrideOwn: r.readyOverrideOwn, readyOverrideAway: r.readyOverrideAway, cfg: await planner.getConfig() });
}));

// JSON actions from the page (CSRF-exempt like the other JSON endpoints).
router.post('/mode.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!planner.MODES.includes(mode)) return res.json({ ok: false, message: 'Unknown mode.' });
  await planner.saveConfig({ mode });
  planner.setOverride(null);
  await planner.recalc().catch(() => {});
  await planner.tick().catch(() => {});
  res.json({ ok: true });
}));

// Session buttons: "Charge now", "Pause", back to "Smart" (null).
router.post('/override.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const m = req.body?.mode;
  planner.setOverride(m === 'now' || m === 'off' ? m : null);
  await planner.recalc().catch(() => {});
  await planner.tick().catch(() => {});
  res.json({ ok: true });
}));

router.post('/ready.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const t = req.body?.at ? Date.parse(req.body.at) : null;
  let own = String(req.body?.own || '').trim();
  if (/^\d+([.,]\d+)?$/.test(own)) own += ' km'; // a plain number = km
  planner.setReadyOverride(Number.isFinite(t) ? t : null, own || null);
  await planner.recalc().catch(() => {});
  res.json({ ok: true });
}));

router.post('/recalc.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const out = {};
  if (req.body?.prices) out.prices = await prices.refreshPrices().then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, message: e.message }));
  if (req.body?.solar) out.solar = await solar.refreshForecast().then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, message: e.message }));
  if (req.body?.fuel) out.fuel = await fuelPrice.refreshFuelPrice().then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, message: e.message }));
  await planner.recalc().catch((e) => { out.plan = { ok: false, message: e.message }; });
  res.json({ ok: true, ...out });
}));

// Write a test value to the configured virtual input(s) — only when asked, never automatically.
router.post('/test-output.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const cfg = await planner.getConfig();
  if (!cfg.vi_setpoint) return res.json({ ok: false, message: 'Fill in the virtual input name first.' });
  const { sendHttpVirtualInput } = require('../loxone');
  const ms = await planner.outputMiniserver(cfg);
  if (!ms) return res.json({ ok: false, message: 'No Miniserver configured.' });
  const kw = num(req.body?.kw, 0);
  try {
    await sendHttpVirtualInput(ms, cfg.vi_setpoint, String(kw));
    if (cfg.vi_enable) await sendHttpVirtualInput(ms, cfg.vi_enable, kw > 0 ? '1' : '0');
    await logSystemEvent(`Planner: test value ${kw} kW written to "${cfg.vi_setpoint}" by ${req.session?.username || 'unknown user'}`).catch(() => {});
    await require('../chargeLog').recordSent({ kw, enable: cfg.vi_enable ? (kw > 0 ? 1 : 0) : null, source: 'test', miniserver: ms.name }).catch(() => {});
    res.json({ ok: true, message: `Sent ${kw} to "${cfg.vi_setpoint}"${cfg.vi_enable ? ` and ${kw > 0 ? 1 : 0} to "${cfg.vi_enable}"` : ''} on ${ms.name}.` });
  } catch (err) {
    await require('../chargeLog').recordSent({ kw, source: 'test', ok: false, error: err.message }).catch(() => {});
    res.json({ ok: false, message: err.message });
  }
}));

// Charge log (chargeLog.js): every session recorded with automatic checks, for testing the Wallbox
// control at any moment and looking at it later.
router.get('/log', asyncHandler(async (req, res) => {
  res.render('planner-log', { sessionKey: String(req.query.session || '') });
}));
router.get('/log/sessions.json', asyncHandler(async (req, res) => {
  const chargeLog = require('../chargeLog');
  res.json({ sessions: await chargeLog.sessions(), idle: await chargeLog.idleEvents(30) });
}));
router.get('/log/session.json', asyncHandler(async (req, res) => {
  const d = await require('../chargeLog').sessionDetail(String(req.query.key || ''));
  if (!d) return res.status(404).json({ error: 'Session not found.' });
  res.json(d);
}));
router.get('/log/session.csv', asyncHandler(async (req, res) => {
  const d = await require('../chargeLog').sessionDetail(String(req.query.key || ''));
  if (!d) return res.status(404).send('Session not found.');
  const cols = ['connected', 'enabled', 'active', 'kw', 'limit', 'mode', 'sessionKwh', 'sentKw', 'sentEnable', 'sentSource', 'advisedKw', 'reason', 'output', 'car', 'soc', 'plugged', 'charging', 'carState'];
  const esc = (v) => (v === null || v === undefined ? '' : /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [['time', 'event', ...cols].join(',')].concat(d.rows.map((r) => [new Date(r.t).toISOString(), r.event, ...cols.map((c) => r.d[c])].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="loxsuite-charge-log-${new Date(d.from).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv"`);
  res.send(lines.join('\n'));
}));

router.post('/settings', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const b = req.body;
  const section = b.section;
  if (section === 'charging') {
    await planner.saveConfig({
      min_kw: num(b.min_kw, 4.16), max_kw: num(b.max_kw, 11), grid_limit_kw: num(b.grid_limit_kw, 17.3),
      output: b.output === 'live' ? 'live' : 'advise', vi_setpoint: String(b.vi_setpoint || '').trim(), vi_enable: String(b.vi_enable || '').trim(), vi_miniserver_id: num(b.vi_miniserver_id) || null,
      pv_start_kw: num(b.pv_start_kw), pv_start_delay_s: num(b.pv_start_delay_s, 120), pv_stop_delay_s: num(b.pv_stop_delay_s, 300),
      pv_allowed_import_kw: num(b.pv_allowed_import_kw, 0.5), pv_opportunistic: !!b.pv_opportunistic,
      solar_trust: ['low', 'expected', 'bonus'].includes(b.solar_trust) ? b.solar_trust : 'low',
      max_price_eur_kwh: num(b.max_price_eur_kwh), insufficient: b.insufficient === 'stop' ? 'stop' : 'charge',
      feed_in: b.feed_in === 'fixed' ? 'fixed' : 'saldering', feed_in_eur_kwh: num(b.feed_in_eur_kwh, 0.05),
      target_policy: b.target_policy === 'needed' ? 'needed' : 'full',
      full_hold: b.full_hold === 'off' ? 'off' : 'release', min_topup_kwh: Math.max(0, num(b.min_topup_kwh, 1)),
    });
    const cfg = await planner.getConfig();
    if (cfg.output === 'live') await logSystemEvent(`Planner output set to Live (virtual input "${cfg.vi_setpoint}") by ${req.session?.username || 'unknown user'}`).catch(() => {});
  } else if (section === 'prices') {
    await prices.saveConfig({
      source: ['energyzero', 'entsoe', 'loxone', 'fixed'].includes(b.source) ? b.source : 'energyzero',
      entsoe_token: String(b.entsoe_token || ''), markup_eur_kwh: num(b.markup_eur_kwh, 0), energy_tax_eur_kwh: num(b.energy_tax_eur_kwh, 0),
      vat_pct: num(b.vat_pct, 21), fixed_eur_kwh: num(b.fixed_eur_kwh, 0.3), calibrate_loxone: !!b.calibrate_loxone,
      fixed_low_eur_kwh: num(b.fixed_low_eur_kwh, null),
      fixed_low_from: /^\d{1,2}:\d{2}$/.test(String(b.fixed_low_from || '').trim()) ? String(b.fixed_low_from).trim() : '23:00',
      fixed_low_until: /^\d{1,2}:\d{2}$/.test(String(b.fixed_low_until || '').trim()) ? String(b.fixed_low_until).trim() : '07:00',
      fixed_low_weekend: !!b.fixed_low_weekend,
      price_interval: b.price_interval === 'quarter' ? 'quarter' : 'hour',
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
  } else if (section === 'reminders') {
    await settings.patch('reminders', {
      enabled: !!b.enabled, threshold_eur: num(b.threshold_eur, 1), evening_from: String(b.evening_from || '17:30'),
      quiet_from: String(b.quiet_from || '22:30'), quiet_until: String(b.quiet_until || '07:00'), snooze_to: String(b.snooze_to || '22:00'),
    }, reminders.DEFAULTS);
  }
  await planner.recalc().catch(() => {});
  if (['prices', 'solar', 'fuel'].includes(section)) return res.redirect(`/settings/energy?saved=${encodeURIComponent(section)}#prices`);
  res.redirect(`/planner?saved=${encodeURIComponent(section || '1')}#settings`);
}));

module.exports = router;
