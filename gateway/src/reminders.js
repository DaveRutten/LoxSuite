// Car reminders (notification triggers car_reminder and charging_plan), checked every 5 minutes:
//
//   - "Plug in": the car is home but not plugged in, it will be needed within the next ~20 hours
//     and charging before then is worth it. For a plug-in hybrid "worth it" means the saving against
//     driving on fuel is above your threshold (fuel price x consumption vs. the cheapest electricity
//     before departure); for a full-electric car it means the next trip wouldn't fit otherwise.
//     Push buttons: "Remind me at 22:00" and "Not today". When reminders for a weekday keep being
//     ignored, the threshold for that weekday goes up.
//   - "Swap": two cars, one charging point — when the plugged-in car is done in time for the other
//     to still get what it needs.
//   - Plan warnings: an agenda trip needs more than the battery holds (hybrid: the rest is fuel;
//     electric: plan a charging stop), or the plan can't make it before the deadline.
const db = require('./db');
const settings = require('./wallboxSettings');

const DEFAULTS = { enabled: true, threshold_eur: 1.0, evening_from: '17:30', quiet_from: '22:30', quiet_until: '07:00', snooze_to: '22:00' };

const round2 = (x) => Math.round(x * 100) / 100;

function inQuiet(min, from, until) {
  return from > until ? (min >= from || min < until) : (min >= from && min < until);
}

// Pure: should we remind to plug in? Returns { remind, saving, reason } (saving in €; null for BEV).
function plugDecision({ type, deficitKwh, tripNeedKwh, usableKwh, reserveKwh = 0, avgPrice, breakEven, thresholdEur }) {
  if (!(deficitKwh > 0.5)) return { remind: false, reason: 'battery (almost) full' };
  if (type === 'phev') {
    if (breakEven === null || avgPrice === null) return { remind: false, reason: 'no price comparison possible' };
    const useful = Math.min(deficitKwh, tripNeedKwh ?? deficitKwh);
    const saving = round2(useful * (breakEven - avgPrice));
    return saving >= thresholdEur ? { remind: true, saving, useful: round2(useful), reason: `saves € ${saving.toFixed(2)} on fuel` } : { remind: false, saving, reason: `saving € ${saving.toFixed(2)} below the threshold` };
  }
  const left = (usableKwh ?? 0) - deficitKwh;
  const need = (tripNeedKwh ?? 0) + reserveKwh;
  if (left < need) return { remind: true, saving: null, useful: round2(need - left), reason: `the next trip needs about ${need.toFixed(1)} kWh, about ${Math.max(0, left).toFixed(1)} kWh is left` };
  return { remind: false, reason: 'enough for the next trip' };
}

async function getConfig() { return settings.get('reminders', DEFAULTS); }

