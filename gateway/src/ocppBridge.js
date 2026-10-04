// OCPP bridge: makes a Loxone Wallbox show up at an OCPP 1.6 backend (Laadloon, a CPO's CSMS, ...)
// by reading the Wallbox's live states over the Miniserver websocket LoxSuite already keeps open
// (loxoneWebSocket.js) and speaking OCPP-J 1.6 as a charge point itself.
//
// Why this exists instead of Loxone's own OCPP Server Connector: that connector needs the Wallbox
// block and its Charging Point on the SAME current-generation Miniserver. A Wallbox on a Gen 1
// client of a Gen 2 gateway can't be linked through a memory flag, so the Charging Point reports
// "Wallbox Offline / Selfcheck Failed" and never sends a session (verified against a real install,
// see migration 018). The Gen 2's websocket does deliver that Wallbox's states though, so this
// module turns them into BootNotification / StatusNotification / Start- / Stop-Transaction /
// MeterValues itself.
//
// It identifies itself honestly (vendor "Loxone", model "WallboxTree-LoxSuite") — the backend
// should know the data comes through LoxSuite rather than Loxone's own connector.
//
// Session semantics mirror Loxone's own Wallbox session log: a transaction starts when a car is
// plugged in (`connected` 0 -> 1) and stops when it's unplugged. The stop is deliberately delayed
// (stop_delay_s, default 90s): the Wallbox's `total` (MID meter) state only updates about once a
// minute, so stopping immediately would under-report the last part of the session (seen in
// testing: 0.033 kWh arrived after an immediate stop).
//
// Transaction messages go through a persistent queue (ocpp_bridges.state_json) so a backend outage
// or a LoxSuite restart never loses a Start/Stop; plain status/heartbeat messages are not queued.
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('./db');
const { decrypt } = require('./secretCrypto');
const loxoneWebSocket = require('./loxoneWebSocket');
const loxoneStructure = require('./loxoneStructure');
const { logSystemEvent } = require('./auditLog');
const { version: packageVersion } = require('../package.json');

const RESCAN_MS = 30 * 1000;
const POLL_MS = 2000;
const LOG_MAX = 300;
const RECONNECT_MS = 15 * 1000;
const CALL_TIMEOUT_MS = 30 * 1000;
const WATCH = ['connected', 'active', 'actual', 'total', 'session'];

const runners = new Map(); // bridge id -> BridgeRunner

// ------------------------------------------------------------------ pure helpers (unit tested)

// OCPP 1.6 connector status for the current Wallbox state.
function wallboxStatus({ connected, active }, hasTransaction) {
  if (Number(connected) !== 1) return 'Available';
  if (Number(active) === 1) return 'Charging';
  return hasTransaction ? 'SuspendedEVSE' : 'Preparing';
}

// GetConfiguration.conf for the keys asked (all known keys when none asked); unknown ones are
// reported back as unknownKey, as the spec requires.
function getConfigurationReply(askedKeys, known) {
  const asked = Array.isArray(askedKeys) && askedKeys.length ? askedKeys : Object.keys(known);
  return {
    configurationKey: asked.filter((k) => known[k]).map((k) => ({ key: k, ...known[k] })),
    unknownKey: asked.filter((k) => !known[k]),
  };
}

// Loxone NFC tag text ("EC B0 2B 05 8D 41 4C 27 EC") -> OCPP idTag ("B02B058D414C27"): hex only,
// uppercase, without the "EC" specifier and trailing zero bytes — the same normalisation Loxone's
// own OCPP connector documents for NFC IDs. Capped at OCPP 1.6's 20 characters.
function normalizeNfcTag(raw) {
  let hex = String(raw || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length > 4 && hex.startsWith('EC') && hex.endsWith('EC')) hex = hex.slice(2, -2);
  else if (hex.length > 2 && hex.startsWith('EC')) hex = hex.slice(2);
  while (hex.length > 2 && hex.endsWith('00')) hex = hex.slice(0, -2);
  return hex.slice(0, 20);
}

