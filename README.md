# LoxSuite

A self-hosted Docker stack for Loxone Miniservers: an MQTT gateway, log viewing, value monitoring,
and a web UI to manage all of it — with more planned (backup/restore among it).

It provides:

- An MQTT broker (Mosquitto), with user/role management built into the web UI.
- A bidirectional bridge between MQTT and one or more Loxone Miniservers:
  - **MQTT &rarr; Loxone**: incoming MQTT messages call a Virtual Input on a Miniserver, over HTTP or UDP.
  - **Loxone &rarr; MQTT**: a Virtual Output on a Miniserver calls back into the gateway (HTTP or UDP), which
    publishes the value to MQTT.
- **Monitor**: track any MQTT topic or Loxone value over time, with charts, tables, and CSV export.
- **Logs**: live + persisted view of the Mosquitto broker log and each Miniserver's own log.
- A web interface (with login) to manage all of the above — no manual JSON or config-file editing.

## Quick start

Everything runs as a single Docker container named `loxsuite` — Mosquitto and the gateway are
still two independent processes internally (see `gateway/docker-entrypoint.sh`), but nothing
else shows up in `docker ps`/Docker Desktop. Mosquitto user management runs through the
**dynamic-security** plugin instead of a classic password file, so accounts can be added from
the web UI without restarting the broker. The entire first-boot process is automated — no
`mosquitto_ctrl` needed:

1. Copy `.env.example` to `.env` and fill in your own values — at minimum, set a real
   `MQTT_ADMIN_PASSWORD` (the broker's break-glass account):
   ```
   cp .env.example .env
   ```
2. Start the stack:
   ```
   docker compose up --build -d
   ```
   On an empty `mosquitto/config` directory, this happens automatically, in order:
   - the container's entrypoint script creates `dynamic-security.json` with the
     `MQTT_ADMIN_USERNAME`/`MQTT_ADMIN_PASSWORD` account, then starts Mosquitto with
     dynamic-security enabled;
   - the gateway (started alongside it in the same container) connects once as that admin
     account and creates the `client` role (full read/write on every topic) plus the
     `MQTT_USERNAME`/`MQTT_PASSWORD` account it uses itself;
   - the gateway's own MQTT connection (which had been retrying) then succeeds, usually within a
     few seconds.

   These steps are idempotent — restarting with an existing `dynamic-security.json` does nothing again.
3. Open the web UI at `http://<host>:3000` and log in with `ADMIN_USERNAME`/`ADMIN_PASSWORD` from
   `.env`. This web UI admin account (separate from any MQTT account) is created automatically on
   first boot.

Add new devices (e.g. a Shelly) afterwards from the **Users** page in the web UI — no CLI commands
or restarts needed.

## Features

### Dashboard

Broker connection status, active mapping counts, a **shared** panel board (the same 6 panel types
as My Dashboards below — chart/table/current value/gauge/stat with change/threshold — see that
section for details; this one is visible to everyone who logs in and editable by whoever has the
`dashboard` Access Role permission's edit checkbox, rather than by ownership), load statistics
(messages/sec, total messages, unique topics seen, connected client count), and a live status table
of every configured Miniserver.

The "Widget" button on Live Traffic pins a topic here as a current-value panel in one click,
auto-creating a monitor for that topic if one doesn't exist yet. Leave a panel's title blank and one
is generated from the topic (e.g. `shellies/shellyplug-ZWEMBADVerwarming/relay/0/power` becomes
"Zwembad Verwarming - Power") — this is a heuristic (splitting on case changes, stripping
brand/channel noise), so it won't always be perfect, especially for topics that are just an opaque


### Monitor

Track a value over time and view it as a chart and/or a raw table, with a CSV export. Two sources:

- **MQTT topic** — records every message on a topic you pick (or add one straight from the "Monitor"
  button on Live Traffic).
- **Loxone (direct, polled)** — pick a Miniserver, then a control/state from its structure export
  (`LoxAPP3.json`), and the gateway polls that value's live reading
  (`/jdev/sps/io/<uuid>`) on an interval you choose (5s&ndash;5min). This is polling, not a websocket
  push subscription — simpler to build and operate, at the cost of only-as-fresh-as-the-interval
  updates.

Readings are stored in SQLite and survive a gateway restart. Old readings are purged automatically
after a configurable retention period (default 30 days, editable on the Monitor page). A monitor's
detail page shows a line chart (Chart.js, bundled locally — no CDN) for monitors with at least one
numeric reading, plus the full raw-values table, both filterable by time range (1h/24h/7d/30d/all)
and exportable as a plain `timestamp,value` CSV file.

### My Dashboards

Personal (per logged-in user), saved, reusable dashboards built out of the monitors tracked on the
Monitor page — the same panel system the shared home Dashboard above uses, just scoped to your own
account instead of shared, and always editable by you regardless of Access Role (ownership is enough).
Create any number of named dashboards, each holding **panels**:

- **Chart** — a line chart; pick more than one monitor to overlay them for comparison.
- **Table** — one monitor's raw values (single-monitor by design — a true multi-series comparison
  table would need aligning independently-sampled timestamps, which a chart panel already covers).
- **Current value** — a compact tile listing the latest reading for one or more monitors, stacked or
  in a row.
- **Gauge** — a fill-bar meter against a configurable min/max range, with an optional unit.
- **Stat with change** — current value plus the change vs. the start of the panel's time range, with
  an up/down arrow; optionally colored once you specify whether higher or lower is "better".
- **Threshold indicator** — a colored badge (with customizable normal/alert labels) that flips once
  the value crosses a configured limit.

Chart and current-value panels can hold several monitors at once; gauge/stat/threshold panels are
single-monitor, since each is inherently one number. Panels are drag-reorderable (top-left handle) and
drag-resizable (bottom-right corner), snapped to a 12-column grid so a size means the same thing
regardless of window width. Chart panels refresh via their own polling loop; every other panel type
rides the same 5-second auto-refresh the home Dashboard uses. Deleting a monitor removes it from any
panel referencing it automatically.

### Miniservers

Add one entry per physical Miniserver: name, host, HTTP port (with an HTTPS toggle for
self-signed-certificate Miniservers — certificate errors are ignored for this connection only),
optional UDP port, and a webservice username/password. The gateway pings every Miniserver once a
minute in the background and shows an Online/Offline/Unknown badge; **Test now** runs that check
immediately. Editing a Miniserver never displays its stored password — leave the field blank to
keep it, or type a new one to change it.

An optional **External URL** (a full base address — DynDNS hostname with port, or a Loxone
DNS/Cloud address) can also be set. Every HTTP call this gateway makes to that Miniserver — Virtual
Inputs, Monitor polling, structure lookups, Common commands, Logs, and Test now — tries the local
Host/IP first and only falls back to the external URL if the local one fails at the network level
(timeout, refused, DNS), so one Miniserver entry stays usable both on the local network and
remotely without switching configuration.

There is intentionally no autocomplete for Virtual Input names: they are pure programming blocks
in Loxone Config and don't appear anywhere in a Miniserver's structure export (`LoxAPP3.json`) —
confirmed against a real Miniserver with 365 controls and zero Virtual Inputs in the export. Type
the name exactly as configured in Loxone Config.

### MQTT &rarr; Loxone

Subscribe to a topic (wildcards `+`/`#` supported) and forward each message to a Virtual Input on
a chosen Miniserver, via HTTP (`/dev/sps/io/<target>/<value>`) or UDP. Available value transforms:

- **Pass through unchanged**
- **on/off &rarr; 1/0**
- **JSON path** — pull one field out of a JSON payload
- **Translation table** — a free-form lookup you manage per mapping (e.g. `False &rarr; 0`, `open &rarr; 1`)

An optional **minimum interval (ms)** throttles a mapping so a fast-changing sensor can't flood the
Miniserver — messages arriving sooner than the interval since the last forwarded one are dropped.

### Loxone &rarr; MQTT

Each mapping gets a random token and publishes to one MQTT topic.

- **HTTP** — the mapping's row shows a ready-to-use callback URL
  (`http://<gateway-host>:3000/api/loxone-in/<token>?value=\v`) for a Virtual Output's HTTP command
  in Loxone Config; `\v` is replaced with the actual value on every call. This endpoint
  intentionally has no login (the Miniserver can't hold a session) — the unpredictable token is
  the security boundary.
- **UDP** — send `<token>=\v` as a Virtual UDP Output to the gateway on the port shown (11884 by
  default, configurable via `LOXONE_UDP_PORT`).

A **translation table** transform is available here too, e.g. for turning Loxone's `1`/`0` into
the `on`/`off` text a device expects.

Every mapping also has a **Test** action: publish a value straight to its topic without touching
Loxone at all, running through the same transform a real call would use — useful for confirming a
device reacts before wiring up the actual Virtual Output.

### Common commands

An interactive builder for devices with well-known MQTT command topics (currently Shelly Gen1:
relay, roller, and light channels). Pick a device — from every device the broker has actually seen
traffic for, across all known types, not necessarily the same string as its raw MQTT client ID,
which can differ from its configured topic prefix — and its device type fills in automatically;
correct it manually if it guessed wrong or the device hasn't been seen yet. Then pick a command and
channel number; the composed topic can be sent straight into a new Loxone &rarr; MQTT mapping. On
**Live traffic** → *Connected Clients*, devices that look like a Shelly link here with the device
pre-selected.

### Transformations

Every mapping (either direction) using the "Translation table" transform, in one place, with a
per-mapping entry count and a shortcut to manage it.

### Live traffic

Two views, both refreshing automatically (without a full page reload) every 5 seconds and both
in-memory only (cleared on a gateway restart):

- **Live Messages** — one row per topic seen, with its actual and previous value, a message count,
  and a ready-to-copy **Command Recognition** string (`MQTT:\i<topic>=\i\v`) for a Loxone Virtual
  UDP Input. **Map** jumps to a pre-filled MQTT &rarr; Loxone mapping, **Widget** pins the value on
  the Dashboard.
- **Connected Clients** — which MQTT clients are connected or have been. The **Device** column shows
  the topic prefix seen in that device's own MQTT traffic when one is known (hover to see the raw
  MQTT client ID), falling back to the raw client ID otherwise — there's no protocol-level way to
  ask the broker "who published this topic", so this is a best-effort match, not a guarantee.
  Devices that look like a Shelly get a "Suggest commands" shortcut. **Clear list** removes
  disconnected entries only — clients that are still actually connected stay listed, since they
  won't send a new "connected" event just because the view was cleared.

### Logs

Different from Monitor: real **log files**, not tracked values. Two tabs, both live (refreshing
every 5 seconds) and persisted in SQLite (kept for a configurable retention, purged automatically —
same model as Monitor's history):

- **MQTT broker** — the raw Mosquitto broker log file, tailed the same way Connected Clients already
  reads it for connect/disconnect events, except every line is stored here.
- **Loxone Miniservers** — each configured Miniserver's own system log (`GET
  /dev/fsget/log/def.log`, Basic Auth), falling back to its External URL if the local address
  can't be reached. There's no push channel
  for this on the Loxone side, so the gateway polls once a minute and stores only newly appended
  lines; the first poll for a Miniserver backfills the last 500 lines instead of its full history. A
  Miniserver filter dropdown appears once more than one is configured.

Each line gets a best-effort **Level** badge (info/warning/error), guessed from its own wording
since neither source tags lines with a real severity — a scanning aid, not a guarantee.

Both tabs have a filter bar: **From**/**To** (date/time range), **Level**, and **Contains** (plain
substring search). Filters combine, live in the URL, and survive the 5-second live refresh; the
table still caps out at 1000 rows even when filtered. **Export .log** on either tab downloads
everything currently retained as plain text, unfiltered.

### Users (MQTT accounts)

Add a username/password/role for a new device — no broker restart needed, changes take effect
immediately. Backed by Mosquitto's dynamic-security plugin rather than a password file, precisely
so this can be managed live from the UI. Change a device's role right in the table, or reset its
password without recreating the account. The gateway's own account (`gateway` by default) can't be
edited or deleted here, since that would lock the gateway itself out of the broker.

### Roles

A role is a named set of ACL rules (publish/subscribe permissions on topic patterns); a user is
assigned one or more roles. Out of the box, `client` has full publish/subscribe on every topic
(`#`) and `admin` is Mosquitto's own built-in role. Both are protected from *deletion* (the
gateway's bootstrap and every device account depend on them) but their ACL rules can still be
edited like any other role.

### Settings

- **Broker connection** — host/port/username/password/TLS the gateway itself uses to connect to
  MQTT. Defaults to the bundled Mosquitto process running in the same container, but can point at
  any external broker; saving reconnects immediately. The `MQTT_URL`/`MQTT_USERNAME`/`MQTT_PASSWORD`
  environment variables only seed this setting on the very first start.
- **Auto-create Loxone &rarr; MQTT mappings** — off by default. When enabled, a call to
  `/api/loxone-in/<anything>` that doesn't match an existing token is treated as a literal MQTT
  topic and a new passthrough mapping is created on the spot instead of returning 404. Convenient
  for wiring up Loxone quickly, but it means any string reaching that endpoint becomes a real
  topic — leave it off unless you specifically want that.

### Administration & Access Roles

Visible only to users whose Access Role has **Administrator** checked. Three tabs:

- **Users** — every web UI account (distinct from **Users (MQTT accounts)** above, which is about
  IoT devices connecting to the broker). Add a local account, change anyone's Access Role, reset a
  local user's password, or delete an account. The gateway always keeps at least one administrator
  — deleting, demoting, or reassigning the last remaining admin is blocked with an error.
- **Access Roles** — named permission sets. Each role has a fixed matrix of one **view**/**edit**
  pair per page in the app (Monitor, Miniservers, MQTT Users, Settings, and so on). An
  **Administrator** role bypasses the matrix entirely and always has full access — that flag is
  separate from the matrix so a role can never grant itself more power through it. Hiding a nav
  item or button a role can't use is a UI convenience; the server enforces every request
  regardless.
- **Single Sign-On** — connect a self-hosted [Pocket ID](https://pocket-id.org) instance so people
  can log in with it *alongside* (not instead of) the existing username/password login. The first
  sign-in via Pocket ID auto-creates an account with a configurable default Access Role. When
  creating the OIDC client in Pocket ID, set the **Callback URL** to
  `http://<gateway-host>:3000/auth/sso/callback` (shown on the Single Sign-On admin page) and, if
  you want LoxSuite to appear as a launchable app on the Pocket ID home screen, set the **Client
  Launch URL** ("User URL") to `http://<gateway-host>:3000/`.

### Profile

Every logged-in user's own account page: avatar, display name, email, Access Role, and sign-in
method. Pocket ID (SSO) accounts get their avatar/name/email from Pocket ID automatically (refreshed
on every login); local (username/password) accounts can set a display name/email themselves and
change their password here — SSO accounts have no local password to change, that's managed by
Pocket ID.

### Other UI features

- **Per-user table customization** — drag a column header to reorder it, use the **Columns**
  button to show/hide columns. Stored server-side per logged-in user, so it follows you across
  browsers/devices (not `localStorage`).
- **Remember me** on login keeps a session for 30 days. Sessions live in the same SQLite database
  as everything else, so a remembered login also survives a gateway restart — it isn't just a
  longer cookie on top of an in-memory session.
- **Light/dark theme** toggle in the sidebar, remembered per browser, applied before first paint
  (no flash of the wrong theme).
- An interactive **Help** page (in the sidebar) walks through everything above from inside the app.

## Known scope limitations

- No way to autocomplete Virtual Input names — see the Miniservers section above.
- MQTT device accounts all share one `client` role with access to every topic; there's no
  per-device topic restriction out of the box (build one yourself under **Roles** if you need it).
- Device-specific value transforms beyond a plain translation table (e.g. RGBW colour conversion)
  aren't built — the translation table covers most on/off- and enum-style cases.
- Loxone-direct monitors are polling-based, not a websocket push subscription — see the Monitor
  section above.

## Data and persistence

- Mosquitto data/logs and its dynamic-security state live in Docker volumes / `./mosquitto/config`.
- All mappings, Miniserver configuration, users, and sessions live in one SQLite file at
  `./data/gateway.db` (bind-mounted, so it's easy to back up).

## Environment variables

| Variable | Purpose |
|---|---|
| `MQTT_USERNAME` / `MQTT_PASSWORD` | Account the gateway itself connects to the broker with. Created automatically on first boot. |
| `MQTT_ADMIN_USERNAME` / `MQTT_ADMIN_PASSWORD` | Break-glass dynamic-security admin account, used once on first boot to bootstrap the `client` role and the gateway's own account. Keep the password somewhere safe. |
| `SESSION_SECRET` | Random long string used to sign session cookies. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Web UI admin account, created on first boot if the `users` table is empty. |
| `DB_PATH` | SQLite database path (set in `docker-compose.yml`, rarely needs changing). |
| `LOXONE_UDP_PORT` | UDP port the gateway listens on for Loxone &rarr; MQTT UDP mappings (default 11884). |

## Security notes

- Change `SESSION_SECRET`, `ADMIN_PASSWORD`, `MQTT_PASSWORD`, and `MQTT_ADMIN_PASSWORD` in `.env`
  before exposing this beyond your local network.
- `/api/loxone-in/:token` has no login by design (the Miniserver can't hold a session) — its
  security is the unpredictable per-mapping token, not authentication.