async function check(nowMs = Date.now()) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  const planner = require('./planner');
  const learning = require('./learning');
  const notifications = require('./notifications');
  const prices = require('./prices');
  const { localParts, localMidnight, localTimeOn, hhmm, displayTz } = require('./localTime');
  const tz = displayTz();
  const p = localParts(nowMs, tz);
  const minNow = p.hour * 60 + p.minute;
  const toMin = (s) => learning.toMin(s);
  const state = await settings.get('reminder_state', { snoozeUntil: null, skipUntil: null, ignored: {}, pending: null });
  const out = [];

  const vehicles = await db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id').all();
  const wb = await planner.wallboxLive().catch(() => null);
  const pcfg = await planner.getConfig();
  // A reminder that was answered by plugging in: forget the ignore count for that weekday.
  if (state.pending && wb?.connected) {
    state.ignored[state.pending.weekday] = 0;
    state.pending = null;
  } else if (state.pending && nowMs > state.pending.readyAt) {
    state.ignored[state.pending.weekday] = (state.ignored[state.pending.weekday] || 0) + 1;
    state.pending = null;
  }

  for (const v of vehicles) {
    const st = require('./vehicles').getVehicleStatus(v);
    const r = st.reading || {};
    const plugged = !!wb?.connected && (vehicles.length === 1 || r.plugged === true);
    if (plugged) continue;
    const usable = v.battery_kwh ? v.battery_kwh * ((v.charge_limit_pct || 100) / 100) : null;
    // Next time it must be ready (agenda first, else the learned weekday pattern).
    let ready = null;
    let label = '';
    let tripNeed = null;
    try {
      const trip = await require('./agenda').nextCarTrip(nowMs, v);
      if (trip) { ready = trip.readyAt; label = trip.title; tripNeed = trip.needKwh; }
    } catch { /* no agenda */ }
    const deps = await learning.learnedDepartures(v.id);
    const nx = learning.nextReadyTime(deps, nowMs, { tz });
    if (nx && (!ready || nx.at < ready)) { ready = nx.at; label = `${nx.weekday} ${hhmm(nx.at, tz)}`; tripNeed = null; }
    if (!ready || ready - nowMs > 20 * 3600000) continue;
    // Is the car at home? From its data source, else: evening and after its usual arrival.
    let home = r.home ?? null;
    if (home === null) {
      const today = deps[p.weekday];
      const arrival = today?.arrival ? toMin(today.arrival) + 30 : toMin(cfg.evening_from);
      home = minNow >= Math.max(arrival, toMin(cfg.evening_from));
    }
    if (!home) continue;
    // How empty is it, and what will the next trip use?
    let deficit;
    if (r.soc !== null && r.soc !== undefined && v.battery_kwh) deficit = v.battery_kwh * ((r.limit_soc ?? v.charge_limit_pct ?? 100) - r.soc) / 100;
    else {
      const sessions = await learning.loadSessions(30, v.id);
      const last = sessions.filter((s) => s.disconnect).pop();
      const trips = await learning.learnedTrips(v);
      const exp = last ? learning.expectedTripKwh(trips, last.disconnect, (nowMs - last.disconnect) / 3600000, { tz, safe: false }) : null;
      deficit = Math.min(usable ?? Infinity, exp?.kwh ?? 0);
    }
    if (tripNeed === null) {
      const trips = await learning.learnedTrips(v);
      tripNeed = learning.expectedTripKwh(trips, ready, 8, { tz })?.kwh ?? null;
    }
    // Cheapest electricity between now and the deadline for that amount.
    const slots = await planner.buildSlots(nowMs, ready);
    const plan = planner.makePlan({ nowMs, readyAtMs: ready, needKwh: deficit, slots, mode: 'plan', minKw: pcfg.min_kw, maxKw: pcfg.max_kw, solarTrust: 'low' });
    const fuel = await require('./fuelPrice').currentFuelPrice();
    const breakEven = planner.fuelBreakEven({ fuelEurL: fuel.eur_l, lPer100km: v.fuel_l_per_100km || 6.5, kwhPerKm: require('./driving').effectiveKwhPerKm(v, pcfg.default_kwh_per_km) });
    const weekdayKey = require('./localTime').WEEKDAYS[localParts(ready, tz).weekday];
    const factor = 1 + Math.min(4, state.ignored[weekdayKey] || 0) * 0.5;
    const dec = plugDecision({
      type: v.type, deficitKwh: deficit, tripNeedKwh: tripNeed, usableKwh: usable, reserveKwh: usable ? usable * (v.reserve_pct || 0) / 100 : 0,
      avgPrice: plan.avgPrice, breakEven, thresholdEur: (Number(cfg.threshold_eur) || 0) * factor,
    });
    out.push({ vehicle: v.name, ready: new Date(ready).toISOString(), deficit, ...dec });
    if (!dec.remind) continue;
    if (inQuiet(minNow, toMin(cfg.quiet_from), toMin(cfg.quiet_until))) continue;
    if (state.snoozeUntil && nowMs < state.snoozeUntil) continue;
    if (state.skipUntil && nowMs < state.skipUntil) continue;
    const slotTxt = plan.slots.length ? `It charges ${hhmm(Date.parse(plan.slots[0].start), tz)}–${hhmm(Date.parse(plan.slots[plan.slots.length - 1].end), tz)}${plan.avgPrice ? ` at about € ${plan.avgPrice.toFixed(2)}/kWh` : ''}.` : '';
    await notifications.fireCarEvent('car_reminder', `plug|${v.id}|${new Date(ready).toISOString()}|${state.snoozeUntil || ''}`, {
      title: `${v.name} not plugged in`,
      message: `Needed ${label} (±${(tripNeed ?? deficit).toFixed(1)} kWh). ${dec.saving !== null && dec.saving !== undefined ? `Plugging in now saves about € ${dec.saving.toFixed(2)} compared to fuel. ` : `${dec.reason[0].toUpperCase()}${dec.reason.slice(1)}. `}${slotTxt}`,
      fields: [{ label: 'Vehicle', value: v.name }, { label: 'Ready by', value: hhmm(ready, tz) }],
      vehicleId: v.id, url: '/planner', tag: `plug-${v.id}`,
      actions: [{ action: 'snooze', title: `Remind me at ${cfg.snooze_to}` }, { action: 'skip', title: 'Not today' }],
      data: { kind: 'plug', vehicleId: v.id },
    });
    state.pending = { weekday: weekdayKey, readyAt: ready };
  }

  // Two cars, one charging point: tell when to swap.
  if (vehicles.length > 1 && wb?.connected) {
    const rt = planner.getRuntime();
    const plan = rt.plan;
    const lastSlot = plan?.slots?.[plan.slots.length - 1];
    if (plan && lastSlot) {
      const doneAt = Date.parse(lastSlot.end);
      const current = plan.target?.vehicle?.id;
      const other = vehicles.find((x) => x.id !== current);
      if (other && doneAt > nowMs) {
        await notifications.fireCarEvent('car_reminder', `swap|${other.id}|${lastSlot.end}`, {
          title: `Swap cars at ${hhmm(doneAt, tz)}`,
          message: `${plan.target?.vehicle?.name || 'The connected car'} is done charging around ${hhmm(doneAt, tz)}; then plug in ${other.name}.`,
          fields: [{ label: 'Done', value: hhmm(doneAt, tz) }], vehicleId: other.id, url: '/planner', tag: 'swap',
        });
      }
    }
  }

  // Plan warnings for the connected car.
  const rt = planner.getRuntime();
  const pl = rt.plan;
  if (pl?.target?.readySource?.startsWith('agenda') && pl.target.usable) {
    try {
      const trip = await require('./agenda').nextCarTrip(nowMs);
      if (trip?.needKwh && trip.needKwh > pl.target.usable) {
        const v = vehicles.find((x) => x.id === pl.target.vehicle?.id) || vehicles[0];
        await notifications.fireCarEvent('charging_plan', `long|${trip.item.uid || trip.item.id}|${trip.item.start}`, {
          title: `${v?.name || 'Car'}: trip longer than the battery`,
          message: `${trip.title} needs about ${trip.needKwh.toFixed(1)} kWh; the battery holds ${pl.target.usable.toFixed(1)} kWh. ${v?.type === 'phev' ? 'It will be full before you leave; the rest is driven on fuel.' : 'Plan a charging stop on the way, or charge at the destination.'}`,
          fields: [{ label: 'Trip', value: trip.title }], vehicleId: v?.id, url: '/agenda', severity: 'warning',
        });
      }
    } catch { /* no agenda */ }
  }
  if (pl && !pl.feasible && wb?.connected && pl.target?.vehicle?.type === 'bev') {
    await notifications.fireCarEvent('charging_plan', `short|${pl.readyAt}`, {
      title: 'Car won\'t be fully ready', message: pl.notes.join(' '), severity: 'warning', url: '/planner',
      fields: [{ label: 'Short', value: `${pl.shortfallKwh.toFixed(1)} kWh` }],
    });
  }
  await settings.set('reminder_state', state);
  return out;
}

