// Wallbox > Driving & costs (driving.js): trips, learned consumption, electric vs. fuel km and costs
// per car, from the car's own odometer and state of charge.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const driving = require('../driving');

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

module.exports = router;
