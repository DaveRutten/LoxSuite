// The learning dashboard: everything LoxSuite learns from your own data in one place — per topic what it
// knows, how sure it is (how much data against what it needs) and how accurate its predictions turned out
// (forecastLog.js) — plus a timeline of what changed ("learned just now"), from a daily snapshot.
//
// Texts are English templates with {params}, translated by the page.
const settings = require('./wallboxSettings');

const DAY = 86400000;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fin = (x) => x !== null && x !== undefined && Number.isFinite(Number(x));
// accuracy of an amount forecast: 1 − relative error (0..1), null without data
const accuracyOf = (s) => (s && s.n >= 3 && fin(s.relErr) ? clamp01(1 - s.relErr) : null);

// Pure: one topic. items [{ key, label, value, sub, conf }] — key is what the timeline compares.
function topic(key, title, icon, color, { headline = '', conf = 0, accuracy = null, accuracyNote = '', items = [], link = null, off = false } = {}) {
  return { key, title, icon, color, headline, conf: r2(clamp01(conf)), accuracy: accuracy === null ? null : r2(accuracy), accuracyNote, items, link, off };
}

async function carTopic(learning, acc) {
  const deps = await learning.learnedDepartures(null).catch(() => []);
  const sessions = (await learning.loadSessions(180, null).catch(() => [])).length;
  const usual = deps.filter((d) => d.usual);
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const items = deps.map((d) => ({ key: `car.dep.${d.key}`, label: WD[d.weekday], value: d.usual ? d.departure : null, sub: d.usual ? { t: '{n} times seen', p: { n: d.n } } : { t: 'no usual departure', p: {} }, conf: clamp01(d.n / 8) }));
  const dep = acc?.depart || {};
  return topic('car', 'Car and charging', 'bolt', 'var(--en-car)', {
    headline: usual.length ? { t: '{n} weekdays with a usual departure', p: { n: usual.length } } : { t: 'still learning when the car leaves', p: {} },
    conf: sessions / 40,
    accuracy: dep.n >= 3 && fin(dep.onTime) ? dep.onTime : null,
    accuracyNote: dep.n >= 3 ? { t: 'departure on time {p}% · off by {m} min on average', p: { p: Math.round(dep.onTime * 100), m: dep.maeMin } } : '',
    items, link: '/learned#departures',
  });
}

async function houseTopic(learning, acc) {
  const house = await learning.learnedHouse().catch(() => null);
  const day = (house?.workday || []).reduce((a, b) => a + (b || 0), 0);
  const days = house?.days || house?.n || 0;
  // per day (summed), not per hour: these are day amounts — see forecastLog.summarizeDays
  const pv = acc?.pv?.day, hs = acc?.house?.day;
  const items = [
    { key: 'house.kwhDay', label: 'Usual use per workday', value: day ? { n: r1(day), d: 1, u: 'kWh' } : null, sub: '', conf: clamp01(days / 28) },
    { key: 'house.pvAcc', label: 'Solar forecast', value: accuracyOf(pv) === null ? null : { n: Math.round(accuracyOf(pv) * 100), u: '%' }, sub: pv?.n ? { t: '{n} days compared', p: { n: pv.n } } : { t: 'not compared yet', p: {} }, conf: clamp01((pv?.n || 0) / 14) },
  ];
  return topic('house', 'House and solar', 'house', 'var(--en-house)', {
    headline: day ? { t: 'usually {k} kWh a workday', p: { k: r1(day) } } : { t: 'still learning the house', p: {} },
    conf: days ? days / 28 : (hs?.n || 0) / 14,
    accuracy: accuracyOf(hs) ?? accuracyOf(pv),
    accuracyNote: hs?.n >= 3 ? { t: 'house use per day {p}% right', p: { p: Math.round(accuracyOf(hs) * 100) } } : '',
    items, link: '/learned#house',
  });
}

