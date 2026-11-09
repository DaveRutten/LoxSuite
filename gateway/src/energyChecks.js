// What LoxSuite can tell the user about how the heat pump module is set up and how good its data is —
// things found by hand in a review (2026-11-08) that it can see itself (notification trigger
// 'energy_config', and always in the bell, also without a rule; see notifications.notifyBell).
// Pure: the heat pump status of this minute + a small memory -> checks { key, severity, title, message,
// link }. The key holds the day or week, so each one goes out once in that period.
//   mem: { noValueSince: { role: ms } } — kept by the caller between minutes, updated here
// Texts are English; the bell and the channels show them as they are (like energyAlerts.js).
const MIN = 60000;
const DAY = 86400000;
const r1 = (x) => Math.round(x * 10) / 10;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
// ISO week (yyyy-Www): a weekly check goes out once a week
function weekKey(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const wd = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - wd + 3);
  const y = t.getUTCFullYear();
  const w = 1 + Math.round(((t - Date.UTC(y, 0, 4)) / DAY - 3 + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const LINK = '/energy-manager/modules/heatpump';

// A notification text: an English template with {params}; a param may itself be a text to translate
// ({ t, p }) or a list of them ({ join, parts }). fillText makes the English text; notifications.js makes
// the one in the user's language with the same function and its own translate().
function fillText(t, p = {}, translate = (x) => x) {
  const val = (v) => {
    if (v && typeof v === 'object' && v.join !== undefined) return (v.parts || []).map((x) => fillText(x.t, x.p, translate)).join(v.join);
    if (v && typeof v === 'object' && v.t !== undefined) return fillText(v.t, v.p, translate);
    return v;
  };
  return String(translate(t)).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(val(p[k]))));
}
// one check: key, severity, the English text filled in, the templates (i18n) and a link
function made(key, severity, [tt, tp = {}], [mt, mp = {}], link) {
  return { key, severity, title: fillText(tt, tp), message: fillText(mt, mp), i18n: { title: { t: tt, p: tp }, message: { t: mt, p: mp } }, link };
}