// Push buttons. 'snooze' -> remind again at snooze_to today; 'skip' -> quiet until tomorrow 04:00.
async function handleAction(action) {
  if (/^vehicle:\d+$/.test(action)) { require('./planner').setSessionVehicle(action.split(':')[1]); return { vehicle: action.split(':')[1] }; }
  const cfg = await getConfig();
  const { localTimeOn, localMidnight } = require('./localTime');
  const state = await settings.get('reminder_state', { snoozeUntil: null, skipUntil: null, ignored: {}, pending: null });
  const now = Date.now();
  if (action === 'snooze') {
    let t = localTimeOn(now, cfg.snooze_to);
    if (t <= now) t = now + 30 * 60000;
    state.snoozeUntil = t;
  } else if (action === 'skip') {
    state.skipUntil = localMidnight(now, undefined, 1) + 4 * 3600000;
    if (state.pending) { state.ignored[state.pending.weekday] = (state.ignored[state.pending.weekday] || 0) + 1; state.pending = null; }
  }
  await settings.set('reminder_state', state);
  return state;
}

let timer = null;
function startReminders() {
  if (timer) return;
  const run = () => check().catch((err) => console.error(`[reminders] ${err.message}`));
  timer = setInterval(run, 5 * 60 * 1000);
  timer.unref?.();
  setTimeout(run, 90000).unref?.();
}

module.exports = { DEFAULTS, plugDecision, inQuiet, getConfig, check, handleAction, startReminders };
