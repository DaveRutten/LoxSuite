// The explanations the energy-manager modules give with a plan ("cheapest hour before …", "overdue: …")
// are built in English by the pure planners (tankDraws, legionella, solarLimit, heatPumpTypes, the room
// plan). For the page they are matched here to a template with placeholders, so t() can translate
// them like any other text: tr(t, reason) -> the reason in the user's language.
const PATTERNS = [
  [/^cheapest hour before the tank would drop below (\S+) °C \(~(.+?)\)(, right (before|after) heating the room)?$/, (m) => [m[3] ? (m[4] === 'before' ? 'cheapest hour before the tank would drop below {c} °C (~{t}), right before heating the room' : 'cheapest hour before the tank would drop below {c} °C (~{t}), right after heating the room') : 'cheapest hour before the tank would drop below {c} °C (~{t})', { c: m[1], t: m[2] }]],
  [/^solar surplus, hot before the usual draw ~(.+?)(, right (before|after) heating the room)?$/, (m) => ['solar surplus, hot before the usual draw ~{t}', { t: m[1] }]],
  [/^solar surplus: tank as a buffer$/, () => ['solar surplus: tank as a buffer', {}]],
  [/^warm enough: space heating$/, () => ['warm enough: space heating', {}]],
  [/^low but enough until the next planned hour$/, () => ['low but enough until the next planned hour', {}]],
  [/^heating the room \(no tap water in between\)$/, () => ['heating the room (no tap water in between)', {}]],
  [/^tank (\S+) °C, below (\S+) °C: now, before the boost element steps in$/, (m) => ['tank {t} °C, below {c} °C: now, before the booster steps in', { t: m[1], c: m[2] }]],
  [/^overdue: first allowed block, (.+)$/, (m) => ['overdue: first allowed block, {t}', { t: m[1] }]],
  [/^on solar surplus, (.+?): the booster's kWh are free$/, (m) => ['on solar surplus, {t}: the booster\'s kWh are free', { t: m[1] }]],
  [/^cheapest block before it is due, (.+)$/, (m) => ['cheapest block before it is due, {t}', { t: m[1] }]],
  [/^no (\d+) h block between (\d+):00 and (\d+):00 before it is due$/, (m) => ['no {h} h block between {a}:00 and {b}:00 before it is due', { h: m[1], a: m[2], b: m[3] }]],
  [/^pre-heating for (\S+) °C at (.+)$/, (m) => ['pre-heating for {c} °C at {t}', { c: m[1], t: m[2] }]],
  [/^comfort$/, () => ['comfort', {}]],
  [/^solar to spare: a little warmer \(the house stores it\)$/, () => ['solar to spare: a little warmer (the house stores it)', {}]],
  [/^solar to spare: cooling a little more \(the house stores it\)$/, () => ['solar to spare: cooling a little more (the house stores it)', {}]],
  [/^set back$/, () => ['set back', {}]],
  [/^export yields € (\S+)\/kWh: no limit$/, (m) => ['export yields € {v}/kWh: no limit', { v: m[1] }]],
  [/^no price: no limit$/, () => ['no price: no limit', {}]],
  [/^export costs € (\S+)\/kWh: only what the house uses \((\S+) kW\)$/, (m) => ['export costs € {v}/kWh: only what the house uses ({kw} kW)', { v: m[1], kw: m[2] }]],
  [/^(.+) on \(read from the unit\)$/, (m) => ['{what} on (read from the unit)', { what: m[1] }]],
  [/^tap water now: up to the target$/, () => ['tap water now: up to the target', {}]],
  [/^tap water now: above tank \+ drop$/, () => ['tap water now: above tank + drop', {}]],
  [/^hold: the unit itself only starts below (\S+) °C$/, (m) => ['hold: the unit itself only starts below {c} °C', { c: m[1] }]],
  [/^power control on \(stays on; 100 % = no limit\)$/, () => ['power control on (stays on; 100 % = no limit)', {}]],
  [/^defrosting a lot: trying a calmer setting$/, () => ['defrosting a lot: trying a calmer setting', {}]],
  [/^the current setting is the best known in this weather$/, () => ['the current setting is the best known in this weather', {}]],
  [/^nothing learned yet in this weather: keep the current setting$/, () => ['nothing learned yet in this weather: keep the current setting', {}]],
  [/^room behind: no calmer setting$/, () => ['room behind: no calmer setting', {}]],
  [/^best known in this weather: (\S+) min runs, (\S+) defrosts\/h, COP (\S+)$/, (m) => ['best known in this weather: {m} min runs, {d} defrosts/h, COP {c}', { m: m[1], d: m[2], c: m[3] }]],
  [/^start one tap-water cycle$/, () => ['start one tap-water cycle', {}]],
  [/^start the legionella cycle$/, () => ['start the legionella cycle', {}]],
  [/^legionella: (\S+) °C \(the booster helps above (\S+) °C\)$/, (m) => ['legionella: {c} °C (the booster helps above {h} °C)', { c: m[1], h: m[2] }]],
  [/^buffer above (\S+) °C only with the booster: limited to (\S+) °C \(allow the booster on solar to go higher\)$/, (m) => ['buffer above {a} °C only with the booster: limited to {b} °C (allow the booster on solar to go higher)', { a: m[1], b: m[2] }]],
  [/^target above what the heat pump reaches on its own \((\S+) °C\): every cycle uses the booster$/, (m) => ['target above what the heat pump reaches on its own ({c} °C): every cycle uses the booster', { c: m[1] }]],
  [/^comfort minimum below 40 °C: legionella grows best between 25 and 45 °C — keep the weekly legionella cycle on$/, () => ['comfort minimum below 40 °C: legionella grows best between 25 and 45 °C — keep the weekly legionella cycle on', {}]],
  [/^target raised to the comfort minimum \((\S+) °C\)$/, (m) => ['target raised to the comfort minimum ({c} °C)', { c: m[1] }]],
  [/^buffer maximum raised to the target \((\S+) °C\)$/, (m) => ['buffer maximum raised to the target ({c} °C)', { c: m[1] }]],
  [/^buffer maximum lowered to the absolute maximum \((\S+) °C\)$/, (m) => ['buffer maximum lowered to the absolute maximum ({c} °C)', { c: m[1] }]],
];

function tr(t, reason) {
  const s = String(reason ?? '');
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(s);
    if (m) { const [tpl, params] = fn(m); return t(tpl, params); }
  }
  return s;
}

module.exports = { tr, PATTERNS };