async function loadsTopic(em, acc) {
  const loads = (await em.listLoads().catch(() => [])).filter((l) => l.enabled);
  const rt = em.getRuntime ? em.getRuntime() : {};
  const items = [];
  let confSum = 0;
  for (const l of loads) {
    const lr = await em.learned(l).catch(() => ({}));
    const pats = ((rt.loads || []).find((x) => x.id === l.id)?.patterns || []).length;
    const conf = clamp01((lr.hours || 0) / (14 * 24));
    confSum += conf;
    const a = (acc?.loads || []).find((x) => x.id === l.id);
    const sb = lr.standby || {};
    items.push({
      key: `load.${l.id}.kwhDay`, label: l.name, value: fin(lr.kwhPerDay) ? { n: r1(lr.kwhPerDay), d: 1, u: 'kWh/d' } : null,
      // several short parts, each translated on its own
      sub: { parts: [pats ? { t: '{n} patterns', p: { n: pats } } : null, sb.learned ? { t: 'standby {w} W', p: { w: Math.round(sb.standbyKw * 1000) } } : null,
        lr.runStats?.runs ? { t: '{r}× a day', p: { r: lr.runStats.perDay } } : null, accuracyOf(a?.day) !== null ? { t: 'forecast {a}% right', p: { a: Math.round(accuracyOf(a.day) * 100) } } : null].filter(Boolean) },
      conf, standbyW: sb.learned ? Math.round(sb.standbyKw * 1000) : null, anomalies: (lr.anomalies || []).length, link: `/energy-manager/loads/${l.id}`,
    });
  }
  const accs = (acc?.loads || []).map((x) => accuracyOf(x.day)).filter((x) => x !== null);
  const anomalies = items.reduce((a, x) => a + (x.anomalies || 0), 0);
  return topic('loads', 'Consumers', 'gauge', 'var(--accent)', {
    headline: loads.length ? { t: anomalies ? '{n} consumers · {a} out of the ordinary' : '{n} consumers', p: { n: loads.length, a: anomalies } } : { t: 'no consumers yet', p: {} },
    conf: loads.length ? confSum / loads.length : 0,
    accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
    accuracyNote: accs.length ? { t: 'use per day, average over {n} consumers', p: { n: accs.length } } : '',
    items, link: '/energy-manager', off: !loads.length,
  });
}