// st: heatpumpStatus(); ctx: { powerCandidate (name of a Loxone meter for the heat pump, or null),
// history ({ at, without } of the last "read history"), mqttActive (number of active MQTT → Loxone
// mappings, null when unknown), boosterKw (live kW of the booster meter, or null), loxoneFlowMax }
// Title and message are English templates with {params} (i18n: translated when the notification is made,
// see notifications.localizeEvent); title/message hold the English text filled in.
function heatpumpChecks(st, mem, nowMs, ctx = {}) {
  const out = [];
  if (!st || st.error || !st.cfg?.enabled) return out;
  const cfg = st.cfg;
  const add = (key, severity, title, message, link = LINK) => out.push(made(key, severity, title, message, link));
  const week = weekKey(nowMs), day = dayKey(nowMs);

  // ---- links
  if (!st.electricFrom) {
    add(`power|${week}`, 'warning', ['Heat pump: power use not linked'],
      ctx.powerCandidate
        ? ['Link "{m}" as the heat pump\'s electric power (or give the consumer "heat pump" in the energy manager that meter) for COP, SCOP and advice.', { m: ctx.powerCandidate }]
        : ['No electric power of the heat pump is read: without it there is no COP, SCOP or advice. Link a Loxone meter of the heat pump, or give the consumer "heat pump" in the energy manager a meter.']);
  }
  mem.noValueSince = mem.noValueSince || {};
  const noVal = new Set(st.dataCheck?.noValueRoles || []);
  for (const role of Object.keys(mem.noValueSince)) if (!noVal.has(role)) delete mem.noValueSince[role];
  for (const role of noVal) if (!mem.noValueSince[role]) mem.noValueSince[role] = nowMs;
  const stale = [...noVal].filter((role) => nowMs - mem.noValueSince[role] >= 10 * MIN);
  if (stale.length) {
    add(`novalue|${stale.sort().join(',')}|${day}`, 'warning', ['Heat pump: linked object gives no value'],
      ['No value for {roles} for more than 10 minutes. Check the link (for a meter: its power output "actual") and whether the object is visible to LoxSuite\'s Loxone user.', { roles: stale.join(', ') }]);
  }
  if (st.state?.elecInW) {
    add(`unitW|${day}`, 'warning', ['Heat pump: electric power looks like W'],
      ['The linked electric power reads {v} — no heat pump uses that many kW, so it is taken as W. Link the meter\'s kW output, or check the unit.', { v: Math.round(Number(st.values?.electricPower)) }]);
  }
  const unl = (st.dataCheck?.unlinkedWithCandidate || []).filter((u) => ['dhwPipeTemp', 'electricPower', 'boosterPower', 'heatMeterPower', 'outdoorRh', 'boosterHeater', 'immersionHeater'].includes(u.role));
  if (unl.length) {
    add(`unlinked|${unl.map((u) => u.role).sort().join(',')}|${week}`, 'info', ['Heat pump: a useful sensor is not linked'],
      ['Found in the Loxone project but not linked: {list}.', { list: unl.map((u) => `${u.label}${u.candidate ? ` ("${u.candidate}")` : ''}`).join(', ') }]);
  }

  // ---- implausible values
  const runs = (st.tuning?.lastRuns || []).filter((r) => r.cop !== null && r.cop !== undefined);
  const bad = runs.filter((r) => r.cop < 1 || r.cop > 7);
  if (bad.length) {
    add(`cop|${day}`, 'warning', ['Heat pump: implausible COP'],
      ['{n} run(s) in the last day with a COP of {cops} (normal: 2–6). Check the heat (heat meter flow unit, the unit\'s own figure) and the electric power (kW, the right meter).', { n: bad.length, cops: bad.map((r) => r1(r.cop)).slice(0, 3).join(', ') }]);
  }
  if (Number(st.values?.thermalPower) < -0.2 && st.state?.mode !== 'defrost') {
    add(`neg|${day}`, 'info', ['Heat pump: negative heat outside defrosting'],
      ['The unit reports {kw} kW of heat while it is not defrosting. Check the sign of the heat output.', { kw: r1(Number(st.values.thermalPower)) }]);
  }

  // ---- data & signals
  const gap = (st.dataGaps || []).find((g) => g.min >= 30);
  if (gap) {
    add(`gap|${dayKey(gap.fromMs)}|${Math.floor(gap.fromMs / (6 * 3600000))}`, 'warning', ['Heat pump: data gap'],
      ['No samples from {from} for {dur} (LoxSuite or the connection to the Miniserver was down). Learning skips this period.', { from: `${new Date(gap.fromMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`, dur: gap.min >= 120 ? `${r1(gap.min / 60)} h` : `${gap.min} min` }]);
  }
  if (ctx.history?.without?.length) {
    add(`stats|${ctx.history.at || day}`, 'info', ['Heat pump: no Loxone statistics on linked values'],
      ['"Read history" found no statistics for: {roles}. Switch statistics on for those objects in Loxone Config, so the history can be read next time.', { roles: ctx.history.without.join(', ') }]);
  }
  if (cfg.mode === 'live' && ctx.mqttActive === 0 && (st.writes || []).some((w) => !w.action)) {
    add(`nowrite|${day}`, 'error', ['Heat pump: live, but no way to write'],
      ['The module is live and sends through virtual inputs, but there is no active MQTT → Loxone mapping. Nothing reaches the heat pump.']);
  }

  // ---- learning & advice
  const TU = st.tuning || {};
  const adv = TU.advice;
  if (TU.mode !== 'off' && adv && (adv.explore || adv.useCop === false || /nothing to compare/.test(adv.why || ''))) {
    const ex = adv.explore;
    const cur = TU.current || {};
    add(`compare|${week}`, 'info', ['Heat pump: the advice has nothing to compare with'],
      ex && Number.isFinite(ex.flowC) && ex.flowC !== cur.flowC ? ['Only the current setting was seen in this weather. Try flow {a} °C instead of {b} °C for a day, so there is something to compare with.', { a: ex.flowC, b: cur.flowC }]
        : ex && (ex.step ?? 0) !== (cur.step ?? 0) ? ['Only the current setting was seen in this weather. Try power step {a} instead of {b} for a day, so there is something to compare with.', { a: ex.step, b: cur.step ?? 0 }]
          : ex ? ['Only the current setting was seen in this weather. Try outdoor sensor setting {a} instead of {b} for a day, so there is something to compare with.', { a: ex.ntc, b: cur.ntc ?? 0 }]
            : adv.useCop === false ? ['Without a power measurement the advice can only compare run lengths and defrosts. Link the electric power for the COP.']
              : ['Only one setting was seen in this weather: change the flow temperature for a few days so the advice has something to compare with.']);
  }
  if (cfg.mode === 'shadow' && (st.learned?.days || 0) >= 14) {
    const days = st.learned.days, scop = st.weather?.scop?.scop;
    add(`shadow|${week}`, 'info', ['Heat pump: still in shadow mode'],
      scop ? ['The module has been learning for {d} days and only shows what it would do. Measured SCOP {s}. Look at its plan and advice; switch it to live when they make sense.', { d: days, s: scop }]
        : ['The module has been learning for {d} days and only shows what it would do. Look at its plan and advice; switch it to live when they make sense.', { d: days }]);
  }
  if ((st.learned?.days || 0) >= 14 && !(st.learned?.patterns || []).length) {
    add(`draws|${week}`, 'info', ['Heat pump: no tap-water draws recognised'],
      ['After two weeks no usual tap-water draws were found in the tank temperature. A hot-water pipe sensor (linked as "hot-water pipe") makes them exact.']);
  }
  const bins = Object.values(st.room?.model?.bins || {});
  if (bins.length >= 2 && new Set(bins.map((b) => b.rate)).size === 1) {
    add(`warmup|${week}`, 'info', ['Heat pump: room warm-up looks coarse'],
      ['Every outdoor temperature gives the same warm-up rate ({r} °C/h): the room sensor is probably too coarse (0.1 °C steps) to learn it. A sensor with finer steps helps.', { r: bins[0].rate }]);
  }
  const sch = st.room?.schedule;
  if (sch && !sch.flat && Number.isFinite(ctx.loxoneComfortC) && Math.abs(sch.comfortC - ctx.loxoneComfortC) >= 1) {
    add(`schedule|${week}`, 'warning', ['Heat pump: learned comfort differs from Loxone'],
      ['Learned comfort temperature {a} °C, the room controller in Loxone says {b} °C. With "comfort times from Loxone" the plan follows the learned one — check it, or use your own times.', { a: sch.comfortC, b: ctx.loxoneComfortC }]);
  }
  if (st.room?.preheat?.capped || (st.room?.preheat?.late && st.roomForecast?.reachAt && st.room?.comfortAt && st.roomForecast.reachAt > st.room.comfortAt + 30 * MIN)) {
    add(`comfort|${day}`, 'warning', ['Heat pump: comfort not reached in time'],
      st.room.preheat.capped ? ['Even 8 h of pre-heating leaves the room about {c} °C short. Raise the flow temperature or the night set-back.', { c: st.room.preheat.shortC }]
        : ['The room will be warm later than the comfort time: pre-heating should already have started.']);
  }

  // ---- settings vs what happens
  const Lm = st.limits || {};
  const tankSeen = st.learned?.tankRange;
  if (tankSeen && Number.isFinite(Lm.comfortMinC) && tankSeen.minC < Lm.comfortMinC - 5) {
    add(`tankrange|${week}`, 'info', ['Heat pump: tap-water limits differ from what the tank does'],
      ['The tank went down to {a} °C (your comfort minimum is {b} °C). Either the minimum is set too high for how you use it, or the tank is not kept warm enough.', { a: tankSeen.minC, b: Lm.comfortMinC }]);
  }
  const boosterKw = Number.isFinite(Number(ctx.boosterKw)) ? Number(ctx.boosterKw) : (Number.isFinite(st.values?.boosterPower) ? (st.values.boosterPower > 20 ? st.values.boosterPower / 1000 : st.values.boosterPower) : null);
  if (boosterKw > 0.3 && Number(st.values?.tankTemp) >= Number(Lm.hpMaxC) - 1) {
    add(`booster|${day}`, 'info', ['Heat pump: the booster does the last part'],
      ['The booster heater is on ({kw} kW) with the tank at {t} °C: above about {hp} °C the heating is electric at COP 1. Lower "the heat pump reaches on its own" or the buffer maximum.', { kw: r1(boosterKw), t: r1(st.values.tankTemp), hp: Lm.hpMaxC }]);
  }
  if (Number.isFinite(ctx.loxoneFlowMax) && Number(cfg.tuning?.flow_max) > ctx.loxoneFlowMax) {
    add(`flowmax|${week}`, 'warning', ['Heat pump: flow maximum outside the Loxone range'],
      ['Flow maximum {a} °C, but the value selector in Loxone goes up to {b} °C: higher values are cut off there.', { a: cfg.tuning.flow_max, b: ctx.loxoneFlowMax }]);
  }
  if (Number(cfg.room?.solar_boost_c) > 0 && Number(ctx.loxoneExcessOffsetC) > 0) {
    add(`solar2x|${week}`, 'info', ['Heat pump: room raised on solar twice'],
      ['"Warmer on solar" (+{a} °C) is on in LoxSuite and the room controller in Loxone also raises the target on excess energy (+{b} °C). Use one of the two.', { a: cfg.room.solar_boost_c, b: ctx.loxoneExcessOffsetC }]);
  }

  // ---- good news: what it learned, how right it is, what it brought, a sunny day ahead
  const cmp = st.tuningWeathers?.compared || 0;
  if (cmp >= 1) {
    add(`milestone|compared|${cmp}`, 'info', ['Heat pump: the advice can compare'],
      ['In {n} kind(s) of weather two or more settings were seen, so the advice for long, calm runs now rests on measurements.', { n: cmp }]);
  }
  const ra = st.accuracy?.room?.h1;
  if (ra?.n >= 168 && ra.within >= 0.8) {
    add(`milestone|accroom|${new Date(nowMs).toISOString().slice(0, 7)}`, 'info', ['Heat pump: its room forecast is reliable'],
      cfg.mode === 'shadow' ? ['Over the last {n} hours the room temperature an hour ahead was right within 0.5 °C in {p} % of the hours — a good moment to look at switching it to live.', { n: ra.n, p: Math.round(ra.within * 100) }]
        : ['Over the last {n} hours the room temperature an hour ahead was right within 0.5 °C in {p} % of the hours.', { n: ra.n, p: Math.round(ra.within * 100) }]);
  }
  // the month before, early in the next month
  const d = new Date(nowMs);
  const prevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const rep = (st.report || []).find((m) => m.month === prevMonth);
  if (rep && d.getUTCDate() <= 3 && rep.days >= 20) {
    const p = { e: rep.elecKwh, h: rep.heatKwh, s: rep.scop ?? '—', c: (rep.costEur || 0).toFixed(2), v: (rep.savedEur || 0).toFixed(2) };
    add(`month|${prevMonth}`, 'info', ['Heat pump: {m}', { m: prevMonth }],
      rep.savedEur > 0.5 ? ['{e} kWh of power for {h} kWh of heat (SCOP {s}), € {c} — € {v} less than at the day\'s average price.', p]
        : ['{e} kWh of power for {h} kWh of heat (SCOP {s}), € {c}.', p]);
  }
  // tomorrow a lot of solar to spare: the tank can store it (in the late afternoon, once)
  const tomorrow = dayKey(nowMs + DAY);
  const sunKwh = (st.plan || []).filter((h) => dayKey(h.ms) === tomorrow).reduce((a, h) => a + (Number(h.surplusKwh) || 0), 0);
  if (d.getUTCHours() >= 15 && sunKwh >= 8 && Number(Lm.bufferMaxC) > Number(Lm.targetC)) {
    add(`sun|${tomorrow}`, 'info', ['Heat pump: a sunny day tomorrow'],
      cfg.mode === 'shadow' ? ['About {k} kWh of solar to spare tomorrow: in live mode the plan heats the tank up to {c} °C on it, so less is needed in the evening.', { k: Math.round(sunKwh), c: Lm.bufferMaxC }]
        : ['About {k} kWh of solar to spare tomorrow: the plan heats the tank up to {c} °C on it, so less is needed in the evening.', { k: Math.round(sunKwh), c: Lm.bufferMaxC }]);
  }
  return out;
}

