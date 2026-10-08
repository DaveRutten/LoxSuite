// Changing a "ready by" line (v0.53): for one day (moved, or no departure) or for every week on that
// weekday (a time, or no usual departure). A corrected day plans with your time; once it has passed it
// counts for what LoxSuite learns, but a real departure that morning goes first.
const test = require('node:test');
const assert = require('node:assert/strict');
const learning = require('../src/learning');

const tz = 'UTC';
const H = 3600000;
const D = 86400000;
const base = Date.parse('2026-06-01T00:00:00Z'); // a Monday
// ten Mondays leaving around 07:30
const sessions = Array.from({ length: 10 }, (_, i) => ({ connect: base + i * 7 * D - 10 * H, disconnect: base + i * 7 * D + (7 * 60 + 30) * 60000, kwh: 5 }));
const now = base + 70 * D + 6 * H; // Monday 10 August, 06:00
const day = (ms) => learning.dateKeyOf(ms, tz);

test('cleanReady: a time, "none" (also "-" and "geen"), or nothing', () => {
  assert.equal(learning.cleanReady('7:05'), '07:05');
  assert.equal(learning.cleanReady(' 06:30 '), '06:30');
  assert.equal(learning.cleanReady('-'), 'none');
  assert.equal(learning.cleanReady('Geen'), 'none');
  assert.equal(learning.cleanReady(''), null);
  assert.equal(learning.cleanReady('24:00'), null);
  assert.equal(learning.cleanReady('ochtend'), null);
});

test('one day: your time goes first — also on a day off — and "none" skips that day', () => {
  const stats = learning.departureStats(sessions, { tz, nowMs: now, halfLifeDays: 1e6 });
  assert.equal(stats[0].ready, '07:15', 'learned on Mondays');
  // today (Monday) moved to 08:00
  let n = learning.nextReadyTime(stats, now, { tz, days: { [day(now)]: { ready: '08:00' } } });
  assert.equal(new Date(n.at).toISOString(), '2026-08-10T08:00:00.000Z');
  assert.equal(n.source, 'day');
  // a day off is skipped, but not when you set a time for it
  const skip = () => true;
  assert.equal(learning.nextReadyTime(stats, now, { tz, skip }), null);
  assert.equal(learning.nextReadyTime(stats, now, { tz, skip, days: { [day(now)]: { ready: '08:00' } } }).source, 'day');
  // no departure today: next Monday's learned time
  n = learning.nextReadyTime(stats, now, { tz, days: { [day(now)]: { ready: 'none' } } });
  assert.equal(new Date(n.at).toISOString(), '2026-08-17T07:15:00.000Z');
  assert.equal(n.source, 'learned');
  // the corrections can also come along with the stats (learnedDepartures does that)
  stats.days = { [day(now)]: { ready: 'none' } };
  assert.equal(new Date(learning.nextReadyTime(stats, now, { tz }).at).toISOString(), '2026-08-17T07:15:00.000Z');
});

test('every week: your own time, or no usual departure on that weekday', () => {
  let stats = learning.departureStats(sessions, { tz, nowMs: now, overrides: { mon: '06:45' }, halfLifeDays: 1e6 });
  assert.equal(stats[0].ready, '06:45');
  assert.equal(stats[0].learnedReady, '07:15');
  stats = learning.departureStats(sessions, { tz, nowMs: now, overrides: { mon: 'none' }, halfLifeDays: 1e6 });
  assert.equal(stats[0].ready, null);
  assert.equal(stats[0].override, 'none');
  assert.equal(learning.nextReadyTime(stats, now, { tz }), null, 'no weekday with a departure left');
});

test('a corrected day that has passed counts for what it learns; a real departure goes first', () => {
  // Tuesdays: never charged before a departure — you said three times it left at 06:00 (ready 05:45)
  const tue = (w) => day(base + D + w * 7 * D);
  const days = { [tue(7)]: { ready: '05:45' }, [tue(8)]: { ready: '05:45' }, [tue(9)]: { ready: '05:45' } };
  const stats = learning.departureStats(sessions, { tz, nowMs: now, days, halfLifeDays: 1e6 });
  assert.equal(stats[1].corrected, 3);
  assert.equal(stats[1].n, 3);
  // three of the ten Tuesdays: not "usual" (under 40%) — but on a Monday a correction can't push out a real departure
  const mon = day(base + 9 * 7 * D);
  const s2 = learning.departureStats(sessions, { tz, nowMs: now, days: { [mon]: { ready: '05:00' } }, halfLifeDays: 1e6 });
  assert.equal(s2[0].corrected, 0, 'that Monday it really left at 07:30');
  assert.equal(s2[0].n, 10);
  // a day still to come doesn't count yet
  const s3 = learning.departureStats(sessions, { tz, nowMs: now, days: { [day(now + D)]: { ready: '05:45' } }, halfLifeDays: 1e6 });
  assert.equal(s3[1].corrected, 0);
});

test('correctionHint: the same change on a weekday twice or more is worth setting for every week', () => {
  const tue = (w) => day(base + D + w * 7 * D);
  assert.deepEqual(learning.correctionHint({ [tue(8)]: { ready: '07:30' }, [tue(9)]: { ready: '07:40' } }, 1, { tz, nowMs: now }), { ready: '07:35', n: 2 });
  assert.equal(learning.correctionHint({ [tue(8)]: { ready: '07:30' }, [tue(9)]: { ready: '09:00' } }, 1, { tz, nowMs: now }), null, 'too far apart');
  assert.deepEqual(learning.correctionHint({ [tue(8)]: { ready: 'none' }, [tue(9)]: { ready: 'none' } }, 1, { tz, nowMs: now }), { ready: 'none', n: 2 });
  assert.equal(learning.correctionHint({ [tue(9)]: { ready: 'none' } }, 1, { tz, nowMs: now }), null, 'once is not a habit');
  assert.equal(learning.correctionHint({ [tue(8)]: { ready: '07:30' }, [tue(9)]: { ready: '07:40' } }, 0, { tz, nowMs: now }), null, 'another weekday');
});
