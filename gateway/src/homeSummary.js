// Home: what is happening now, in one look. A greeting with one plain sentence, the energy flowing between
// sun, house, car, grid and battery, four key figures (own solar used, when the car is ready, the heat
// pump, what needs attention) and the day as one bar (solar to spare, when the car charges, when the
// heat pump makes tap water). Pure where it can be (summarize, todayBar), so it is testable without a
// database; build() gathers the inputs.
const HOUR = 3600000;
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const fin = (x) => (x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);

function greetingOf(hour) {
  if (hour < 6) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// Pure: the flow now from the live meters ({ roles, house_kw }) and the heat pump's mode.
//   kW per node; grid > 0 = taking from the grid, < 0 = giving back; battery > 0 = charging it.
function flowOf(meters, { hpMode = null, carSoc = null } = {}) {
  if (!meters) return null;
  const R = meters.roles || {};
  const pv = fin(R.pv?.power_kw);
  const grid = fin(R.grid?.power_kw);
  const car = fin(R.wallbox?.power_kw);
  const battery = fin(R.battery?.power_kw);
  const house = fin(meters.house_kw);
  if (pv === null && grid === null && house === null) return null;
  return { pv: pv === null ? null : Math.max(0, pv), grid, car, battery, house: house === null ? null : Math.max(0, house), hpMode, carSoc };
}

// Pure: one plain sentence about now, as [text, params] for t().
function sentenceOf(flow, { carCharging = false } = {}) {
  if (!flow) return null;
  const pv = flow.pv || 0, use = (flow.house || 0) + (flow.car || 0);
  const back = flow.grid !== null && flow.grid < -0.05;
  if (pv > 0.1 && back && carCharging) return ['The sun gives more than the house uses; the car charges along.', {}];
  if (pv > 0.1 && back) return ['The sun gives more than the house uses: {kw} kW goes back to the grid.', { kw: r1(-flow.grid) }];
  if (pv > 0.1 && use > 0) return ['The sun covers {pct} % of what the house uses now.', { pct: Math.min(100, Math.round((pv / use) * 100)) }];
  if (carCharging) return ['The car is charging from the grid.', {}];
  return ['The house uses {kw} kW from the grid.', { kw: r1(Math.max(0, flow.grid ?? flow.house ?? 0)) }];
}

// Pure: the day as 24 hours from local midnight. Per hour: solar to spare (kWh), the car charging (kWh),
// the heat pump's planned job ('dhw' | 'legionella' | 'preheat' | null). nowPct = where now is (0–100).
function todayBar({ dayStartMs, nowMs, hours = 24, surplus = new Map(), carSlots = [], hpPlan = [] }) {
  const out = [];
  for (let i = 0; i < hours; i++) {
    const ms = dayStartMs + i * HOUR;
    let car = 0;
    for (const s of carSlots) {
      const a = Date.parse(s.start), b = Date.parse(s.end);
      const ov = Math.max(0, Math.min(b, ms + HOUR) - Math.max(a, ms));
      if (ov > 0 && b > a) car += (s.kwh || 0) * (ov / (b - a));
    }
    const hp = hpPlan.find((h) => h.ms === ms);
    const job = hp ? (hp.does === 'legionella' ? 'legionella' : hp.does === 'dhw' ? 'dhw' : hp.does === 'preheat' ? 'preheat' : null) : null;
    out.push({ ms, surplus: Math.max(0, surplus.get(ms) || 0), car: Math.round(car * 100) / 100, hp: job, past: ms + HOUR <= nowMs });
  }
  return { hours: out, nowPct: Math.max(0, Math.min(100, ((nowMs - dayStartMs) / (hours * HOUR)) * 100)) };
}

// Gathers the inputs. `energy` = what the home route already read (meters, price, heatpump, solar, own).
async function build({ energy, attention = [], nowMs = Date.now() }) {
  const { localParts, localMidnight, displayTz } = require('./localTime');
  const tz = displayTz();
  const lp = localParts(nowMs, tz);
  const H = energy?.heatpump || null;
  const planner = (() => { try { return require('./modules').isOn('charging') ? require('./planner').getRuntime() : null; } catch { return null; } })();
  const plan = planner?.plan || null;
  const carCharging = (fin(energy?.meters?.roles?.wallbox?.power_kw) || 0) > 0.3;
  // the live meters; without a grid meter the solar module's own readings (solar and house now)
  let flow = flowOf(energy?.meters, { hpMode: H?.state?.mode || null });
  const S = energy?.solar;
  if (!flow && S && (fin(S.pvKw) !== null || fin(S.houseKw) !== null)) {
    const pv = Math.max(0, fin(S.pvKw) || 0), house = Math.max(0, fin(S.houseKw) || 0);
    flow = { pv, house, grid: Math.round((house - pv) * 1000) / 1000, car: null, battery: null, hpMode: H?.state?.mode || null, carSoc: null };
  }
  const dayStartMs = localMidnight(nowMs, tz);
  // solar to spare per hour: the planner's slots (they hold the expected surplus), else the forecast
  const surplus = new Map();
  for (const s of plan?.slotsAll || []) {
    const h = Math.floor(Date.parse(s.start) / HOUR) * HOUR;
    const kwh = (fin(s.pvKw) || fin(s.surplusKw) || 0) * ((Date.parse(s.end) - Date.parse(s.start)) / HOUR);
    surplus.set(h, (surplus.get(h) || 0) + kwh);
  }
  for (const h of H?.plan || []) if (!surplus.has(h.ms) && Number.isFinite(h.surplusKwh)) surplus.set(h.ms, h.surplusKwh);
  if (!surplus.size) {
    const fc = await require('./solarForecast').forecastBetween(new Date(dayStartMs).toISOString(), new Date(dayStartMs + 24 * HOUR).toISOString()).catch(() => new Map());
    for (const [iso, kwh] of fc) surplus.set(Date.parse(iso), kwh);
  }
  const today = todayBar({ dayStartMs, nowMs, surplus, carSlots: plan?.slots || [], hpPlan: H?.plan || [] });
  const kpis = [];
  const own = energy?.own;
  const trend = own && Number.isFinite(own.selfRate) && Number.isFinite(own.prevSelfRate) ? Math.round((own.selfRate - own.prevSelfRate) * 100) : null;
  if (own && own.selfRate !== null && own.selfRate !== undefined) kpis.push({ key: 'own', label: 'Own solar used · 30 days', value: `${Math.round(own.selfRate * 100)} %`, trend: trend === null ? null : { pts: trend, text: trend === 0 ? ['same as the 30 days before', {}] : [trend > 0 ? '▲ {n} points more than the 30 days before' : '▼ {n} points less than the 30 days before', { n: Math.abs(trend) }] }, sub: own.autarky !== null && own.autarky !== undefined ? ['{pct} % of what you use comes from your panels', { pct: Math.round(own.autarky * 100) }] : null, href: '/energy/own' });
  if (plan && plan.readyAt) kpis.push({ key: 'car', label: 'Car ready at', value: new Date(plan.readyAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: tz }), sub: Number.isFinite(plan.cost) && plan.kwh > 0 ? ['{kwh} kWh · € {eur}', { kwh: r1(plan.kwh), eur: plan.cost.toFixed(2).replace('.', ',') }] : ['nothing to charge', {}], href: '/planner' });
  if (H && H.state) {
    const modeLabel = { dhw: 'Tap water', heating: 'Heating', defrost: 'Defrosting', idle: 'Idle', fault: 'Fault' }[H.state.mode] || 'Idle';
    kpis.push({ key: 'hp', label: 'Heat pump', value: modeLabel, sub: Number.isFinite(H.state.tankC) ? ['tank {c} °C', { c: r1(H.state.tankC) }] : null, href: '/energy-manager/modules/heatpump' });
  }
  const att = (attention || []).length;
  kpis.push({ key: 'attention', label: 'Attention', value: att ? String(att) : '✓', sub: att ? [attention[0].title, {}] : ['nothing needs you', {}], href: '/notifications', warn: att > 0 });
  const P = energy?.price || {};
  return {
    greeting: greetingOf(lp.hour), dayMs: nowMs,
    sentence: sentenceOf(flow, { carCharging }), flow, kpis, today,
    price: { now: fin(P.now), min: fin(P.min), minAt: P.minAt || null },
  };
}

module.exports = { build, flowOf, sentenceOf, todayBar, greetingOf };