// "Dave Rutten = B02B058D414C27" lines -> Map(lowercased user -> tag). Also accepts ':'.
function parseUserTagMap(text) {
  const map = new Map();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = /^\s*(.+?)\s*[=:]\s*(\S+)\s*$/.exec(line);
    if (m) map.set(m[1].toLowerCase(), m[2].slice(0, 20));
  });
  return map;
}

// Decides the idTag for a session. Returns { tag, source } or null while still waiting for an
// authorization from Loxone (auto mode only, until `force`, i.e. timeout / charging / unplug).
function resolveIdTag({ mode, fixedTag, nfc, sessionUser, userMap, sessionStart, force }) {
  if (mode !== 'auto') return { tag: fixedTag, source: 'fixed' };
  // An NFC read up to 2 minutes before plug-in still counts (badge first, then plug in).
  if (nfc && nfc.tag && nfc.at >= sessionStart - 120000) {
    const tag = normalizeNfcTag(nfc.tag);
    if (tag) return { tag, source: 'nfc' };
  }
  if (sessionUser && userMap && userMap.has(String(sessionUser).toLowerCase())) {
    return { tag: userMap.get(String(sessionUser).toLowerCase()), source: 'user' };
  }
  return force ? { tag: fixedTag, source: 'fallback' } : null;
}

function emptyState(mode) {
  return { mode, tx: null, queue: [], txMap: {}, nextLocalId: 1 };
}

// Restores persisted state, discarding it when it was written in the other mode — a dry-run
// transaction (with a fake transaction id) must never leak into a live backend, or vice versa.
function restoreState(json, mode) {
  let s;
  try { s = json ? JSON.parse(json) : null; } catch { s = null; }
  if (!s || s.mode !== mode) return emptyState(mode);
  return { ...emptyState(mode), ...s };
}

const toWh = (kwh) => Math.round(Number(kwh || 0) * 1000);

// ------------------------------------------------------------------ runner

class BridgeRunner {
  constructor(row, miniserver) {
    this.row = row;
    this.miniserver = miniserver;
    this.mode = row.mode === 'live' ? 'live' : 'dry';
    this.state = restoreState(row.state_json, this.mode);
    this.logLines = [];
    this.values = {};
    this.stateUuids = {};
    this.ready = false;
    this.ws = null;
    this.ocppOpen = false;
    this.booted = false;
    this.pending = new Map();
    this.timers = [];
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.stopTimer = null;
    this.flushing = false;
    this.lastStatus = null;
    this.lastSessionEnergy = null;
    this.sessionUser = null;
    this.nfcSeen = null;
    this.authTimer = null;
    this.userMap = parseUserTagMap(row.user_tag_map);
    this.lastError = null;
    this.fakeTxId = 9000;
    this.destroyed = false;
    this.password = row.password ? decrypt(row.password) : '';
  }

  log(kind, data = {}) {
    this.logLines.push({ ts: new Date().toISOString(), kind, ...data });
    if (this.logLines.length > LOG_MAX) this.logLines.splice(0, this.logLines.length - LOG_MAX);
  }

  async persist() {
    try {
      await db.prepare('UPDATE ocpp_bridges SET state_json = ? WHERE id = ?').run(JSON.stringify(this.state), this.row.id);
    } catch (err) {
      this.log('db-error', { error: err.message });
    }
  }

  async start() {
    this.log('started', { mode: this.mode, ocpp: this.mode === 'live' ? `${this.row.server_url}/${this.row.charge_point_id}` : '(dry run: nothing is sent)' });
    loxoneWebSocket.ensureConnection(this.miniserver);
    await this.resolveStates();
    this.timers.push(setInterval(() => this.poll(), POLL_MS));
    this.timers.push(setInterval(() => this.sendMeterValues(), Math.max(10, this.row.meter_interval_s) * 1000));
    this.timers.forEach((t) => t.unref?.());
    this.connectOcpp();
  }

