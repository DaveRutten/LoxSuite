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
  const vehiclesMod = require('../vehicles');
  const vehicles = await db.prepare('SELECT id, name, source_type, source_config FROM vehicles ORDER BY name').all();
  res.render('settings-energy', {
    cfg: { ...(await agenda.getConfig()), ...(await planner.getConfig()) }, // planner wins for the shared default_kwh_per_km
    priceCfg: { ...pcfg, entsoe_token: undefined, hasEntsoeToken: !!pcfg.entsoe_token },
    solarCfg: await solar.getConfig(), site: await solar.getSite(),
    priceStatus: await settings.get('prices_status', null), solarStatus: await settings.get('solar_status', null),
    fuel: await fuelPrice.currentFuelPrice(), fuelTypes: fuelPrice.FUEL_TYPES, spo: await prices.findSpotOptimizer().catch(() => null),
    calendars: await agenda.listCalendars(), vehicles,
    climateRuns: await require('../carClimate').recent(8),
    skodaCars: vehicles.some((v) => vehiclesMod.sourceKind(v) === 'skoda'),
    saved: req.query.saved || null, error: req.query.error || null,
  });
}));

module.exports = router;
