// "Schedule command" on the Client Activity page (routes/incoming.js) — lets a device (e.g. a
// Shelly) get one already-known MQTT command (picked from the Common Commands catalog at creation
// time) re-sent on a repeating schedule, entirely opt-in per device/command. Same self-rescheduling
// setTimeout shape as backup.js's own scheduler (see its own comment on why: setTimeout's delay is
// a 32-bit int, capping out around 24.8 days, so a far-future due time is re-checked at least daily
// rather than risking a single overflowing wait) — generalized here to track the SOONEST due time
// across every enabled row, not just one.
const cronParser = require('cron-parser');
const db = require('./db');
const mqttClient = require('./mqttClient');
const { getDisplayTimezone } = require('./dateFormat');

const INTERVAL_TYPES = ['daily', 'every_n_days', 'weekly'];

async function listSchedules() {
  return db.prepare('SELECT * FROM scheduled_device_commands ORDER BY device_key, id').all();
}

async function listSchedulesForDevice(deviceKey) {
  return db.prepare('SELECT * FROM scheduled_device_commands WHERE device_key = ? ORDER BY id').all(deviceKey);
}

async function getSchedule(id) {
  return db.prepare('SELECT * FROM scheduled_device_commands WHERE id = ?').get(id);
}

function validateScheduleTiming(fields) {
  if (!INTERVAL_TYPES.includes(fields.interval_type)) throw new Error('Unknown schedule type.');
  if (!/^\d{2}:\d{2}$/.test(fields.time_of_day || '')) throw new Error('Time of day must be HH:MM.');
  if (fields.interval_type === 'every_n_days') {
    const days = Number(fields.interval_days);
    if (!Number.isInteger(days) || days < 1) throw new Error('Enter how many days apart to repeat (1 or more).');
  }
  if (fields.interval_type === 'weekly') {
    const days = (fields.weekdays || '').split(',').map((d) => d.trim()).filter(Boolean);
    if (!days.length || days.some((d) => !/^[0-6]$/.test(d))) throw new Error('Pick at least one day of the week.');
  }
}

function validateSchedule(fields) {
  if (!fields.device_key) throw new Error('Device is required.');
  if (!fields.family_key) throw new Error('Device family is required.');
  if (!fields.command_label || !fields.mqtt_topic || fields.mqtt_payload == null) throw new Error('Command is required.');
  validateScheduleTiming(fields);
}