  async resolveStates() {
    try {
      const structure = await loxoneStructure.getStructure(this.miniserver);
      const ctl = structure.controls?.[this.row.control_uuid];
      if (!ctl) throw new Error(`Wallbox ${this.row.control_uuid} not found in the structure of ${this.miniserver.name}`);
      for (const name of WATCH) if (ctl.states?.[name]) this.stateUuids[name] = ctl.states[name];
      this.log('wallbox-found', { name: ctl.name, type: ctl.type });
      if (this.row.id_tag_mode === 'auto' && this.row.nfc_control_uuid) {
        const nfc = structure.controls?.[this.row.nfc_control_uuid];
        if (nfc) {
          for (const name of ['lasttag', 'lastid', 'lastuser']) if (nfc.states?.[name]) this.stateUuids[`nfc_${name}`] = nfc.states[name];
          this.log('nfc-found', { name: nfc.name });
        } else {
          this.log('nfc-error', { error: `NFC Code Touch ${this.row.nfc_control_uuid} not found` });
        }
      }
    } catch (err) {
      this.lastError = err.message;
      this.log('wallbox-error', { error: err.message });
      const t = setTimeout(() => { if (!this.destroyed) this.resolveStates(); }, RECONNECT_MS);
      t.unref?.();
    }
  }