// Pure: what the learning dashboard's daily snapshot found new or changed, as one message (or none).
//   changes [{ topic, label, kind: 'new'|'changed'|'gone', from, to }]
function learnedMessage(changes, nowMs) {
  const list = (changes || []).filter((c) => c.kind !== 'gone');
  if (!list.length) return null;
  const txt = (x) => (x && typeof x === 'object' ? (x.n !== undefined ? `${x.n}${x.u ? ` ${x.u}` : ''}` : JSON.stringify(x)) : String(x ?? ''));
  // the labels in the user's language too (they are texts of the learning dashboard)
  const parts = list.slice(0, 4).map((c) => (c.kind === 'new' ? { t: '{label}: {to}', p: { label: { t: c.label }, to: txt(c.to) } } : { t: '{label}: {from} → {to}', p: { label: { t: c.label }, from: txt(c.from), to: txt(c.to) } }));
  const more = list.length > 4 ? list.length - 4 : 0;
  return made(`learned|${dayKey(nowMs)}`, 'info', ['Learned just now'],
    more ? ['{list}; and {n} more.', { list: { join: '; ', parts }, n: more }] : ['{list}.', { list: { join: '; ', parts } }], '/energy-manager/learning');
}

// Pure: is a value plausible for its unit? -> null (no value), true, or a short reason why not.
const RANGES = { '°C': [-40, 100], kW: [-1, 20], 'l/min': [0, 200], Hz: [0, 200], '%': [0, 100] };
function plausibleValue(unit, v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return 'not a number';
  const r = RANGES[unit];
  if (!r) return true;
  if (unit === 'kW' && n > r[1]) return 'more than a heat pump uses: W instead of kW?';
  return n < r[0] || n > r[1] ? `outside ${r[0]}…${r[1]} ${unit}` : true;
}

module.exports = { heatpumpChecks, learnedMessage, weekKey, plausibleValue, fillText, made };