async function createSchedule(fields) {
  validateSchedule(fields);
  const now = new Date().toISOString();
  const id = await db.insertReturningId(
    `INSERT INTO scheduled_device_commands
       (device_key, family_key, command_label, mqtt_topic, mqtt_payload, interval_type, interval_days, weekdays, time_of_day, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      fields.device_key, fields.family_key, fields.command_label, fields.mqtt_topic, fields.mqtt_payload,
      fields.interval_type, fields.interval_type === 'every_n_days' ? Number(fields.interval_days) : null,
      fields.interval_type === 'weekly' ? fields.weekdays : null, fields.time_of_day, now,
    ]
  );
  await rescheduleNext();
  return id;
}

// Only the SCHEDULE half (when/how often it fires) is editable in place — device_key/family_key/
// command_label/mqtt_topic/mqtt_payload stay exactly what they were when the schedule was created.
// Changing WHAT gets sent is close enough to "a different schedule" (a new device/command combo,
// possibly a completely different topic) that delete-and-recreate — already fully supported — is
// the more honest action for that, rather than an edit form quietly repointing an existing row at
// something else entirely.
async function updateSchedule(id, fields) {
  validateScheduleTiming(fields);
  await db.prepare(
    'UPDATE scheduled_device_commands SET interval_type = ?, interval_days = ?, weekdays = ?, time_of_day = ? WHERE id = ?'
  ).run(
    fields.interval_type,
    fields.interval_type === 'every_n_days' ? Number(fields.interval_days) : null,
    fields.interval_type === 'weekly' ? fields.weekdays : null,
    fields.time_of_day,
    id
  );
  await rescheduleNext();
}

async function setEnabled(id, enabled) {
  await db.prepare('UPDATE scheduled_device_commands SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  await rescheduleNext();
}

async function deleteSchedule(id) {
  await db.prepare('DELETE FROM scheduled_device_commands WHERE id = ?').run(id);
  await rescheduleNext();
}

function publishCommand(topic, payload) {
  return new Promise((resolve, reject) => {
    const client = mqttClient.getClient();
    if (!client) { reject(new Error('MQTT broker is not connected.')); return; }
    client.publish(topic, payload, { qos: 0, retain: false }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function executeSchedule(schedule) {
  const nowIso = new Date().toISOString();
  try {
    await publishCommand(schedule.mqtt_topic, schedule.mqtt_payload);
    await db.prepare('UPDATE scheduled_device_commands SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?')
      .run(nowIso, 'ok', null, schedule.id);
  } catch (err) {
    await db.prepare('UPDATE scheduled_device_commands SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?')
      .run(nowIso, 'error', err.message, schedule.id);
  }
}

// Backs the list page's own "Run now" button — fires immediately regardless of the actual
// schedule, same "prove it actually works before you trust it to run unattended at 1am" reasoning
// as the Backups page's own manual "Backup now". Reschedules afterward since this also moves an
// every_n_days row's own anchor (its last_run_at), which changes when it's next actually due.
async function runNow(id) {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found.');
  await executeSchedule(schedule);
  await rescheduleNext();
}

// Same "prove it actually works" idea as runNow above, but for the Add-schedule form itself —
// before a schedule even exists to save, this fires the currently-picked device/command combo
// once so a typo'd device id or a command that doesn't actually do anything on this specific
// device gets caught right there, not after committing to a recurring schedule for it. No DB row
// involved at all — nothing to update last_run_at/last_status on, unlike runNow.
async function testSend(topic, payload) {
  await publishCommand(topic, payload);
}

// A daily/weekly schedule maps directly onto a standard 5-field cron expression, so next-run is
// just handed to cron-parser (tz-aware — handles DST transitions correctly, which hand-rolled
// date math around a timezone name easily gets wrong). "Every N days" has no such direct mapping —
// cron's own day-of-month stepping (`*/N`) resets at the 1st of every calendar month rather than
// counting N days from whenever this schedule last actually ran — so that one still anchors off
// last_run_at (or created_at, before it's ever run once) and steps forward day-chunk by day-chunk.
function nextCronRun(hh, mm, dowCsv, tz, now) {
  const cronExpr = `${mm} ${hh} * * ${dowCsv || '*'}`;
  try {
    return cronParser.parseExpression(cronExpr, { tz, currentDate: now }).next().toDate();
  } catch (err) {
    return null;
  }
}

// Steps forward in whole-day chunks from `anchor`, re-anchoring each step to the EXACT HH:MM
// instant (in `tz`) via cron-parser rather than trusting raw millisecond addition — a plain
// `+ n*86400000` would drift by an hour across a DST transition, since a "day" isn't always
// exactly 86400000ms in local wall-clock terms. The 3650-step cap is just a safety net (a decade
// of daily stepping, the worst case for interval_days=1) so a corrupt/ancient anchor can never
// spin this forever.
function nextEveryNDaysRun(hh, mm, intervalDays, anchor, tz, now) {
  const days = Math.max(1, Number(intervalDays) || 1);
  let candidate = anchor;
  for (let i = 0; i < 3650; i++) {
    const roughMs = candidate.getTime() + days * 86400000;
    const justBefore = new Date(roughMs - 12 * 3600000);
    let exact;
    try {
      exact = cronParser.parseExpression(`${mm} ${hh} * * *`, { tz, currentDate: justBefore }).next().toDate();
    } catch (err) {
      return null;
    }
    if (exact.getTime() > now.getTime()) return exact;
    candidate = exact;
  }
  return null;
}

function computeNextRun(schedule, tz, now) {
  const [hh, mm] = (schedule.time_of_day || '00:00').split(':').map(Number);
  if (schedule.interval_type === 'daily') return nextCronRun(hh, mm, null, tz, now);
  if (schedule.interval_type === 'weekly') return schedule.weekdays ? nextCronRun(hh, mm, schedule.weekdays, tz, now) : null;
  if (schedule.interval_type === 'every_n_days') {
    const anchor = new Date(schedule.last_run_at || schedule.created_at);
    if (Number.isNaN(anchor.getTime())) return null;
    return nextEveryNDaysRun(hh, mm, schedule.interval_days, anchor, tz, now);
  }
  return null;
}

let scheduledTimer = null;

async function scheduleNext() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;

  const schedules = (await db.prepare('SELECT * FROM scheduled_device_commands WHERE enabled = 1').all());
  if (!schedules.length) return; // nothing enabled — rescheduleNext() kicks this off again once one is created/re-enabled

  const tz = getDisplayTimezone();
  const now = new Date();
  const due = schedules
    .map((schedule) => ({ schedule, nextRun: computeNextRun(schedule, tz, now) }))
    .filter((x) => {
      if (x.nextRun) return true;
      console.error(`Scheduled command #${x.schedule.id} (${x.schedule.device_key}) has an invalid schedule — skipping.`);
      return false;
    })
    .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime());
  if (!due.length) return;
  const soonest = due[0];

  const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
  const msUntilRun = soonest.nextRun.getTime() - now.getTime();
  const isActualRun = msUntilRun <= MAX_DELAY_MS;
  const delay = Math.max(Math.min(msUntilRun, MAX_DELAY_MS), 1000);

  scheduledTimer = setTimeout(async () => {
    if (isActualRun) await executeSchedule(soonest.schedule);
    scheduleNext();
  }, delay);
}

function startScheduler() {
  scheduleNext();
}

// Called after any create/enable/disable/delete/run-now so a change takes effect immediately
// instead of waiting for the next daily re-check (see scheduleNext's own MAX_DELAY_MS comment).
async function rescheduleNext() {
  await scheduleNext();
}

module.exports = {
  listSchedules,
  listSchedulesForDevice,
  getSchedule,
  createSchedule,
  updateSchedule,
  setEnabled,
  deleteSchedule,
  runNow,
  testSend,
  computeNextRun,
  startScheduler,
  rescheduleNext,
};