  destroy() {
    this.destroyed = true;
    this.timers.forEach(clearInterval);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stopTimer);
    clearTimeout(this.authTimer);
    try { this.ws?.close(1000, 'LoxSuite stopping'); } catch { /* already closing */ }
  }

  // Graceful stop for a container restart/shutdown: save the state (running transaction, unsent
  // queue) and close the OCPP connection with a normal 1000 close instead of letting the socket die
  // with the process (the backend would see an abnormal 1006 and may keep a stale connection for
  // this ChargePoint ID around, which is what made Laadloon answer 1011 earlier). A session whose
  // stop delay was still running is NOT stopped here: the last MID reading may not be in yet, so it
  // stays open and is closed after the restart with Loxone's own unplug time (see onChange).
  async shutdown(timeoutMs = 2000) {
    const ws = this.ws;
    const wasOpen = ws && ws.readyState === WebSocket.OPEN;
    await this.persist();
    this.log('shutdown', { msg: this.stopTimer ? 'session stop still pending; finished after the restart' : 'state saved', ocpp: wasOpen ? 'closing' : 'not connected' });
    const closed = wasOpen ? new Promise((resolve) => { ws.once('close', resolve); }) : Promise.resolve();
    this.destroy();
    if (wasOpen) {
      await Promise.race([closed, new Promise((resolve) => { const t = setTimeout(resolve, timeoutMs); t.unref?.(); })]);
      if (ws.readyState !== WebSocket.CLOSED) { try { ws.terminate(); } catch { /* gone */ } }
    }
  }

  // ---------------- Loxone side

  poll() {
    for (const [name, uuid] of Object.entries(this.stateUuids)) {
      const v = loxoneWebSocket.getLiveValue(this.miniserver.id, uuid);
      if (v === undefined) continue;
      if (this.values[name] !== v) {
        const old = this.values[name];
        this.values[name] = v;
        this.onChange(name, v, old);
      }
    }
  }

  onChange(name, value, old) {
    if (name === 'session' && value) {
      try {
        const sess = JSON.parse(value);
        this.lastSessionEnergy = sess.energy;
        this.lastSessionDisconnect = Number(sess.disconnect) || 0; // epoch s of the last unplug, 0 while plugged in
        if (sess.user && sess.user !== this.sessionUser) { this.sessionUser = sess.user; this.log('loxone-user', { user: sess.user }); }
      } catch { /* not JSON */ }
    }
    if (name.startsWith('nfc_')) {
      if (value && (name === 'nfc_lasttag' || name === 'nfc_lastid')) {
        this.nfcSeen = { tag: String(value), at: Date.now() };
        this.log('nfc-tag', { raw: String(value), idTag: normalizeNfcTag(value) });
      }
      if (this.state.tx?.pendingStart) this.tryStartTransaction(false);
      return;
    }
    if (name === 'session' && this.state.tx?.pendingStart) this.tryStartTransaction(false);
    if (!['total', 'actual', 'session'].includes(name)) this.log('wallbox', { [name]: value, was: old });
    if (!this.ready) {
      if (['connected', 'active', 'total'].every((k) => this.values[k] !== undefined)) {
        this.ready = true;
        this.log('wallbox-state', { connected: this.values.connected, active: this.values.active, total_kWh: this.values.total });
        if (this.state.tx && Number(this.values.connected) !== 1) {
          // The session state may simply not have been polled yet in this round: read it now.
          if (this.values.session === undefined && this.stateUuids.session) {
            const sv = loxoneWebSocket.getLiveValue(this.miniserver.id, this.stateUuids.session);
            if (sv !== undefined) { this.values.session = sv; this.onChange('session', sv, undefined); }
          }
          // Unplugged while LoxSuite was down (a restart, or a stop still in its delay window at
          // shutdown): close the session at the moment Loxone saw the unplug, not at restart time.
          const at = unplugTimeDuringDowntime(this.state.tx.startedAt, this.lastSessionDisconnect);
          this.log('note', { msg: at ? `car was unplugged at ${at} while LoxSuite was down` : 'car was unplugged while LoxSuite was down' });
          this.stopTx(at ? 'EVDisconnected' : 'Other', this.lastSessionEnergy ?? null, at);
        }
        else if (this.state.tx?.pendingStart) this.scheduleAuthTimeout();
        if (!this.state.tx && Number(this.values.connected) === 1) {
          this.log('note', { msg: 'car was already plugged in at start; that session is not reported' });
        }
        this.sendStatus(true);
      }
      return;
    }
    if (name === 'connected') {
      if (Number(value) === 1) {
        if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; } // quick re-plug: same session
        this.startTx();
      } else if (this.state.tx && !this.stopTimer) {
        const energyLoxone = this.lastSessionEnergy;
        this.log('car unplugged', { msg: `session stops in ${this.row.stop_delay_s}s`, loxoneSessionEnergy_kWh: energyLoxone });
        this.stopTimer = setTimeout(() => { this.stopTimer = null; this.stopTx('EVDisconnected', energyLoxone); }, Math.max(0, this.row.stop_delay_s) * 1000);
      }
    }
    if (name === 'connected' || name === 'active') this.sendStatus();
  }

  // ---------------- sessions

  startTx() {
    if (this.state.tx) return;
    const localId = this.state.nextLocalId++;
    const meterStart = toWh(this.values.total);
    const startedAt = new Date().toISOString();
    this.sessionUser = null;
    this.state.tx = { localId, meterStart, startedAt, pendingStart: true, idTag: null };
    this.log('SESSION START', { meterStart_kWh: meterStart / 1000 });
    db.prepare('INSERT INTO ocpp_bridge_sessions (bridge_id, local_id, mode, started_at, meter_start_wh) VALUES (?, ?, ?, ?, ?)')
      .run(this.row.id, localId, this.mode, startedAt, meterStart).catch((e) => this.log('db-error', { error: e.message }));
    this.persist();
    if (!this.tryStartTransaction(false)) {
      this.log('id-tag', { msg: `waiting up to ${this.row.auth_wait_s}s for an NFC tag or Loxone user` });
      this.scheduleAuthTimeout();
    }
  }

  scheduleAuthTimeout() {
    clearTimeout(this.authTimer);
    const tx = this.state.tx;
    if (!tx) return;
    const left = Math.max(0, Date.parse(tx.startedAt) + Math.max(0, Number(this.row.auth_wait_s) || 0) * 1000 - Date.now());
    this.authTimer = setTimeout(() => this.tryStartTransaction(true), left);
    this.authTimer.unref?.();
  }

  // Sends StartTransaction once the idTag is known (or `force`d to the fallback). Its timestamp and
  // meterStart stay those of the plug-in, however long the authorization took. Returns true once sent.
  tryStartTransaction(force) {
    const tx = this.state.tx;
    if (!tx || !tx.pendingStart) return !!tx;
    const decision = resolveIdTag({
      mode: this.row.id_tag_mode, fixedTag: this.row.id_tag, nfc: this.nfcSeen, sessionUser: this.sessionUser,
      userMap: this.userMap, sessionStart: Date.parse(tx.startedAt), force,
    });
    if (!decision) return false;
    clearTimeout(this.authTimer);
    tx.pendingStart = false;
    tx.idTag = decision.tag;
    tx.idTagSource = decision.source;
    this.log('id-tag', { idTag: decision.tag, source: decision.source });
    // Which car is this (Vehicles: NFC tags / Loxone users per car)? A car set to not report its
    // sessions (e.g. the private one next to the company car) is recorded but never sent.
    let vehicle = null;
    try {
      vehicle = require('./vehicles').identifyVehicleCached({
        idTag: ['nfc', 'user'].includes(decision.source) ? decision.tag : null, loxoneUser: this.sessionUser,
      });
    } catch { vehicle = null; }
    tx.vehicleId = vehicle?.id ?? null;
    tx.skip = !!(vehicle && vehicle.ocpp_report === 0);
    if (vehicle) this.log('vehicle', { name: vehicle.name, reported: !tx.skip });
    db.prepare('UPDATE ocpp_bridge_sessions SET id_tag = ?, id_tag_source = ?, vehicle_id = ? WHERE bridge_id = ? AND local_id = ? AND mode = ?')
      .run(decision.tag, decision.source, tx.vehicleId, this.row.id, tx.localId, this.mode).catch(() => {});
    if (tx.skip) {
      this.log('not reported', { msg: `${vehicle.name} is set to not report its sessions over OCPP` });
      return true;
    }
    this.enqueue('StartTransaction', { connectorId: 1, idTag: decision.tag, meterStart: tx.meterStart, timestamp: tx.startedAt }, tx.localId);
    return true;
  }

  stopTx(reason, energyLoxone, at = null) {
    const tx = this.state.tx;
    if (!tx) return;
    if (tx.pendingStart) this.tryStartTransaction(true); // unplugged before any authorization arrived
    const meterStop = toWh(this.values.total);
    const ts = at || new Date().toISOString();
    this.log('SESSION STOP', { charged_kWh: (meterStop - tx.meterStart) / 1000, loxone_kWh: energyLoxone, reason });
    db.prepare('UPDATE ocpp_bridge_sessions SET stopped_at = ?, meter_stop_wh = ?, energy_loxone_kwh = ?, stop_reason = ? WHERE bridge_id = ? AND local_id = ? AND mode = ?')
      .run(ts, meterStop, energyLoxone ?? null, reason, this.row.id, tx.localId, this.mode).catch((e) => this.log('db-error', { error: e.message }));
    logSystemEvent(`OCPP bridge "${this.row.name}": session stopped, ${((meterStop - tx.meterStart) / 1000).toFixed(3)} kWh (${this.mode})`).catch(() => {});
    if (tx.skip) {
      this.state.tx = null;
      this.persist();
      this.sendStatus();
      return;
    }
    this.enqueue('StopTransaction', {
      idTag: tx.idTag || this.row.id_tag, meterStop, timestamp: ts, reason,
      transactionData: [{ timestamp: ts, sampledValue: [{ value: String(meterStop), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context: 'Transaction.End' }] }],
    }, tx.localId);
    this.state.tx = null;
    this.persist();
    this.sendStatus();
  }

  sendMeterValues() {
    if (!this.state.tx || this.state.tx.pendingStart || this.state.tx.skip || this.values.total === undefined) return;
    this.enqueue('MeterValues', { connectorId: 1, meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [
      { value: String(toWh(this.values.total)), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context: 'Sample.Periodic' },
      { value: String(toWh(this.values.actual)), measurand: 'Power.Active.Import', unit: 'W', context: 'Sample.Periodic' },
    ] }] }, this.state.tx.localId);
  }

  sendStatus(force = false) {
    const status = wallboxStatus(this.values, !!this.state.tx);
    if (!force && status === this.lastStatus) return;
    this.lastStatus = status;
    if (this.booted) {
      this.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status, timestamp: new Date().toISOString() })
        .catch((e) => this.log('status-error', { error: e.message }));
    }
  }

  // ---------------- queue

  enqueue(action, payload, localTx) {
    this.state.queue.push({ action, payload, localTx });
    this.persist();
    this.flushQueue();
  }

  async flushQueue() {
    if (this.flushing || !this.booted) return;
    this.flushing = true;
    try {
      while (this.state.queue.length && !this.destroyed) {
        const item = this.state.queue[0];
        const payload = { ...item.payload };
        if (item.action !== 'StartTransaction') {
          const txId = this.state.txMap[item.localTx];
          if (txId === undefined) { this.log('queue', { msg: 'waiting for transactionId', action: item.action }); break; }
          payload.transactionId = txId;
        }
        const res = await this.call(item.action, payload);
        if (item.action === 'StartTransaction') {
          this.state.txMap[item.localTx] = res.transactionId;
          this.log('transaction-started', { transactionId: res.transactionId, idTagStatus: res.idTagInfo?.status });
          db.prepare('UPDATE ocpp_bridge_sessions SET transaction_id = ? WHERE bridge_id = ? AND local_id = ? AND mode = ?')
            .run(res.transactionId, this.row.id, item.localTx, this.mode).catch(() => {});
          if (res.idTagInfo?.status && res.idTagInfo.status !== 'Accepted') {
            logSystemEvent(`OCPP bridge "${this.row.name}": backend answered idTag status ${res.idTagInfo.status}`).catch(() => {});
          }
        }
        if (item.action === 'StopTransaction') delete this.state.txMap[item.localTx];
        this.state.queue.shift();
        await this.persist();
      }
    } catch (err) {
      this.lastError = err.message;
      this.log('queue-error', { error: err.message, stillQueued: this.state.queue.length });
    } finally {
      this.flushing = false;
    }
  }

  // ---------------- OCPP side

  call(action, payload) {
    if (this.mode !== 'live') {
      this.log('[DRY] would send', { action, payload });
      if (action === 'StartTransaction') return Promise.resolve({ transactionId: ++this.fakeTxId, idTagInfo: { status: 'Accepted' } });
      if (action === 'BootNotification') return Promise.resolve({ status: 'Accepted', interval: 300 });
      return Promise.resolve({});
    }
    return new Promise((resolve, reject) => {
      if (!this.ocppOpen) { reject(new Error('OCPP not connected')); return; }
      const id = crypto.randomUUID();
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout waiting for ${action}`)); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      const msg = [2, id, action, payload];
      this.ws.send(JSON.stringify(msg));
      this.log('->ocpp', { msg });
    });
  }

  reply(id, payload) { const m = [3, id, payload]; this.ws.send(JSON.stringify(m)); this.log('->ocpp', { msg: m }); }
  replyError(id, code, desc) { const m = [4, id, code, desc, {}]; this.ws.send(JSON.stringify(m)); this.log('->ocpp', { msg: m }); }

  handleServerCall(id, action, payload) {
    switch (action) {
      case 'GetConfiguration':
        return this.reply(id, getConfigurationReply(payload?.key, {
          HeartbeatInterval: { readonly: false, value: String(this.heartbeatS || 300) },
          MeterValueSampleInterval: { readonly: true, value: String(this.row.meter_interval_s) },
          MeterValuesSampledData: { readonly: true, value: 'Energy.Active.Import.Register,Power.Active.Import' },
          NumberOfConnectors: { readonly: true, value: '1' },
        }));
      case 'ChangeConfiguration':
        if (payload?.key === 'HeartbeatInterval') { this.startHeartbeat(Number(payload.value)); return this.reply(id, { status: 'Accepted' }); }
        return this.reply(id, { status: 'NotSupported' });
      case 'TriggerMessage':
        this.reply(id, { status: 'Accepted' });
        if (payload?.requestedMessage === 'StatusNotification') this.sendStatus(true);
        else if (payload?.requestedMessage === 'Heartbeat') this.call('Heartbeat', {}).catch(() => {});
        else if (payload?.requestedMessage === 'MeterValues') this.sendMeterValues();
        else if (payload?.requestedMessage === 'BootNotification') this.boot().catch(() => {});
        return undefined;
      case 'RemoteStartTransaction':
      case 'RemoteStopTransaction':
      case 'Reset':
      case 'UnlockConnector':
      case 'ChangeAvailability':
        return this.reply(id, { status: 'Rejected' });
      case 'DataTransfer':
        return this.reply(id, { status: 'UnknownVendorId' });
      default:
        return this.replyError(id, 'NotImplemented', `${action} is not supported by the LoxSuite OCPP bridge`);
    }
  }

  startHeartbeat(seconds) {
    this.heartbeatS = seconds > 0 ? seconds : 300;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.call('Heartbeat', {}).catch((e) => this.log('heartbeat-error', { error: e.message })), this.heartbeatS * 1000);
    this.heartbeatTimer.unref?.();
  }

  async boot() {
    const bootPayload = {
      chargePointVendor: 'Loxone',
      chargePointModel: 'WallboxTree-LoxSuite',
      firmwareVersion: `LoxSuite ${packageVersion}`.slice(0, 50),
      meterType: 'MID (Wallbox Tree)',
    };
    if (this.row.serial) bootPayload.chargePointSerialNumber = String(this.row.serial).slice(0, 25);
    const res = await this.call('BootNotification', bootPayload);
    this.log('boot-response', { res });
    if (res.status !== 'Accepted') {
      const t = setTimeout(() => this.boot().catch(() => {}), Math.max(10, res.interval || 60) * 1000);
      t.unref?.();
      return;
    }
    this.booted = true;
    this.lastError = null;
    if (this.mode === 'live') this.startHeartbeat(res.interval);
    await this.call('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() }).catch(() => {});
    if (this.ready) this.sendStatus(true);
    this.flushQueue();
  }

  connectOcpp() {
    if (this.destroyed) return;
    if (this.mode !== 'live') { this.boot().catch(() => {}); return; }
    const url = `${String(this.row.server_url).replace(/\/+$/, '')}/${encodeURIComponent(this.row.charge_point_id)}`;
    const headers = this.password
      ? { Authorization: 'Basic ' + Buffer.from(`${this.row.charge_point_id}:${this.password}`).toString('base64') }
      : {};
    const ws = new WebSocket(url, ['ocpp1.6'], { headers, handshakeTimeout: 15000 });
    this.ws = ws;
    ws.on('open', () => {
      this.ocppOpen = true;
      this.log('ocpp-connected', { url });
      this.boot().catch((e) => { this.lastError = e.message; this.log('boot-error', { error: e.message }); });
    });
    ws.on('unexpected-response', (_req, res) => {
      this.lastError = `Backend refused the connection (HTTP ${res.statusCode})`;
      this.log('ocpp-refused', { httpStatus: res.statusCode });
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.log('ocpp->', { msg });
      const [type, id] = msg;
      if (type === 2) { this.handleServerCall(id, msg[2], msg[3]); return; }
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (type === 3) p.resolve(msg[2]); else p.reject(new Error(`${msg[2]}: ${msg[3]}`));
    });
    ws.on('close', (code) => {
      this.ocppOpen = false;
      this.booted = false;
      clearInterval(this.heartbeatTimer);
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      this.log('ocpp-closed', { code });
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connectOcpp(), RECONNECT_MS);
        this.reconnectTimer.unref?.();
      }
    });
    ws.on('error', (err) => { this.lastError = err.message; this.log('ocpp-error', { error: err.message }); });
  }

  status() {
    return {
      mode: this.mode,
      connected: this.mode === 'live' ? this.ocppOpen : null,
      booted: this.booted,
      wallboxReady: this.ready,
      values: { connected: this.values.connected, active: this.values.active, actual: this.values.actual, total: this.values.total },
      connectorStatus: this.lastStatus,
      transaction: this.state.tx ? { ...this.state.tx, transactionId: this.state.txMap[this.state.tx.localId] ?? null } : null,
      idTagMode: this.row.id_tag_mode === 'auto' ? 'auto' : 'fixed',
      stopPending: !!this.stopTimer,
      queueLength: this.state.queue.length,
      lastError: this.lastError,
    };
  }
}

// ------------------------------------------------------------------ lifecycle

async function syncRunners() {
  let rows;
  try {
    rows = await db.prepare('SELECT * FROM ocpp_bridges').all();
  } catch {
    return; // DB not ready yet
  }
  const seen = new Set();
  for (const row of rows) {
    if (!row.enabled) continue;
    seen.add(row.id);
    const existing = runners.get(row.id);
    if (existing && existing.row.updated_at === row.updated_at) continue;
    if (existing) { existing.destroy(); runners.delete(row.id); }
    const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(row.miniserver_id);
    if (!miniserver) continue;
    const runner = new BridgeRunner(row, miniserver);
    runners.set(row.id, runner);
    runner.start().catch((err) => { runner.lastError = err.message; runner.log('start-error', { error: err.message }); });
  }
  for (const [id, runner] of runners) {
    if (!seen.has(id)) { runner.destroy(); runners.delete(id); }
  }
}

function startOcppBridges() {
  syncRunners().catch((err) => console.error('[ocppBridge] initial sync failed:', err.message));
  const timer = setInterval(() => { syncRunners().catch(() => {}); }, RESCAN_MS);
  timer.unref?.();
}

// "Test connection": opens a short-lived OCPP websocket with the bridge's saved settings and
// reports whether the backend accepts it, without sending any OCPP message. When this bridge is
// already live and connected, that running connection IS the answer — opening a second socket
// with the same ChargePoint ID would make most backends drop the first one.
async function testBackendConnection(row, timeoutMs = 10000) {
  const running = runners.get(Number(row.id));
  if (running && running.mode === 'live' && running.ocppOpen) {
    return { ok: true, ms: 0, message: running.booted ? 'Live connection is up and BootNotification was accepted.' : 'Live connection is up.' };
  }
  const password = row.password ? decrypt(row.password) : '';
  const url = `${String(row.server_url).replace(/\/+$/, '')}/${encodeURIComponent(row.charge_point_id)}`;
  const headers = password ? { Authorization: 'Basic ' + Buffer.from(`${row.charge_point_id}:${password}`).toString('base64') } : {};
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); try { ws.terminate(); } catch { /* closed */ } resolve({ ms: Date.now() - started, ...result }); };
    const ws = new WebSocket(url, ['ocpp1.6'], { headers, handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => finish({ ok: false, message: 'Timed out.' }), timeoutMs + 1000);
    ws.on('open', () => {
      // Some backends accept the socket and close it straight away for an unknown ID (policy
      // violation, 1008) — give it a moment so that counts as a failure, not a success.
      setTimeout(() => finish({ ok: true, message: `Backend accepted the connection${password ? '' : ' (no password was sent)'}.`, protocol: ws.protocol }), 1500);
    });
    ws.on('close', (code) => finish({ ok: false, message: `Backend closed the connection right away (code ${code})${code === 1008 ? ' — unknown ChargePoint ID?' : ''}.` }));
    ws.on('unexpected-response', (_req, res) => finish({ ok: false, message: `Backend refused the connection (HTTP ${res.statusCode})${res.statusCode === 401 ? ' — wrong password?' : res.statusCode === 404 ? ' — unknown ChargePoint ID?' : ''}.` }));
    ws.on('error', (err) => finish({ ok: false, message: err.message }));
  });
}

// Unplug time from the Wallbox's session state (epoch seconds) when it is plausible for this
// transaction: after its start and not in the future. ISO string, or null when unknown.
function unplugTimeDuringDowntime(startedAtIso, disconnectEpochS, nowMs = Date.now()) {
  const d = Number(disconnectEpochS);
  if (!Number.isFinite(d) || d <= 0) return null;
  const ms = d * 1000;
  const start = Date.parse(startedAtIso);
  if (!Number.isFinite(start) || ms < start || ms > nowMs + 60000) return null;
  return new Date(ms).toISOString();
}

// Called on SIGTERM (server.js): every bridge saves its state and closes its OCPP connection.
async function shutdownOcppBridges(timeoutMs = 2000) {
  const all = [...runners.values()];
  runners.clear();
  await Promise.all(all.map((r) => r.shutdown(timeoutMs).catch(() => {})));
}

function getBridgeStatus(id) {
  const r = runners.get(Number(id));
  return r ? r.status() : null;
}

function getBridgeLog(id) {
  const r = runners.get(Number(id));
  return r ? r.logLines.slice() : [];
}

module.exports = {
  startOcppBridges, syncRunners, shutdownOcppBridges, getBridgeStatus, getBridgeLog, testBackendConnection, unplugTimeDuringDowntime,
  wallboxStatus, getConfigurationReply, restoreState, normalizeNfcTag, parseUserTagMap, resolveIdTag,
};
