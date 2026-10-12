// Wallbox > Driving & costs (driving.js): trips, learned consumption, electric vs. fuel km and costs
// per car, from the car's own odometer and state of charge.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const driving = require('../driving');
const ext = require('../externalCharging');
const { requirePermission } = require('../middleware/requirePermission');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = express.Router();

async function carList() {
  return db.prepare('SELECT id, name, type FROM vehicles WHERE enabled = 1 ORDER BY id').all().catch(() => []);
}

router.get('/', asyncHandler(async (req, res) => {
  const cars = await carList();
  const id = Number(req.query.vehicle) || cars[0]?.id || null;
  res.render('driving', { cars, vehicleId: id });
}));

router.get('/data.json', asyncHandler(async (req, res) => {
  const cars = await carList();
  const id = Number(req.query.vehicle) || cars[0]?.id;
  const vehicle = id ? await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) : null;
  if (!vehicle) return res.json({ error: 'No vehicle yet — add one under Wallbox > Vehicles.' });
  res.json(await driving.report(vehicle));
}));

// Charging away from home (externalCharging.js): the provider's export (E-Flux: Charging sessions >
// Export, CSV or Excel), a session by hand, removing one.
router.post('/external/import.json', requirePermission('vehicles', 'edit'), upload.single('file'), asyncHandler(async (req, res) => {
  // multipart is not covered by the global CSRF check (see middleware/csrf.js): checked here
  if (!req.body || req.body._csrf !== req.session.csrfToken) return res.status(403).json({ ok: false, message: 'Refresh the page and try again.' });
  if (!req.file) return res.json({ ok: false, message: 'Choose the export file (CSV or Excel).' });
  try {
    const vehicleId = Number(req.body.vehicle) || null;
    res.json(await ext.importFile(req.file.buffer, req.file.originalname, { vehicleId, provider: String(req.body.provider || 'E-Flux').slice(0, 64) }));
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

router.post('/external.json', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  try {
    const b = req.body || {};
    await ext.addManual({ vehicleId: Number(b.vehicle) || null, date: b.date, time: b.time, kwh: b.kwh, costEur: b.cost, provider: b.provider, location: b.location });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

router.post('/external/:id/delete.json', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  await ext.remove(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
