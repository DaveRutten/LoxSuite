// The heat pump's few most useful suggestions: what to change for more comfort, less energy or a higher
// efficiency, from what the module has learned. Pure; the texts are English templates with {params},
// translated by the view.
//
// in: { comfortAt, reachAt, roomEnabled, tankMinC, tankMinAt, limits, legionella, scop, source, outdoorC,
//       current, advice, overshoot, curRow, differs }
// out: [{ kind: 'comfort' | 'energy' | 'efficiency', text, params }] — at most `max`, most important first
const r1 = (x) => Math.round(x * 10) / 10;

function suggestions(x, { max = 3 } = {}) {
  const out = [];
  const add = (score, kind, text, params = {}) => out.push({ score, kind, text, params });
  const L = x.limits || {};

  // comfort: the room is warm too late, the tank too cold
  if (x.roomEnabled && x.comfortAt && x.reachAt && x.reachAt > x.comfortAt + 15 * 60000 && x.reachAt < x.comfortAt + 6 * 3600000) {
    add(90, 'comfort', 'The room is expected warm {m} min after the comfort time: start pre-heating earlier, or set the comfort time in Loxone earlier.', { m: Math.round((x.reachAt - x.comfortAt) / 60000) });
  }
  if (Number.isFinite(x.tankMinC) && Number.isFinite(L.comfortMinC) && x.tankMinC < L.comfortMinC - 0.5) {
    add(85, 'comfort', 'The tank is expected to drop to {c} °C, below your minimum of {min} °C: raise the normal target or the buffer on cheap power.', { c: r1(x.tankMinC), min: L.comfortMinC });
  }
  if (x.legionella && !x.legionella.enabled && !x.legionella.unit_backup) {
    add(65, 'comfort', 'No legionella program: switch it on here or leave the unit\'s own program on.');
  }

  // energy: electric heating where the heat pump could do it
  if (Number.isFinite(L.targetC) && Number.isFinite(L.hpMaxC) && L.targetC > L.hpMaxC) {
    add(75, 'energy', 'The normal tank target ({t} °C) is above what the heat pump reaches ({hp} °C): the booster heats electrically, at COP 1. Lower it to {hp} °C.', { t: L.targetC, hp: L.hpMaxC });
  }
  if (Number.isFinite(L.bufferMaxC) && Number.isFinite(L.targetC) && L.bufferMaxC <= L.targetC) {
    add(40, 'energy', 'Allow a higher tank buffer on solar or cheap power (e.g. {c} °C): free energy stored for later.', { c: Math.min(L.hpMaxC || 55, L.targetC + 5) });
  }

  // efficiency: calmer, longer runs
  if (x.advice && x.advice.learned && x.differs) {
    const row = x.advice.row || {};
    add(70, 'efficiency', 'Switch to {setting}: in this weather it gave runs of {run}, {d} defrosts per hour and a COP of {cop}.', { setting: x.advice.setting, run: { min: row.runMin }, d: row.defrostPerH, cop: row.cop });
  }
  if (x.overshoot && x.overshoot.overshootC > 0.3) {
    add(60, 'efficiency', 'It stops too early and starts again soon: let it run {c} °C longer for fewer starts.', { c: r1(x.overshoot.overshootC) });
  }
  if (x.curRow && x.curRow.runs >= 3 && x.curRow.runMin < 30) {
    add(55, 'efficiency', 'Its runs are short ({m} min): a lower flow temperature or power step makes it run longer and calmer.', { m: Math.round(x.curRow.runMin) });
  }
  if (Number.isFinite(x.current?.flowC) && Number.isFinite(x.outdoorC) && x.outdoorC > 8 && x.current.flowC > 38) {
    add(50, 'efficiency', 'A flow of {f} °C at {o} °C outside is high: a lower heating curve raises the COP.', { f: r1(x.current.flowC), o: r1(x.outdoorC) });
  }
  if (x.scop && x.scop.scop && x.scop.days >= 14 && x.scop.scop < (x.source === 'air' ? 3 : 3.8)) {
    add(45, 'efficiency', 'The measured SCOP ({s}) is low for this kind of heat pump: a lower flow temperature usually helps most.', { s: x.scop.scop });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, max).map(({ score, ...rest }) => rest);
}

module.exports = { suggestions };
