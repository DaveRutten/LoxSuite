// Charging away from home (externalCharging.js): reading an E-Flux / other provider's export.
const test = require('node:test');
const assert = require('node:assert/strict');
const ec = require('../src/externalCharging');

// local time = UTC in these tests
const localToMs = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm);

test('an E-Flux style CSV: Dutch numbers, the price incl. VAT, the session id, not the EVSE id', () => {
  const csv = [
    'Sessie ID;Starttijd;Eindtijd;Locatie;EVSE ID;kWh;Prijs per kWh;Prijs excl. BTW;Prijs incl. BTW',
    '"A1";10-10-2026 08:12;10-10-2026 10:40;"Kantoor, Venlo";NL*EFL*E1;18,52;0,39;6,02;7,28',
    '"A2";11-10-2026 14:05;11-10-2026 15:00;Supermarkt;NL*EFL*E1;7,1;0,39;2,29;2,77',
    ';;;;;;;;',
  ].join('\r\n');
  const r = ec.sessionsFromRows(ec.parseCsv(csv), { localToMs });
  assert.equal(r.sessions.length, 2);
  const [a, b] = r.sessions;
  assert.equal(a.ext_id, 'E-Flux:A1');
  assert.equal(b.ext_id, 'E-Flux:A2', 'the session id, not the charger id');
  assert.equal(a.kwh, 18.52);
  assert.equal(a.cost_eur, 7.28, 'incl. VAT, not excl. and not the price per kWh');
  assert.equal(a.start_at, '2026-10-10T08:12:00.000Z');
  assert.equal(a.end_at, '2026-10-10T10:40:00.000Z');
  assert.equal(a.location, 'Kantoor, Venlo');
});

test('English columns, ISO times, no id: the same session imported twice gets the same key', () => {
  const csv = 'Start Time,End Time,Energy (kWh),Total (EUR),Location\n2026-10-01 07:00,2026-10-01 09:00,"12.5","€ 5.10",Work\n';
  const one = ec.sessionsFromRows(ec.parseCsv(csv), { localToMs }).sessions;
  const two = ec.sessionsFromRows(ec.parseCsv(csv), { localToMs }).sessions;
  assert.equal(one.length, 1);
  assert.equal(one[0].kwh, 12.5);
  assert.equal(one[0].cost_eur, 5.1);
  assert.equal(one[0].ext_id, two[0].ext_id);
});

test('numbers and dates as exports write them; an unknown file says what is missing', () => {
  assert.equal(ec.num('1.234,56'), 1234.56);
  assert.equal(ec.num('1,234.56'), 1234.56);
  assert.equal(ec.num('€ 3,10'), 3.1);
  assert.equal(ec.parseDate(46304.5, localToMs), Date.UTC(2026, 9, 9, 12, 0), 'an Excel serial date');
  assert.equal(ec.parseDate('2026-10-01T07:00:00Z', localToMs), Date.UTC(2026, 9, 1, 7));
  assert.match(ec.sessionsFromRows([['Naam', 'Adres']], { localToMs }).error, /start time and kWh/);
});

test('per month: kWh of all sessions, € per kWh only over the ones with a cost', () => {
  const m = ec.byMonth([
    { start_at: '2026-10-01T08:00:00Z', kwh: 10, cost_eur: 4 },
    { start_at: '2026-10-05T08:00:00Z', kwh: 5, cost_eur: null },
    { start_at: '2026-09-30T08:00:00Z', kwh: 8, cost_eur: 2.4 },
  ], (ms) => new Date(ms).toISOString().slice(0, 7));
  assert.deepEqual(m.get('2026-10'), { month: '2026-10', kwh: 15, eur: 4, n: 2, eurPerKwh: 0.4 });
  assert.equal(m.get('2026-09').eurPerKwh, 0.3);
});
