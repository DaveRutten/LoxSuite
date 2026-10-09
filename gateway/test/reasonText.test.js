// The plan's explanations are matched to a template, so they show in the user's language.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tr } = require('../src/reasonText');

const t = (tpl, p = {}) => `NL[${tpl}]` + JSON.stringify(p);

test('a planner reason becomes a template with its values; unknown text stays as it is', () => {
  assert.equal(tr(t, 'cheapest hour before the tank would drop below 45 °C (~07:00), right after heating the room'), 'NL[cheapest hour before the tank would drop below {c} °C (~{t}), right after heating the room]{"c":"45","t":"07:00"}');
  assert.equal(tr(t, 'overdue: first allowed block, 11:00'), 'NL[overdue: first allowed block, {t}]{"t":"11:00"}');
  assert.equal(tr(t, 'export costs € 0.085/kWh: only what the house uses (1.1 kW)'), 'NL[export costs € {v}/kWh: only what the house uses ({kw} kW)]{"v":"0.085","kw":"1.1"}');
  assert.equal(tr(t, 'something new'), 'something new');
  assert.equal(tr(t, null), '');
});