async function heatpumpTopic(mods) {
  const cfg = await mods.getConfig('heatpump').catch(() => ({}));
  if (!cfg.enabled) return topic('heatpump', 'Heat pump', 'heat', '#e67e22', { headline: { t: 'not switched on', p: {} }, off: true, link: '/energy-manager/modules/heatpump' });
  const st = await mods.statusCached('heatpump', 5 * 60000).catch(() => null);
  if (!st || st.error) return topic('heatpump', 'Heat pump', 'heat', '#e67e22', { headline: { t: 'no status yet', p: {} }, link: '/energy-manager/modules/heatpump' });
  const L = st.learned || {};
  const rp = st.room || {};
  const W = st.weather || {};
  const TU = st.tuning || {};
  const RF = st.roomForecast || {};
  const weatherH = Object.values(W.model?.bins || {}).reduce((a, b) => a + (b.hours || 0), 0);
  const items = [
    { key: 'hp.draws', forget: 'tank', label: 'Usual tap-water draws', value: (L.patterns || []).length ? L.patterns.map((p) => `${String(p.from).padStart(2, '0')}:00`).join(' · ') : null, sub: { t: '{d} days of the tank', p: { d: L.days || 0 } }, conf: clamp01((L.days || 0) / 14) },
    { key: 'hp.roomRate', forget: 'room', label: 'Room warms up', value: rp.rate?.rate ? { n: r2(rp.rate.rate), d: 2, u: '°C/h' } : null, sub: rp.rate?.learned ? { t: 'learned at this outdoor temperature', p: {} } : { t: 'start value', p: {} }, conf: rp.rate?.learned ? 0.8 : 0.2 },
    { key: 'hp.roomCool', forget: 'room', label: 'Room cools down', value: fin(RF.cooling?.k) && RF.cooling.k > 0 ? { n: r2(RF.cooling.k * 10), d: 2, u: '°C/h' } : null, sub: RF.cooling?.learned ? { t: 'learned · with 10 °C colder outside', p: {} } : { t: 'start value · with 10 °C colder outside', p: {} }, conf: RF.cooling?.learned ? 0.8 : 0.2 },
    { key: 'hp.schedule', forget: 'room', label: 'Comfort times from Loxone', value: rp.schedule?.all ? `${rp.schedule.all.from}–${rp.schedule.all.until || '…'}` : null, sub: rp.schedule?.comfortC ? { t: '{c} °C comfort, {s} °C otherwise', p: { c: rp.schedule.comfortC, s: rp.schedule.setbackC } } : '', conf: rp.schedule?.all ? 0.8 : 0 },
    { key: 'hp.weather', forget: 'weather', label: 'Defrosting and COP per weather', value: weatherH ? { n: Math.round(weatherH), u: 'h' } : null, sub: W.now?.learned ? { t: 'this weather learned: COP {c}', p: { c: r1(W.now.cop) } } : { t: 'this weather not seen yet', p: {} }, conf: clamp01(weatherH / 300) },
    { key: 'hp.scop', forget: 'weather', label: 'SCOP (measured)', value: W.scop?.scop ? { n: r2(W.scop.scop), d: 2 } : null, sub: W.scop?.days ? { t: 'over {n} days', p: { n: W.scop.days } } : '', conf: clamp01((W.scop?.days || 0) / 365) },
    { key: 'hp.tuning', forget: 'tune', label: 'Best setting for this weather', value: TU.advice?.learned ? (Number.isFinite(TU.advice.setting?.flowC) ? { n: r1(TU.advice.setting.flowC), d: 1, u: '°C' } : '✓') : null, sub: { t: '{n} minutes of runs', p: { n: TU.runs || 0 } }, conf: clamp01((TU.runs || 0) / (30 * 24 * 60)) },
    { key: 'hp.overshoot', forget: 'tune', label: 'Run longer before stopping', value: TU.overshoot?.overshootC ? { n: r1(TU.overshoot.overshootC), d: 1, u: '°C' } : null, sub: Number.isFinite(TU.overshoot?.medianOffMin) ? { t: 'usually starts again after {m} min', p: { m: TU.overshoot.medianOffMin } } : '', conf: TU.overshoot?.overshootC !== undefined ? 0.6 : 0.1 },
  ];
  const conf = items.reduce((a, x) => a + x.conf, 0) / items.length;
  return topic('heatpump', 'Heat pump', 'heat', '#e67e22', {
    headline: W.scop?.scop ? { t: 'SCOP {s} · room {r} °C/h · {n} draws a day', p: { s: r2(W.scop.scop), r: rp.rate?.rate ? r2(rp.rate.rate) : '—', n: (L.patterns || []).length } } : { t: '{n} usual draws a day', p: { n: (L.patterns || []).length } },
    conf, items, link: '/energy-manager/modules/heatpump',
  });
}

async function solarTopic(acc) {
  const pv = acc?.pv || {};
  const c = acc?.corrections || {};
  const a1 = accuracyOf(pv.h1), ad = accuracyOf(pv.day);
  const items = [
    { key: 'pv.d1', label: 'Forecast for the day', value: ad === null ? null : { n: Math.round(ad * 100), u: '%' }, sub: pv.day?.n ? { t: '{n} days compared', p: { n: pv.day.n } } : { t: 'not compared yet', p: {} }, conf: clamp01((pv.day?.n || 0) / 14) },
    { key: 'pv.h1', label: 'Forecast for the next hour', value: a1 === null ? null : { n: Math.round(a1 * 100), u: '%' }, sub: pv.h1?.n ? { t: '{n} hours compared', p: { n: pv.h1.n } } : '', conf: clamp01((pv.h1?.n || 0) / 200) },
    { key: 'pv.factor', label: 'Correction it applies', value: fin(pv.d1?.factor) ? { n: r2(pv.d1.factor), d: 2, pre: '× ' } : null, sub: { t: 'actual against forecast', p: {} }, conf: clamp01((pv.day?.n || 0) / 14) },
  ];
  return topic('solar', 'Solar forecast', 'sun', 'var(--en-solar)', {
    headline: ad !== null ? { t: 'the day forecast is {p}% right', p: { p: Math.round(ad * 100) } } : { t: 'comparing forecast and actual', p: {} },
    conf: clamp01((pv.day?.n || 0) / 14), accuracy: ad, accuracyNote: ad !== null ? { t: 'over the last {n} days', p: { n: pv.day.n } } : '',
    items, link: '/learned#solar',
  });
}

