// Settings → Energy & charging: the settings shared by the energy pages — electricity price, home &
// solar forecast, fuel — and the calendars + agenda settings (car markers, margin, climate at
// departure). The forms post to the existing endpoints (/planner/settings, /agenda/...), which come
// back here.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const prices = require('../prices');
const solar = require('../solarForecast');
const settings = require('../wallboxSettings');
const fuelPrice = require('../fuelPrice');
const planner = require('../planner');
const agenda = require('../agenda');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const pcfg = await prices.getConfig();
  const agendaCfg = await agenda.getConfig();
  const plannerCfg = await planner.getConfig();
  const vehiclesMod = require('../vehicles');
  const vehicles = await db.prepare('SELECT id, name, source_type, source_config FROM vehicles ORDER BY name').all();
  res.render('settings-energy', {
    cfg: energyCfg(agendaCfg, plannerCfg),
    priceCfg: { ...pcfg, entsoe_token: undefined, hasEntsoeToken: !!pcfg.entsoe_token },
    solarCfg: await solar.getConfig(), site: await solar.getSite(),
    priceStatus: await settings.get('prices_status', null), solarStatus: await settings.get('solar_status', null),
    fuel: await fuelPrice.currentFuelPrice(), fuelTypes: fuelPrice.FUEL_TYPES, spo: await prices.findSpotOptimizer().catch(() => null),
    calendars: await agenda.listCalendars(), vehicles,
    climateRuns: await require('../carClimate').recent(8),
    skodaCars: vehicles.some((v) => vehiclesMod.sourceKind(v) === 'skoda'),
    dayCfg: await require('../dayType').getConfig(),
    dayTypes: [...(await require('../dayType').typesBetween(Date.now(), Date.now() + 14 * 86400000).catch(() => new Map()))].map(([day, v]) => ({ day, ...v })),
    miniservers: await db.prepare('SELECT id, name FROM miniservers ORDER BY sort_order, id').all().catch(() => []),
    saved: req.query.saved || null, error: req.query.error || null,
  });
}));

// Days away & holidays (dayType.js).
router.post('/day-types', require('../middleware/requirePermission').requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const uuid = String(b.presence_uuid || '').trim();
  await require('../dayType').saveConfig({
    away_words: String(b.away_words || '').slice(0, 400), home_words: String(b.home_words || '').slice(0, 400),
    away_from: date(b.away_from), away_to: date(b.away_to), holidays: !!b.holidays,
    presence_ms: Number(b.presence_ms) || null, presence_uuid: /^[0-9a-f-]{20,}$/i.test(uuid) ? uuid : '', presence_home_value: String(b.presence_home_value ?? '1').slice(0, 20) || '1',
  });
  for (const m of ['../planner', '../energyManager']) { try { const x = require(m); if (x.invalidate) x.invalidate(); } catch { /* not loaded */ } }
  res.redirect('/settings/energy?saved=1#day-types');
}));

// States of a Miniserver for the presence picker.
router.get('/states/:miniserverId', asyncHandler(async (req, res) => {
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(Number(req.params.miniserverId));
  if (!ms) return res.status(404).json({ error: 'Miniserver not found' });
  try { res.json({ states: await require('../loxoneStructure').getMonitorableStates(ms) }); } catch (err) { res.status(502).json({ error: err.message }); }
}));

module.exports = router;

// Pure: the settings shown on the page. Smart charging wins for the shared default_kwh_per_km; the
// agenda for its own ready_margin_min (Smart charging's unused default of 15 used to show here, so a
// saved 0 looked as if it couldn't be saved).
function energyCfg(agendaCfg = {}, plannerCfg = {}) {
  return { ...agendaCfg, ...plannerCfg, ready_margin_min: agendaCfg.ready_margin_min };
}
router.energyCfg = energyCfg;
