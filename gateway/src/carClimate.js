// Climate at departure (Wallbox > Agenda). For an appointment or trip where you chose a cabin
// temperature, LoxSuite asks the car to start its air conditioning a set time (default 20 min)
// before you have to leave, so it is warm (or cool) when you get in. Only for cars read through the
// official Škoda API (MyŠkoda key); other sources can't take commands.
//
// Global switch in the agenda settings: 'off', 'log' (default: only write down what it would send,
// nothing goes to the car) or 'on'. Every departure is handled once (climate_runs); a failed send is
// retried at most twice while there is still time. One command = one of the car's 20 API
// requests per hour. A departure can be switched off for that one time (status 'off', e.g. one week
// of a weekly trip); the worker then leaves it alone.
const db = require('./db');

const MAX_ATTEMPTS = 3;
let timer = null;
let running = false;

function clampLead(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(60, Math.max(5, Math.round(n))) : 20;
}

function itemKey(item) {
  return item.kind === 'event' ? `event|${item.calendar_id}|${item.uid}|${item.start}` : `trip|${item.id}|${item.start}`;
}

// Pure: is it time for this departure? window = [leave - lead, leave)
function due(item, nowMs, leadMin) {
  if (item.climateC === null || item.climateC === undefined || !item.needsCar || !item.leaveAt) return false;
  const leave = Date.parse(item.leaveAt);
  return nowMs >= leave - leadMin * 60000 && nowMs < leave;
}

// Pure: does the car's list of operations (when the API gave one) allow starting the climate?
function canClimate(operations) {
  if (!operations || !operations.length) return true; // not told: try it, the API answers clearly
  return operations.some((o) => /air.?condition|climat/i.test(String(o)) && !/stop/i.test(String(o)));
}

function hhmm(ms) {
  const { localParts } = require('./localTime');
  const p = localParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

async function save(row) {
  await db.upsert('climate_runs', { ...row, updated_at: new Date().toISOString() }, ['item_key']);
}

async function notify(row, vehicleName) {
  const sev = row.status === 'failed' ? 'warning' : 'info';
  const titles = { sent: 'Climate started', logged: 'Climate (log only)', failed: 'Climate could not be started', skipped: 'Climate skipped' };
  await require('./notifications').fireCarEvent('car_climate', `${row.item_key}|${row.status}`, {
    title: `${vehicleName || 'Car'}: ${titles[row.status] || row.status}`,
    message: row.message, severity: sev, vehicleId: row.vehicle_id, url: '/agenda', tag: 'climate',
    fields: [{ label: 'Vehicle', value: vehicleName || '—' }, { label: 'Trip', value: row.title || '—' }, { label: 'Temperature', value: `${row.target_c} °C` }],
  }).catch(() => {});
}

// One pass. `deps.command(vehicle, body)` replaces the real API call in tests.
async function tick(nowMs = Date.now(), deps = {}) {
  const agenda = require('./agenda');
  const vehicles = require('./vehicles');
  const cfg = await agenda.getConfig();
  const mode = ['off', 'log', 'on'].includes(cfg.climate_mode) ? cfg.climate_mode : 'log';
  if (mode === 'off') return [];
  const lead = clampLead(cfg.climate_lead_min);
  const list = await agenda.items(new Date(nowMs - 6 * 3600000).toISOString(), new Date(nowMs + (lead + 180) * 60000).toISOString());
  const done = [];
  // Each drive from home: an appointment can have two (drop off at the start, pick up at the end) or
  // none of its own (driving on from the one before: the route left home earlier).
  const departures = [];
  for (const it of list) {
    const deps = Array.isArray(it.departures) ? it.departures : [{ leaveAt: it.leaveAt, n: 0 }];
    for (const d of deps) departures.push({ item: { ...it, leaveAt: d.leaveAt }, key: d.n ? `${itemKey(it)}|${d.n}` : itemKey(it) });
  }
  for (const { item, key } of departures) {
    if (!due(item, nowMs, lead)) continue;
    const prev = await db.prepare('SELECT * FROM climate_runs WHERE item_key = ?').get(key);
    // handled already, or switched off for this time ('off')
    if (prev && (prev.status !== 'retry' || (prev.next_at && Date.parse(prev.next_at) > nowMs))) continue;
    const vehicle = item.vehicle_id
      ? await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(item.vehicle_id)
      : await db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id LIMIT 1').get();
    const leaveAt = Date.parse(item.leaveAt);
    const row = {
      item_key: key, vehicle_id: vehicle?.id || null, title: item.title, depart_at: item.leaveAt, target_c: item.climateC,
      attempts: (prev?.attempts || 0), next_at: null, created_at: prev?.created_at || new Date(nowMs).toISOString(),
    };
    if (!vehicle || vehicles.sourceKind(vehicle) !== 'skoda') {
      Object.assign(row, { status: 'skipped', message: `"${item.title}": climate needs a car with the Škoda API as data source.` });
    } else if (!canClimate(vehicles.getVehicleStatus(vehicle).extra?.operations)) {
      Object.assign(row, { status: 'skipped', message: `"${item.title}": this car or API key does not allow starting the air conditioning.` });
    } else if (mode === 'log') {
      Object.assign(row, { status: 'logged', message: `Would start the air conditioning at ${item.climateC} °C for "${item.title}" (leave ${hhmm(leaveAt)}). Switch "Climate at departure" on in the agenda settings to send it.` });
    } else {
      row.attempts += 1;
      const body = { targetTemperature: { value: item.climateC, unit: 'CELSIUS' }, airConditioningWithoutExternalPower: !!cfg.climate_on_battery };
      try {
        if (deps.command) await deps.command(vehicle, body);
        else { await vehicles.skodaSpend(vehicle.id); await vehicles.skodaCommand(vehicles.parseConfig(vehicle), vehicles.secretOf(vehicle), 'air-conditioning/start', body); }
        Object.assign(row, { status: 'sent', message: `Air conditioning started at ${item.climateC} °C for "${item.title}" (leave ${hhmm(leaveAt)}).` });
      } catch (err) {
        const waitS = Math.max(180, Number(err.retryAfterS) || 0);
        const retry = row.attempts < MAX_ATTEMPTS && nowMs + waitS * 1000 < leaveAt - 5 * 60000;
        Object.assign(row, {
          status: retry ? 'retry' : 'failed', next_at: retry ? new Date(nowMs + waitS * 1000).toISOString() : null,
          message: `"${item.title}": ${err.message}${retry ? ` — trying again at ${hhmm(nowMs + waitS * 1000)}.` : ''}`,
        });
      }
    }
    await save(row);
    if (row.status !== 'retry') await notify(row, vehicle?.name);
    done.push(row);
  }
  return done;
}

async function recent(limit = 8) {
  return db.prepare('SELECT * FROM climate_runs ORDER BY depart_at DESC LIMIT ?').all(limit);
}

function start() {
  if (timer) return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch { /* next minute */ } finally { running = false; }
  };
  timer = setInterval(run, 60 * 1000);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { tick, due, canClimate, clampLead, itemKey, recent, start, stop, MAX_ATTEMPTS };