// Everything for the page.
async function overview(nowMs = Date.now()) {
  const acc = await require('./forecastLog').summary(nowMs, 28).catch(() => ({}));
  const learning = require('./learning');
  const em = require('./energyManager');
  const mods = require('./energyModules');
  const topics = [];
  for (const f of [() => heatpumpTopic(mods), () => loadsTopic(em, acc), () => carTopic(learning, acc), () => houseTopic(learning, acc), () => solarTopic(acc)]) {
    const t = await f().catch((e) => ({ key: 'error', title: 'Error', error: e.message, items: [] }));
    topics.push(t);
  }
  const events = (await settings.get('learning_events', { list: [] }).catch(() => ({ list: [] }))).list || [];
  return { topics, events: events.slice(-60).reverse(), snapshotAt: (await settings.get('learning_snapshot', {}).catch(() => ({}))).at || null };
}

// a value as text for the timeline: { n, d, u, pre } -> '0.3 °C/h'
const plain = (v) => (v && typeof v === 'object' ? `${v.pre || ''}${v.n}${v.u ? (v.u === '%' ? '%' : ` ${v.u}`) : ''}` : String(v));

// Pure: the values of the topics that the timeline follows — { key: { topic, label, value } }.
function valuesOf(topics) {
  const out = {};
  for (const t of topics || []) for (const it of t.items || []) if (it.value !== null && it.value !== undefined) out[it.key] = { topic: t.key, label: it.label, value: plain(it.value) };
  return out;
}
// Pure: what changed between two snapshots — new, changed (numbers more than 10 % or 0.5), gone.
function changes(before, now) {
  const num = (s) => { const m = String(s).match(/-?\d+(?:[.,]\d+)?/); return m ? Number(m[0].replace(',', '.')) : null; };
  const out = [];
  for (const [k, v] of Object.entries(now)) {
    const b = before[k];
    if (!b) { out.push({ key: k, topic: v.topic, label: v.label, kind: 'new', to: v.value }); continue; }
    if (b.value === v.value) continue;
    // times (07:40 → 07:30): news from 5 minutes
    const tm = (x) => { const m = String(x).match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    if (tm(b.value) !== null && tm(v.value) !== null) { if (Math.abs(tm(v.value) - tm(b.value)) >= 5) out.push({ key: k, topic: v.topic, label: v.label, kind: 'changed', from: b.value, to: v.value }); continue; }
    const a = num(b.value), c = num(v.value);
    if (a !== null && c !== null && Math.abs(c - a) < Math.max(0.5, Math.abs(a) * 0.1) && String(b.value).replace(/[\d.,-]/g, '') === String(v.value).replace(/[\d.,-]/g, '')) continue;
    out.push({ key: k, topic: v.topic, label: v.label, kind: 'changed', from: b.value, to: v.value });
  }
  for (const [k, b] of Object.entries(before)) if (!now[k]) out.push({ key: k, topic: b.topic, label: b.label, kind: 'gone', from: b.value });
  return out;
}

// Once a day: a snapshot of what it knows, and the differences with the previous one in the timeline.
async function snapshot(nowMs = Date.now(), { force = false } = {}) {
  // (not readable — the database restarting: no snapshot now, so the timeline isn't saved over with
  // just today's)
  const prev = await settings.get('learning_snapshot', {});
  if (!force && prev.at && nowMs - Date.parse(prev.at) < 20 * 3600000) return null;
  const { topics } = await overview(nowMs);
  const values = valuesOf(topics);
  const ev = await settings.get('learning_events', { list: [] });
  const list = ev.list || [];
  if (prev.values) for (const c of changes(prev.values, values)) list.push({ at: new Date(nowMs).toISOString(), ...c });
  await settings.set('learning_events', { list: list.slice(-200) });
  await settings.set('learning_snapshot', { at: new Date(nowMs).toISOString(), values });
  return values;
}

let timer = null;
function startLearningSnapshots() {
  if (timer) return;
  timer = setInterval(() => snapshot().catch((e) => console.error(`[learning] snapshot: ${e.message}`)), 3600000);
  timer.unref?.();
  setTimeout(() => snapshot().catch((e) => console.error(`[learning] snapshot: ${e.message}`)), 120000).unref?.();
}

module.exports = { overview, snapshot, valuesOf, changes, startLearningSnapshots, accuracyOf };
