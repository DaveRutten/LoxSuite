# Changelog

All notable changes to this project are documented in this file.

## [0.18.5-alpha.1] - 2026-08-13

### Fixed
- **MCP Authorize/Re-authorize/Start new login failures logged a blank error message.** The OAuth
  SDK's error classes (`InvalidClientError`, `InvalidGrantError`, etc.) build their `.message` from
  the server's own `error_description` field, which is optional — a Miniserver/Loxone response that
  omits it produced a real `Error` with a genuinely empty message, so "Last MCP connection error"
  and the System log both showed nothing useful ("...failed: " with nothing after it). Now falls
  back to the error's own class name and OAuth error code (e.g. "InvalidGrantError
  (invalid_grant)") when the server doesn't send a description.

## [0.18.4-alpha.1] - 2026-08-13

### Fixed
- **Authorize/Re-authorize/Start new login never logged anything to Logs > System**, success or
  failure, on two of the three routes — only the OAuth callback route did. So after a failed (or
  timed-out) attempt, the one place a user would naturally go to check "what happened" showed
  nothing at all, regardless of whether the fix in 0.18.3-alpha.1 actually did anything. All three
  routes now log both outcomes there.

## [0.18.3-alpha.1] - 2026-08-13

### Fixed
- **Authorize/Re-authorize/Start new login could still hang forever on some hosts**, even after
  0.18.2-alpha.1. That fix only covered the case where the OAuth SDK's `auth()` call *resolves*
  without redirecting; it did nothing for a network path where the request is silently dropped
  (packets never come back at all, rather than a clean refusal) — the underlying call has no
  timeout of its own, so nothing ever settled and the click just sat there with zero error, zero
  log output, forever. Now bounded at a hard 25-second ceiling: a genuine network-reachability
  problem now surfaces as a clear "Timed out... check that this container can actually reach it
  over the network" error under "Last MCP connection error" instead of hanging silently.

## [0.18.2-alpha.1] - 2026-08-13

### Fixed
- **Miniserver edit page's Authorize/Re-authorize/Start new login buttons could hang forever with
  no error.** The MCP OAuth SDK's `auth()` call can succeed by silently refreshing the stored token
  internally, without ever redirecting the browser anywhere — and nothing else in these routes sent
  a response in that case, so the click just sat there indefinitely. Now redirects back to the edit
  page itself (showing "Authorized.") whenever `auth()` resolves without already having redirected.

## [0.18.1-alpha.1] - 2026-08-13

### Fixed
- **False "device firmware changed" alerts** for an Audioserver: its own `/version` endpoint
  ("17.02.08.11") and the Miniserver status XML's fallback (used whenever that direct fetch
  fails — different subnet, firewalled, a transient blip — "MINISERVER V 17.2.08.11 &lt;mac&gt; |
  ~API:2.0~") describe the identical firmware differently; comparing them verbatim fired a
  notification every time reachability happened to flip. Now compared by their actual dotted
  version number, normalized for each segment's own leading zeros, so the two representations of
  one unchanged version no longer read as a change.
- Monitor/Dashboard charts: a value that stays unchanged for a long stretch (change-only history
  dedup, especially for an MQTT-sourced monitor that only publishes on change) drew as a diagonal
  line to whenever it was next recorded instead of a flat one. A gap over 30 minutes between two
  real readings now gets a synthetic point holding the prior value right before the next real one,
  so the line reads as flat across it — without forcing every other, normally-sampled series into
  a stepped look. An axis with every one of its series toggled off in the legend now hides itself
  instead of falling back to Chart.js's own broken-looking 0-1 default range.
- Raised the System log's "Slow query" threshold from 200ms to 3000ms — a brief burst of
  contention right after boot (retention purges + MQTT/websocket reconnects all firing at once)
  routinely pushed even trivial single-row lookups into the hundreds-of-ms range for a few
  seconds, drowning out the genuinely slow (multi-second) queries this log exists to surface.

## [0.18.0-alpha.1] - 2026-08-13

### Added
- **AI Assistant: multi-provider support**. Ollama/OpenWebUI is now the bundled default
  (`docker-compose.yml` ships an `ollama` service out of the box, no API key, no per-token
  billing) — Claude (Anthropic), ChatGPT (OpenAI), and Gemini (Google) are optional alternatives,
  each with their own API key field and a short recommended-model list (or type any custom one).
  Administration → AI Assistant checks whether the chosen Ollama model is already pulled and, if
  not, pulls it right there with a live progress log — survives navigating away, and a
  Notification Center entry fires once it's ready. Downloaded Ollama models can also be deleted
  from the same page.
- **AI Assistant: local-data fast path**. For "what's the current value of X" questions, LoxSuite
  now tries to resolve the answer directly from its own already-live data (the same cache Live
  Data/dashboards use) before the model ever makes a tool call — no network round trip to the
  Miniserver on a hit. Two new tools (`local_find`/`local_state`) are offered to every provider
  alongside the Miniserver's own MCP tools, and a deterministic pre-fetch step resolves the common
  single-room/single-value case in plain code, handing the model a ready-made fact instead of
  relying on it to fetch one correctly. Falls back to the Miniserver's own MCP tools for anything
  else (history/statistics, writes, or a value not yet reflected in the live cache).
- **AI Assistant: chat widget polish** — Markdown rendering (bold/lists/code) instead of literal
  `**asterisks**`; a Retry button on any failed reply; message timestamps that reflect when a
  reply actually finished, not when it started; an unread badge on the launcher for a reply that
  finished while the panel was closed or showing a different conversation; new conversations
  pre-select the first available Miniserver; the panel now only closes via its own close button or
  Escape (not by clicking elsewhere), so it reliably stays open across page navigation.
- Miniserver edit page: a **Start new login** button next to Re-authorize, for when a stuck token
  refresh needs a clean slate instead of repeating the same failing refresh. The Miniservers list's
  own row-level "Test now" popover now shows the AI Assistant (MCP) check result too, with the same
  colored icons as the edit page.
- System log entries for Miniserver and AI Assistant settings saves now show what actually
  changed (`field: old → new`) instead of a bare "updated X."

### Fixed
- **Slow query**: `Logs → Loxone Commands` (and any other Logs tab where its own source is a small
  fraction of a much larger `log_entries` table) could take 3+ seconds — the existing index
  supported the date-range filter, not the `ORDER BY id DESC` this page's own query actually needs,
  so a rare source in an otherwise huge table forced a near-full-table scan. Added the missing
  `(source, id)` index.
- Ollama performance tuning for CPU-only inference: keeps the model resident far longer
  (`OLLAMA_KEEP_ALIVE`), quantized KV cache + flash attention, a capped context length, trimmed
  tool descriptions, a hard cap on how much of an oversized tool result gets fed back to the model,
  and a cap on reply length — together, these cut a cold multi-tool-call turn from 100+ seconds to
  a small fraction of that in testing.
- The AI Assistant's system prompt now explicitly forbids stating a value it didn't literally see
  in a tool result, and requires it to actually call a tool rather than describe or narrate one —
  both verified against real (if imperfect, especially on small local models) improvements.

## [0.17.1-alpha.1] - 2026-08-12

### Fixed
- **Postgres**: opening a Monitor's detail page (and several other pages — Dashboards' own sharing
  lists, Logs export, Transformations' mapping lists, the Monitor list's Dashboard/panel-count
  columns, and every panel's "current value") crashed or silently showed missing data, because
  Postgres folds an *unquoted* SQL alias to lowercase while SQLite preserves it as written — a
  hand-written query aliasing a column as `recordedAt` came back from Postgres as `recordedat`,
  so the app's own `row.recordedAt` read `undefined`. Only surfaced now because this is the first
  time an existing install's real data has actually round-tripped through Postgres. Every affected
  alias across the app is now explicitly quoted so its case survives on Postgres too; SQLite and
  MySQL/MariaDB are unaffected either way.

## [0.17.0-alpha.1] - 2026-08-12

### Added
- **AI Assistant (optional)**: LoxSuite can now connect to a Loxone Gen2 Miniserver's own MCP
  server plugin and to Claude (Anthropic), to power a chat page that can read — and, if you
  explicitly allow it per Miniserver, control — a connected installation. Off by default at two
  independent levels (Administration > AI Assistant's own enable switch, and a per-Miniserver
  toggle on its edit page) — with nothing configured, nothing changes: no new outbound calls, no
  new nav item, existing dashboard suggestions unaffected. Connecting a Miniserver's MCP server is
  a one-time Loxone-account OAuth login from that Miniserver's edit page; every write-capable tool
  call the assistant makes is logged in Logs > Loxone commands like any other command, tagged with
  its own source.

### Fixed
- **Postgres**: migration `003_backup_succeeded_trigger.js` (first shipped in 0.13.8-alpha.1)
  failed on Postgres with `bind message supplies 11 parameters, but prepared statement "" requires
  0` — Postgres's DDL parser doesn't accept bound parameters inside an `ALTER TABLE ... ADD
  CONSTRAINT ... CHECK (...)` expression the way it does for ordinary statements. Only surfaced now
  because Postgres had apparently never actually been run through this migration before. Fixed by
  inlining the fixed trigger-type list as escaped literals instead of bind parameters; SQLite and
  MySQL/MariaDB were unaffected.
- A `DATABASE_URL` whose username or password contains a raw, non-percent-encoded `%` crashed the
  whole process with an uncaught `URIError` at boot instead of the clear, boxed configuration error
  every other misconfiguration on this path already gets.

## [0.16.1-alpha.1] - 2026-08-12

### Fixed
- Some Loxone readings (weather-server values like Current Humidity/Temperature/Precipitation)
  now report their value pre-formatted with the unit already appended ("33 %", "28.6 °C")
  instead of a bare number. Parsing that with `Number()` returned `NaN` and treated the whole
  reading as non-numeric — breaking its chart history, threshold coloring, and notifications, and
  showing the panel's own configured unit stacked on top of Loxone's own ("33 % %"). Value/Gauge/
  Stat delta/Threshold panels now correctly parse the leading number regardless of a trailing
  unit, and only fall back to displaying Loxone's own unit when the panel has no Unit field of
  its own configured — an explicit Unit override still always wins.

## [0.16.0-alpha.1] - 2026-08-12

### Added
- Miniservers: a Miniserver that's reachable but rejecting its configured credentials (HTTP
  401/403 — the Loxone user account was disabled, its password changed on the Miniserver side,
  ...) now gets its own **Auth failed** badge, distinct from a plain Offline, on the Miniservers
  list, the Home dashboard's Miniservers widget, and Live Data's connection status.

### Fixed
- The 0.15.0-alpha.1 poll-storm fix bounded *concurrency*, but a Miniserver rejecting credentials
  outright was still retried automatically forever — every poll cycle, every healthcheck cycle,
  every websocket reconnect — even though the exact same request would fail identically every
  single time until the account itself is fixed, unlike a transient network blip. Monitor polling,
  the background healthcheck sweep, and the live websocket's own reconnect loop now all stop
  retrying a Miniserver the moment a 401/403 is seen, and only try again once the user explicitly
  asks — the Miniservers page's **Test now**, or saving that Miniserver's settings.

## [0.15.0-alpha.1] - 2026-08-12

### Added
- Hardware page: Audioserver rows and their Audio zones now show a real **Online**/Offline status
  — the Miniserver's own `/data/status` (this page's usual source) never reports one for either,
  confirmed in Loxone's own Structure File documentation as a real, separate control type
  (`AudioZoneV2`) with its own `serverState`/`clientState`, read the same way every other live
  Loxone value already is in this app (the existing websocket push cache, HTTP as a fallback).
- Each Audio zone now shows which Audioserver it belongs to (**Zone of** column, grouped together
  in the table) and a **Stereo** badge when a Stereo Extension is physically attached to that
  zone, both read from the same Structure File data.
- Topbar: a heart button next to Help/Notifications opens a **Support LoxSuite** dialog linking to
  a GitHub star and a one-time PayPal donation.

### Fixed
- A Miniserver going unreachable (offline, mid firmware-update, ...) could make the whole app's own
  page loads stall, not just Loxone monitor polling. The background poll loop fired one HTTP
  request per due monitor with no concurrency limit at all, and no cap carried over between ticks —
  an outage turned every 5s tick into an uncapped burst of dozens of simultaneous requests, each
  held open up to 8s, piling further on top with every subsequent tick for as long as the outage
  lasted. Confirmed live on a production instance mid firmware-update: bursts of ~90 simultaneous
  timeouts every ~16-18s, severe enough that even the gateway's own loopback connection to its
  bundled MQTT broker, and its own Docker health check, started timing out too. Polling now goes
  through a small persistent worker pool (4 concurrent requests, the same limit Live Data already
  uses for the exact same reason) shared across every tick, so it can never stack up further the
  longer an outage lasts. The MQTT→Loxone command-forwarding path (`sendHttpVirtualInput`) had no
  timeout at all; now capped at 8s like every other Miniserver request.

## [0.14.0-alpha.1] - 2026-08-12

### Added
- **Administration → General → Device templates**: device definitions now load from three tiers —
  this app's own built-ins, anything fetched from GitHub, then your own files — each able to
  override an earlier one's same device. A **Fetch latest built-ins from GitHub** button pulls
  straight from the project's `main` branch (ahead of a full app release), and **Reload from disk**
  picks up either that or a hand-edited file without a restart. Every fetched file is parsed and
  validated before it's written, so a malformed/truncated fetch can never clobber a previously-good
  one. Lists what's actually loaded from each tier, flagging any of your own files that are
  byte-identical to a current built-in/GitHub-fetched device — almost certainly a stale leftover,
  safe to delete so the built-in takes over again.
- Mappings → Common Commands: a **Sync new built-in commands** button (shown once the catalog is
  customized) adds whatever's missing from the built-ins — a new device family, or a new
  command/data point on an existing one (e.g. Shelly's Reboot command) — without touching or
  reintroducing anything already edited or deliberately removed.

### Fixed
- A device-templates file bind-mounted into a real install only ever got copied in **once**, on
  the very first boot ever — any file already sitting there, from whenever that was, permanently
  shadowed a newer built-in with the same name, forever, even after every later update. The
  built-ins are now read directly from the image itself, always current; the bind-mounted folder
  is migrated (once, safely — nothing is ever deleted, only moved) into its own `user/` subfolder
  on upgrade, and only ever holds what you actually put there yourself.
- The point-and-click Common Commands catalog editor has the exact same failure mode one layer
  up — once customized, saved as one complete snapshot that never automatically gained a
  since-added built-in command either, even after an app update. See "Sync new built-in commands"
  above.

## [0.13.9-alpha.1] - 2026-08-11

### Fixed
- Connected Clients' Device column could never learn a Shelly's real name once it had been renamed
  away from the factory topic prefix in the device's own web UI: device discovery only recognized a
  topic prefix as "known" if it still matched that model's exact factory pattern (e.g.
  `shellyplug-s-<mac>`), which a custom name like `shellyplug-ZWEMBADVerwarming` no longer does —
  same effect on the Schedule command device dropdown and Suggest Commands. Fixed by also
  registering any topic prefix seen under a known root namespace (`shellies/`, `zigbee2mqtt/`,
  `homeassistant/`) regardless of which (if any) family pattern matched.
- On top of that, a renamed Shelly's topic prefix and its MQTT client ID can end up sharing no text
  at all — renaming only changes the topic prefix, never the client ID (which stays the factory
  model+MAC value forever) — so the existing best-effort text match had nothing to work from. Now
  resolved using the MAC address the device itself broadcasts on `shellies/announce` whenever it
  (re)connects, matched against that same MAC embedded in its factory client ID: a confirmed fact
  reported by the device, not a guess.

## [0.13.8-alpha.1] - 2026-08-11

### Added
- **Scheduled device commands** — Client Activity's new "Schedule command" button (next to Suggest
  commands, for any device resolved to a known Common Commands family) lets a command be re-sent on
  a repeating schedule: daily, every N days, or weekly on specific days, at a time evaluated in the
  gateway's own configured display timezone (Settings) rather than the container's. Entirely
  opt-in per device — nothing runs unless a schedule is explicitly added. A **Test** button sends
  the picked command once immediately, before committing to a schedule; each saved schedule gets its
  own **Run now**, enable/disable, inline edit (time and repeat pattern), delete, and a
  **Last run**/**Next run** column so a silent failure (broker not connected, ...) is visible
  instead of quietly not happening.
- A real **Reboot** command, added to every built-in Shelly Gen1/Gen2/Gen3 device template — Gen1's
  `shellies/{device}/command` = `reboot`, Gen2/3's RPC `Shelly.Reboot` over MQTT. Shows up in
  Suggest Commands too, not just the new scheduler.
- Loxone Commands log: a rejected "no matching mapping" row now shows **Pending** once a mapping for
  it actually exists — the row itself is a snapshot of what happened at the time, so it used to sit
  there looking permanently Rejected even after being fixed, with no hint that Loxone just hasn't
  sent that exact command again yet (it never retries on its own). A new **Send test command** form
  on that page fires an arbitrary token/value at the gateway's own UDP listener, to see the whole
  Rejected → add a mapping → Pending → send again → Accepted arc on demand.
- **Backup succeeded** is now its own notification trigger, alongside the existing Backup failed —
  kept separate rather than making Backup failed also fire on success, so an existing failure-only
  rule keeps meaning exactly what its name says.
- Chart panel legend redesigned as an actual table (closer to how Grafana's own legend reads):
  swatch/name/Min/Max/Avg/Now as real columns instead of one long sentence per series, capped to a
  share of the panel's own height (scales with the panel, not a fixed value) with its own scrollbar
  past that — a chart with many series can no longer squeeze the plot itself down to a sliver.

### Changed
- A dashboard panel's own drag handle and "…" action button now hide themselves while that exact
  panel's Edit drawer is already open — both were redundant clutter at that point.
- The Edit-panel monitor checklist now sorts a newly-checked monitor to the top immediately, not
  just after the next page reload.
- Chart panel Series settings: Style/Point-style/the per-series color checkbox+swatch now land
  together on one row as intended — a missing CSS rule on the point-style dropdown was stretching it
  to the full row width and forcing everything after it onto its own line.

### Fixed
- A chart panel's canvas didn't correctly resize itself when a legend was present: Chart.js measures
  its available space from the canvas's own direct parent, which never actually shrank just because
  a legend sibling started sharing space in it via flex — so growing a panel left a visible gap
  between the plot and the legend, and shrinking one left axis tick labels cramped/overlapping
  (computed for a size the canvas no longer actually had). Fixed by giving the canvas its own
  dedicated, correctly-flex-constrained box, so Chart.js always measures the real thing.
- The custom chart legend disappeared after the very first 15-second live refresh, even though it
  displayed correctly on initial load — `showLegend`/`resolvedPosition` were only ever computed on
  the code path taken the first time a chart was drawn; every refresh after that hit an early
  return before reaching them, passing `undefined` into the legend builder, which treats that as
  "hide it".

## [0.13.7-alpha.1] - 2026-08-10

### Added
- Loxone Live Data and MQTT Live Traffic now show a **Status** column with small purple badges
  (Monitored/Widget/Mapped) so it's obvious at a glance which values are already tracked somewhere
  else, without needing to click + Monitor or + Widget to find out.
- Both +Monitor and +Widget now grey themselves out once the value already has one — pinning the
  same value on the Dashboard a second time used to silently create a duplicate panel; it's now
  rejected the same way a duplicate monitor already was. Applies to the single-row buttons, the
  per-room bulk actions, and the Miniservers diagnostics "Add to Monitor" button.
- The Miniservers page's diagnostics dialog also greys out "Add to Monitor" once CPU load, heap
  value, and task count are all already being tracked.

### Changed
- Live Data's bulk "Monitor selected"/"Widget selected" now disable the moment even ONE selected
  control is already monitored/widgeted, instead of only once every selected control is — avoids a
  partial bulk add silently skipping some of the selection with no visual warning beforehand.
- A bulk add's rows now update their Status badges and buttons immediately in place once it
  succeeds, without needing a page reload to see the new state.
- Deleting a monitor (or clearing its history) now responds immediately and removes the row from
  the page right away; the actual history purge runs in the background afterwards instead of
  blocking the page load — a monitor with years of history used to make the page hang for a long
  time on delete.

### Fixed
- Manually adding a monitor (Monitor page's own Add form) for a value/topic that already had one
  silently created a second, duplicate monitor — this is the one path that check was missing from.

## [0.13.6-alpha.1] - 2026-08-10

### Added
- **Gauge** panels can now also give one monitor its own minimum/maximum, on top of the per-value
  unit/thresholds added in 0.13.5-alpha.1 — the whole range, not just the coloring, can now differ
  per value (e.g. Temperature at 0-40°C next to Humidity at 0-100% in the same panel).
- A panel's shared Unit/Threshold colors/Min/Max/Value names &amp; colors field now hides itself
  once every currently-selected monitor already has its own override for that specific thing —
  applies to Value (Unit), Chart (Y-axis unit), Gauge (Unit/Min/Max/Threshold colors), and State bar
  (Value names &amp; colors). A field stays visible as long as it's still the real, active fallback
  for at least one selected monitor; nothing disappears just because 2+ monitors are checked.

### Fixed
- A Gauge panel's per-value minimum/maximum override, when left blank, was silently saved as an
  explicit `0` instead of "no override" (`Number(null)` is `0` in JavaScript, not `NaN`) — the
  monitor would then show a broken 0-0 range instead of falling back to the panel's own min/max.

## [0.13.5-alpha.1] - 2026-08-10

### Added
- **Gauge** panels can now give one monitor its own unit and/or threshold colors instead of sharing
  the panel's — e.g. Temperature at °C and Humidity at % in the same panel, each with its own alert
  thresholds. Min/max/scale/decimals stay shared across the panel.
- **State bar** panels can now give one monitor its own value names/colors instead of sharing the
  panel's mapping — e.g. a lock's 0/1 and a mode control's 1/2/3 in the same panel.
- Monitor's table has new (default-hidden, enable via the Columns menu) **Room** and **Category**
  columns showing where a Loxone-sourced monitor's control actually lives.
- New installs now ship with `jLocked` pre-hidden in Settings' "Hidden state names" — near-universal
  noise on any installation with a lockable control, previously something everyone had to discover
  and type in by hand.

### Changed
- A dashboard panel's Edit/Duplicate/Delete buttons now collapse behind a single "…" menu instead
  of three separate icon buttons, matching the same kebab-menu pattern already used for table rows.
- The Edit-panel drawer's monitor checklist now sorts already-checked monitors to the top.
- Monitor history is no longer written on every poll regardless of whether the value changed: a row
  is only inserted when the value actually changes, plus (for numeric monitors only) a 30-minute
  heartbeat so a chart/stat panel filtered to a short range never comes up empty for a monitor
  that's been constant longer than that. This is the main fix for backup size growing every day even
  with no real data changes.
- A State bar panel's own minimum drag-resize height is one grid row-unit shorter than before.

### Fixed
- A **Current value** panel showed an unwanted scrollbar once resized narrow enough for a long
  monitor label to wrap onto multiple lines — labels now truncate with an ellipsis (click to expand,
  same as elsewhere in the app) instead of wrapping and growing the row past the panel's own height.

## [0.13.4-alpha.1] - 2026-08-09

### Added
- A **Current value** panel now has a "Hide name" toggle — drops the monitor label from every row
  and blows the value itself up to a big centered "hero" size instead, for a panel whose title
  already says what it's showing.

## [0.13.3-alpha.1] - 2026-08-09

### Added
- The Loxone → MQTT mapping page's Test dialog now has a proper color picker for a Shelly
  RGBW/White mapping's "RGB" and "RGB (Analog input)" modes, instead of typing a raw HSV/packed
  value by hand — pick a color (or one of several quick-pick palettes) and it's converted to
  exactly the value Loxone itself would send, verified end to end against the real transform.
  - Three new color palettes — Vivid, Pastel, and Muted — join the existing default palette
    everywhere a color picker appears in the app (thresholds, value mappings, annotations, chart
    series, and this new Test dialog), not just here.
  - New "Dimmer (0-100%)" value transform (behaves identically to plain pass-through — it only
    changes what the Test dialog shows) gets a 0-100% slider in the Test dialog instead of a bare
    text box; the same slider is used for a Shelly RGBW/White mapping's "White" mode.
  - Both the color picker and the slider have a genuine Off/On toggle — switching off remembers
    the color or brightness it was on, and switching back on restores it exactly, rather than
    leaving you to re-pick it.
  - A "Paste JSON instead" option on both lets you send an exact payload verbatim when you need to
    test something the picker itself can't produce.

### Fixed
- Several layout issues in the Loxone → MQTT mapping table and its Test dialog: the
  Connection info column's content wasn't vertically centered in its row, the Test dialog could
  show an unwanted vertical scrollbar, its value picker and Send/Close buttons were cramped onto
  one wrapping line, the Off button's position shifted left and right as the value text next to it
  changed length, and that same value text wasn't vertically aligned with the Off button — all
  traced back to two related causes: a shared `.hint` text-style class also carrying page-paragraph
  margins that made no sense reused inside a table cell or a dialog, and simply not giving the
  dialog and its color-picker popover enough room by default.
- A slider (e.g. the new dimmer/white one above) now uses this app's own green accent color instead
  of the browser's default blue, matching every checkbox and radio button already.
- A State panel's bar(s) stayed a fixed, thin height regardless of how tall the panel itself was
  resized, leaving dead space between the bar and the panel's footer instead of using it — the
  bar(s) now stretch to fill whatever height the panel has, and the panel's own drag-resize floor
  shrank to match (previously computed from that fixed height, which no longer means anything now
  that it stretches).

## [0.13.2-alpha.1] - 2026-08-09

### Fixed
- **Loxone Virtual UDP Output commands stopped reaching MQTT entirely** since 0.13.0-alpha.1 —
  every UDP-transport Loxone → MQTT mapping (Shelly lights, dimmers, relays, RGBW/color, or any
  other UDP-configured command) silently failed to publish, while the command still showed as
  "queued" with nothing obviously wrong in the UI. Root cause: one function involved in parsing an
  incoming UDP command became asynchronous when the database layer was converted to the new async
  Knex facade (0.13.0-alpha.1's own db-backend work), but the one place that called it was missed —
  it kept calling the function without waiting for its result, which made every such command throw
  immediately and vanish into a background log line instead of being applied. HTTP-transport
  mappings and every other part of the app were unaffected. Found and fixed after a report of Shelly
  devices no longer responding to Loxone commands; verified with a real UDP command sent through the
  fixed code path end to end (including an independent MQTT subscriber confirming the correct topic
  and payload actually arrived) and with new automated regression tests
  (`test/loxoneUdpServer.test.js`) covering both the RGBW color transform and the plain on/off case.
- Two related hardening fixes found during the same investigation (neither caused a functional
  failure on their own, but both let a real error vanish as a generic "unhandled promise rejection"
  instead of a clear log line): recording an incoming MQTT message's value into monitor history now
  properly reports a failure instead of swallowing it silently, and every background service started
  at boot (dynamic-security bootstrap, MQTT log tailing, the MQTT client itself, the monitor/log
  collectors, live Loxone connections) now logs a clear message if its own startup fails instead of
  producing an unlabeled warning.

## [0.13.1-alpha.1] - 2026-08-08

### Fixed
- A State panel showing just a single monitor rendered its bar shrunk to a sliver instead of
  filling the row — the shared label/bar grid still expected a label column even though a
  single-monitor panel skips rendering one, so the bar auto-placed into that now-empty column and
  shrank to its own minimum width. Single-monitor panels now use a one-column layout instead.
- The State panel's own bar track was taller than its label text needed — trimmed down, which also
  lets a panel with just one or two monitors size itself to its actual content instead of staying
  taller than necessary.

## [0.13.0-alpha.1] - 2026-08-08

### Added
- **Optional external database support** — LoxSuite can now run against an external PostgreSQL or
  MySQL/MariaDB server instead of its built-in SQLite file. SQLite stays the zero-config default;
  nothing changes for existing installs unless you opt in. Set `DB_BACKEND=postgres` or
  `DB_BACKEND=mysql` and either `DATABASE_URL` or the discrete `DB_HOST`/`DB_PORT`/`DB_NAME`/
  `DB_USER`/`DB_PASSWORD` env vars — see the commented-out example in `docker-compose.yml`/
  `.env.example` and the README's own Data and persistence section. Administration → General
  shows which backend is active.
- **Transfer tool** for moving an existing SQLite install's data to Postgres or MySQL/MariaDB:
  `docker compose exec loxsuite node src/db/transfer.js --from-sqlite /data/gateway.db --to
  "$DATABASE_URL" [--backend mysql]`. Supports `--dry-run` (row-count report, orphaned-row scan,
  touches nothing), `--prune-orphans` (skip rows SQLite never enforced foreign keys on instead of
  aborting), and resets the target's sequences/AUTO_INCREMENT counters afterward so the next
  ordinary insert doesn't collide with a transferred row.
- **Backups and restore** now work the same way regardless of backend — a SQLite install still
  backs up via an online file copy, Postgres via `pg_dump`/`pg_restore`, MySQL/MariaDB via
  `mysqldump`/`mysql`. A backup made under one backend is rejected (with a clear message) if you
  try to restore it into an install running a different one — use the transfer tool instead.

## [0.12.2-alpha.1] - 2026-08-08

### Fixed
- On a phone-width screen, the off-canvas sidebar menu was cut off partway down with no way to
  reach whatever ran past the bottom edge (`height: 100vh` on a fixed mobile overlay includes the
  space still occupied by the browser's own address-bar chrome before it collapses, which is taller
  than what's actually visible on first load). Now `100dvh`, which tracks the real visible
  viewport.
- A dashboard panel's Edit drawer (and Monitor detail's own chart-settings drawer, same shared
  component) opened as a right-side panel up to 92vw wide on a phone — effectively the whole
  screen, hiding the very panel it was supposed to let you keep watching while you edit it. It's
  now a bottom sheet capped at roughly 60% of the screen height on narrow screens, and the panel
  being edited scrolls to the top of the remaining space instead of trying to squeeze in beside a
  drawer that no longer has room next to it. A very tall panel (e.g. a large chart) can still have
  its lower portion sit behind the sheet — a genuine small-screen limit, not something a layout
  change alone fixes.

### Changed
- The MQTT → Loxone and Loxone → MQTT mapping tables had a small filter box under every
  filterable column's own header — replaced with the one search box each table had before the
  Tabulator conversion (0.12.0-alpha.1), now matching Topic/Miniserver/Transport/Target/Transform
  (plus Token on Loxone → MQTT) all at once instead of one column at a time.

## [0.12.1-alpha.1] - 2026-08-07

### Fixed
- The Live Data (MQTT) table's Topic and Command Recognition columns had no width cap, so a long
  topic or recognition string could push the Command Recognition/Actions columns off the right
  edge with no visible hint there was more to scroll to (the table does scroll horizontally, but
  nothing signaled that it should). Both now respect the truncation caps already built for exactly
  this — `.truncate`'s sitewide 320px default for Topic, `code.recognition-string`'s own 220px
  default for Command Recognition — which an inline style on each was overriding. The full value
  is still one hover away via the title tooltip, and Copy still copies it untruncated.

## [0.12.0-alpha.1] - 2026-08-07

### Changed
- Miniservers (including the same status table embedded on the shared home Dashboard),
  Transformations, the two Loxone/MQTT translation-table lookup pages, the admin Backup page, and
  both Mappings pages (MQTT → Loxone / Loxone → MQTT) now run on a shared table engine
  (Tabulator.js) instead of the old hand-rolled one — the same column show/hide/resize/reorder
  controls every table already had, now consistent and more reliable across all of them: resizing
  one column no longer leaves a stray gap on the right once the others no longer add up to the
  table's own width, and turning a hidden column back on no longer pushes the last column out of
  view with no way to reach it. The Mappings pages' old combined Status/text filter bar is now
  Tabulator's own per-column header filters instead. Miniservers additionally gets
  drag-to-reorder rows built on the table engine's own row-move support, and a row's actions
  (Edit/Diagnostics/Test now/Delete) collapse into one menu instead of separate always-visible
  buttons competing for space.
- A Miniserver's **Diagnostics** (PLC state, CPU load, heap, task count, firmware date, update
  channel, and the Check for update / Update to latest release / Add to Dashboard / Add to Monitor
  actions) now opens in a dialog from the row's own actions menu, instead of expanding the row
  itself.
- Every popover/menu on these tables — the Columns menu, a row's actions menu, and the
  notification template's `{{`/`/` autocomplete (Notification Center) — is now positioned by
  Floating UI instead of hand-rolled placement math: it flips above when there's no room below,
  stays nudged inside the viewport instead of running off an edge, and now correctly tracks its
  anchor while the page itself scrolls (a menu could previously "freeze" in place on a whole-page
  scroll, a bug this surfaced and fixed along the way, not something a released version ever had).

## [0.11.0-alpha.1] - 2026-08-06

### Added
- Dashboard panels are now laid out with GridStack instead of the old custom grid, adding real
  free-form drag/resize and **panel groups**: a collapsible header that bundles a set of panels
  into their own zone, independently sortable from other groups (drag the group's own header bar
  to reorder groups) and reorderable amongst themselves without disturbing ungrouped panels. A
  panel can be dragged straight onto a group's header bar to join that group, not just into its
  body.
- A chart panel's legend can show **min / max / avg / current** for each series, toggled
  independently per series (and per stat) rather than all-or-nothing for the whole legend.
- Threshold, annotation, and value-mapping row lists (and now dashboard groups too) share one
  drag-to-reorder module instead of duplicated one-off logic — a picked-up row lifts with an
  accent ring and the same drop shadow a dragged panel gets, and a live drop-indicator shows where
  it'll land.
- The admin Notification Center gained per-trigger **message templates**: a customizable title and
  body per trigger type, with `{{placeholder}}` autocomplete, a live preview rendered against
  sample data, and a "Send test" button per template.
- The Dashboard panel Range field, Monitor detail's own range picker, the Home/My Dashboards time
  filter, and each Logs page's filter form now share one Range field component (preset dropdown,
  Custom, or an absolute From/To pair), instead of each page carrying its own variant.
- Live Data gained multi-select bulk actions (Monitor selected / Widget selected) and a way to hide
  specific control states from the table.
- A Miniserver's last Loxone Logbook fetch error is now persisted and surfaced with a friendlier
  message when it's a permissions problem (HTTP 401/403), instead of only appearing transiently in
  the server log.

## [0.10.1-alpha.1] - 2026-08-04

### Added
- The Monitor detail page's own chart settings gained a **Y-axis unit**, **Value scale**, and
  **Decimals** — the unit field already existed but silently did nothing (see Fixed below); scale
  and decimals didn't exist on this page at all before. All three are independent per monitor, the
  same way a dashboard chart panel's per-series settings are — Value scale reuses the exact same
  `×0.001`–`×1000` preset dropdown (plus Custom…) a dashboard chart panel's own per-series scale
  picker already offers.

### Fixed
- The Monitor detail page's own "Y-axis unit" field silently did nothing when changed — its
  supporting JS (converting the preset dropdown into an actual submittable value) only ever loaded
  on a dashboard's panel-editor page, never on this one. Moved into the shared footer script so
  both pages get it.
  - Once wired up, the unit was still shared across every monitor's chart (bundled with
    legend/fill/stepped-line, which genuinely are one shared style) rather than specific to the one
    monitor it was set on — moved alongside the new Value scale/Decimals so each monitor's own unit
    is independent, with a fallback so a monitor already using the old shared field doesn't lose it
    until its next save.
  - A per-monitor Decimals setting was accepted but never actually applied to the chart's own
    Y-axis tick labels, which always fell back to the global default regardless — only the
    tooltip honored it. The axis now uses whichever monitor's own Decimals is assigned to it,
    same tie-break logic already used for a shared axis's unit.
- Filling the area under a chart's line no longer reaches the very top/bottom edge of the chart,
  now that the axis leaves ~10% headroom above/below the data (see 0.9.1-alpha.1) — that headroom
  is now skipped whenever Fill area is on, since a filled area already reads as "full" flush against
  the edges without needing it (unlike a bare line, which is what the headroom was added for).
- The Hardware page's MAC column now strips the `:` separators and lowercases the result, so a MAC
  and Serial that are the same underlying identifier (common on Loxone Tree/Air devices) read
  identically instead of only an attentive reader noticing "0F:9B:6D:66" and "0f9b6d66" match.
- The Monitor detail page's raw-readings table header now reads "Raw value" instead of "Value" —
  it intentionally still shows the literal unscaled reading regardless of any unit/scale set above.

## [0.10.0-alpha.1] - 2026-08-04

### Changed
- **License changed from MIT to AGPL-3.0-or-later.** Every release up to and including
  0.9.2-alpha.1 stays available to anyone who already has it under MIT terms — this only applies
  going forward.
- The Hardware page's dedup (see 0.9.2-alpha.1) is now generalized beyond Audioservers/Stereo
  Extensions: any hardware row with a real Serial or MAC is deduplicated across Miniservers that
  both report it, not just audio devices — matches how a Loxone Gateway Client setup actually
  behaves (a Gateway's own `/data/status` already includes its Clients' hardware, on top of each
  Client separately reporting that same hardware from its own).
- Live Data's Miniserver dropdown now only lists Miniservers that are currently online (except
  whichever one is already selected) — an offline one has no live connection to switch to, so it's
  no longer offered as a choice that just won't work.
- The hints-toggle button (Monitor/Dashboard panel settings, and now also the Add/Edit Miniserver
  forms, MQTT Broker, and Settings pages) uses a lightbulb icon instead of a question mark.
- Any `[data-toggle-row]` button, sitewide, now fills in with the accent color while its target is
  open — previously just the Miniservers page's own diagnostics/Client-group buttons.
- The Hardware page's two introductory paragraphs were removed — they didn't add anything a
  first-time visitor needed.

### Added
- **Loxone Gateway Client support**: a Miniserver can now be explicitly flagged as a Gateway with
  its own inline-managed Client Miniservers — the Add Miniserver form, Edit Miniserver form, and
  the Setup Wizard's Miniserver step all share the same UI (name/host/port/HTTPS per Client, shared
  credentials, batch Test).
  - The Miniservers list, and the home dashboard's own Miniservers table, show each row's
    relationship: Standalone, "Gateway · N clients", or `Client – <Gateway name>` — Clients
    render as real sibling rows directly under their Gateway, toggled open/closed with a dedicated
    share-icon button (or the page's own "Expand/Collapse all clients" button), independent of that
    row's own diagnostics panel.
  - Updating a Gateway's firmware also updates every one of its Clients.
  - Drag-and-drop reordering keeps a Gateway's Clients grouped under it, and keeps each row's own
    diagnostics panel attached to it through a reorder.

### Fixed
- A stray `docker-compose.yml` edit had `MQTT_URL` pointing at `128.0.0.1` instead of `127.0.0.1`,
  which would have broken the bundled Mosquitto connection on a fresh install.

## [0.9.2-alpha.1] - 2026-08-04

### Added
- The Hardware page now shows each device's **Serial** and **MAC** address as their own columns
  (the data was already being collected, just never surfaced).

### Fixed
- A Loxone **Gateway Client** setup (one Miniserver sharing its Audioserver with another) no
  longer lists the same physical Audioserver and its Stereo Extension zones twice, once per
  Miniserver that can see them — deduplicated by MAC address, since it's the same hardware either
  way.
- The Hardware page's category filter had two identically-labeled "Plugin device" options with no
  way to tell them apart — the Plugin's own GenDev children (the individual devices it exposes,
  e.g. each Home Connect appliance) are now labeled "Plugin sub-device" to distinguish them from
  the plugin/bridge itself (e.g. an MCP Server plugin).
- Client Activity's device-name resolution only ever recognized Shelly's own "brandname-XXXXXX"
  client ID convention — a device whose client ID is "<product>_<name>" while its actual MQTT
  topic prefix is just "<name>" (e.g. a HeatMeister module: client ID "heatbooster_radiator-gang",
  topic prefix "radiator-gang") now also resolves to its friendly name, which in turn also makes
  "Suggest commands" appear for it (the family lookup uses that same resolved name).

## [0.9.1-alpha.1] - 2026-08-04

### Added
- A "?" button next to a chart/panel settings drawer's own star icon (Monitor detail page, Dashboard
  panels) toggles every help-text paragraph in that drawer on/off, sitewide — hidden by default
  (someone configuring their hundredth panel doesn't need to be told what Stepped line does), one
  click away for whoever wants it. Highlights in the app's accent color while active, and stays in
  sync across every panel's own drawer on a dashboard, not just the one it was clicked in.
- The threshold builder's own help text now explains what **Style** (Line/Band) actually does —
  previously only a hover tooltip, easy to miss entirely.
- The favorite-star button on My Dashboards now lives in the row's own Actions group, with an
  "Add to favorite"/"Remove from favorite" text label, matching the button already on a single
  dashboard's own page.
- The sidebar's version number is now a link to this project's GitHub releases, combined onto one
  line with the "update available" badge instead of two stacked lines. Administration > General's
  own version card shows Installed/Available on separate lines and adds a GitHub page button
  alongside Check for updates/View changelog.
- Logs now has its own expandable sidebar section (System, Notifications, Loxone Miniservers,
  Loxone Commands, MQTT Broker) instead of one flat link — the in-page tab strip repeated at the
  top of each of the five Logs pages was removed since the sidebar now covers that navigation.
- Live Data (Loxone) now has its own row in Access Roles instead of silently piggybacking on the
  Miniservers permission — existing roles keep whatever access to it they already had via
  Miniservers, this just makes the two independently grantable going forward.

### Fixed
- **Notifications**: clicking through to one unread notification's source (or dismissing it) no
  longer incorrectly marks every OTHER, never-looked-at notification as read too — confirmed as a
  real bug (2 unread events, clicking the newer one's link cleared the badge to 0 instead of 1). The
  unread count and the initial page-load badge now both check genuine per-item acknowledgement
  instead of a single shared watermark that any one item's id could jump ahead of the others on.
- A monitor/dashboard chart's y-axis now leaves ~10% headroom above/below the actual data range —
  a line no longer runs flush along the very top/bottom edge of the chart area.
- The "?" hints-toggle button's own color was backwards — green ("active") lit up the moment hints
  were HIDDEN, the default state, instead of when they're shown. Green now means "help text is
  currently on," matching the same convention the Hardware page's own Alert buttons already use.
- A threshold line's value label flips to below the line instead of above it when there isn't
  enough room to the chart's own top edge — previously it could get clipped clean off by the
  canvas's own edge for a threshold sitting near the top of a tight range.
- The Monitor detail page's own chart settings drawer no longer blurs the chart underneath it while
  open — the chart now lifts above the backdrop, gets the same accent-colored highlight border, and
  re-centers next to the drawer, exactly matching how a dashboard's own panel-being-edited already
  behaves (only the title/range tabs/history table stay blurred, same as everything NOT currently
  being edited on a dashboard). Its width now also always shrinks to actually fit next to the
  drawer instead of just centering within room that might not be there, with a guaranteed gap on
  both sides of the highlighted card rather than however much (or little) centering happened to
  leave over.
- The pagination bar's row count ("N rows") is no longer bunched up hard against the Next button
  with an inconsistent double gap — it's now pinned to the opposite side, clearly separated from
  the Prev/page-numbers/Next cluster.
- A dashboard panel's "Edit panel" drawer's own Close (×) button rendered narrower than the star/"?"
  buttons beside it — it was a plain `&times;` character instead of the same SVG icon the other two
  use, so its box shrank to fit a smaller glyph. All three are the same width now.
- A dashboard's My Dashboards list rendered its favorite star grey even when a dashboard genuinely
  was favorited (a generic table-button style rule was winning a same-specificity CSS tie against
  the favorited-state color) — now consistently amber/filled everywhere, list and detail page alike.
- The pagination row count still wasn't vertically centered with the Prev/page-number/Next buttons
  in every case (a leftover margin from the shared `.hint` class was itself winning a further
  same-specificity cascade fight) — and single-digit page buttons (1, 2, 3…) had their number
  sitting visibly left of center within the button's own minimum width.
- Dark theme: the small "Loxone (direct, polled): ..." subtitle line under a page's title had
  noticeably lower contrast against the accent-colored glow behind the header — brightened.
- The very same subtitle line had its own top ~6px clipped off on any page that renders an
  invisible overlay element before it in the markup — e.g. the Monitor detail page's own edit
  backdrop, present only when you can edit the chart — because the existing anti-clipping CSS only
  matched a hint that's the literal first child of `<main>`, not the first *visible* one.
- style.css/tables.js/monitor-chart.js are now served with a cache-busting version query tied to
  this run's own boot time, so a browser that cached an older copy always picks up the actual
  current files after a restart instead of needing a manual hard refresh.
- Radar/spiderweb charts: the web/spoke lines and axis value labels used Chart.js's fixed default
  styling, nearly invisible on dark theme; both are now theme-aware, and the little backdrop box
  behind each axis number is gone.

## [0.9.0-alpha.1] - 2026-08-04

### Added
- A new **Hardware** page (Loxone section) listing every piece of hardware a Miniserver's own
  `/data/status` endpoint reports: the Miniserver itself, Extensions, Audioserver zones, and the
  Air/Tree/1-Wire/Plugin devices attached to it — one flat, filterable (category dropdown +
  free-text search), sortable table. Polled every 5 minutes in the background; entirely skipped for
  a Miniserver currently offline or rebooting, so a reboot never floods the table (or an alert)
  with every attached device briefly reporting offline at once. Battery 127 (mains-powered, not a
  real percentage) shows as "External power" instead.
- Three new notification rule types, each with its own configurable severity: **Loxone device
  battery weak**, **Loxone device firmware changed**, and **Loxone device online/offline** — a
  single rule (optionally scoped to one Miniserver) covers every device of that kind automatically,
  current and any added later, no per-device setup. The Hardware page's own toolbar has one-click
  "Alert ..." buttons per type (green = enabled, gray = disabled/not yet set up) as a shortcut to
  the common "Any Miniserver, default severity" case.
- Every hardware battery/firmware/online-offline transition is now also written to the existing
  Logs → Loxone Miniservers log unconditionally, whether or not a notification rule exists for
  it — logging and alerting are independent.
- Miniservers can now be reordered by dragging a row's own handle — this is no longer just cosmetic:
  it's the one shared, authoritative order every other page that lists Miniservers (Logs, Mappings,
  Monitor, Notifications, Hardware, Live Data, the dashboard, ...) now queries by, instead of each
  picking its own (previously an inconsistent mix of alphabetical-by-name and by-id).

### Fixed
- A table's pagination no longer jumps back to page 1 on every periodic background refresh
  (Logs, Client Activity, Hardware, ...) — it only resets to page 1 on an actual filter/sort change,
  not merely because the page silently refreshed itself while you were reading page 3.
- `notification_rules.trigger_type`'s CHECK constraint never actually included
  `loxsuite_update_available`, despite it being offered as a creatable rule type since it was added —
  every attempt to create one was silently rejected by SQLite. Caught and fixed while widening this
  same constraint for the three new hardware trigger types above.
- The `monitor_history` retention cleanup (`DELETE ... WHERE recorded_at < ?`) had no usable index —
  its only index led with `monitor_id`, useless for a query with no `monitor_id` filter — forcing a
  full table scan that got slower as history grew. Added a dedicated index, the same fix
  `notification_events` already had.

## [0.8.0-alpha.1] - 2026-08-03

### Added
- A **"Create RGB + White mappings"** button on Suggest Commands, shown for device types that need
  the Shelly RGBW/White transform (Shelly RGBW2, Shelly Bulb) — creates both the RGB and White
  Loxone → MQTT mappings in one step, already pointed at the right shared topic with the correct
  transform and mode preselected, instead of having to add each one by hand and remember to pick
  `shelly_rgbw` (not `passthrough`) and the right mode on both.

## [0.7.3-alpha.1] - 2026-08-03

### Added
- A second Shelly RGBW/White mode, **"RGB (Loxone's Analog input RGB)"**, for Loxone's own
  "Analoge ingang RGB" virtual output — it packs all three channels into one number
  (`red% + green%×1000 + blue%×1000000`), a completely different convention from the H,S,V-based
  RGB mode already there. Both modes coexist; pick whichever matches the actual Loxone output
  you're wiring up. Verified end-to-end against a real RGBW2: three real Loxone-generated values
  (representing ~100% red / ~100% blue / ~100% green) all decoded to the correct dominant channel,
  confirmed via the device's own status topic.

## [0.7.2-alpha.1] - 2026-08-03

### Fixed
- The Shelly RGBW/White transform's on/off now reflects **both** the RGB and White mappings
  together, not just whichever one happened to publish last: off only once every channel
  (red/green/blue/white) is genuinely zero, on the moment any of them isn't — matching how a real
  Loxone RGBW output actually signals off (sending zero on every channel at once, not just one).
  Previously White alone controlled on/off and RGB never touched it at all, which meant a
  same-family light that used the RGB mapping to indicate on/off never actually turned on.
- A bare, unqualified `rgb 0` (no comma) is now treated as true zero — red:0,green:0,blue:0 — not
  hue 0° (which is mathematically pure red). This was silently breaking the "all channels zero"
  off detection: Loxone's own off sequence sends `rgb 0` specifically to mean nothing, and it was
  instead being turned into full red. An explicit comma-separated `H,S,V` still means exactly what
  it says even when H is 0 — only the bare shorthand gets this special case. Verified via the
  published JSON for all four transitions (both zero -> off, either one going nonzero -> on, back
  to both zero -> off again) — not re-confirmed against the physical device's own status topic
  this round the way earlier RGBW2 fixes were.

## [0.7.1-alpha.1] - 2026-08-03

### Fixed
- The Shelly RGBW/White transform's RGB mode forced the light **on** with every single color
  update — harmless on its own, but a real problem once a Loxone Lighting Controller resends the
  RGB output alongside any brightness/white change on the same light circuit: turning the light off
  through the White mapping got silently undone the instant the next color refresh arrived. RGB
  updates no longer touch on/off at all; only the White mapping does now. Verified against a real
  RGBW2 — sent off via White, then a new color via RGB, and it stayed off with the new color applied.
- Logs → Loxone commands' "from/to" value history was keyed by MQTT topic alone — for a device
  like an RGBW2 in color mode, its separate RGB and White mappings both legitimately publish to the
  *same* topic (Shelly merges the partial JSON bodies itself), so each one's own history was
  actually showing whichever OTHER mapping had fired most recently, not its own. Now keyed by the
  mapping itself.
- The Shelly RGBW2/Bulb Common Commands templates' "White channel" preset pointed at
  `/white/{channel}/command` — the topic for the device's *other*, mutually exclusive operating
  mode (four independent white channels), not the color-mode device these templates are actually
  for. Removed (there's no real "toggle just white" in color mode — that's the whole-light on/off
  below), and replaced with reference-only "Set color"/"Set white %" entries showing the real
  `/color/0/set` topic and value shape a Loxone RGB/White output actually needs (this page never
  publishes anything itself — it's suggestions to copy into a mapping's own Shelly RGBW/White
  transform). RGBW2 verified against a real device; Shelly Bulb updated the same way by inference
  (identical documented API), not separately tested.

## [0.7.0-alpha.1] - 2026-08-03

### Added
- **Pagination**: any table with more rows than your own "Rows per page" setting (Profile → Account,
  default 25) now paginates automatically, with Prev/Next and a windowed set of page-number buttons
  (first 3, last 3, current page and its neighbors, "…" for the gap). Works alongside every
  existing per-page search filter and column sort without conflicting with either.
- **Monitor**: a search bar (matching every other filterable table in the app), with a Dashboard
  column that's now clickable straight through to each dashboard, and a "None" badge instead of a
  bare "-" when no notification threshold is set.
- Settings → Broker connection shows the same live "Connected"/"Not connected" badge the home
  dashboard already has, next to the page title.
- Admin → General: a "Check for updates now" button (the existing daily check only ever re-read
  its own cached result — this actually triggers a fresh GitHub lookup) and, when a newer version is
  found, a changelog dialog pulled straight from that release's own CHANGELOG.md.
- Live Data and Monitor's search filters gained a clear ("×") button and Escape-to-clear — since
  rolled out to every other search bar in the app (Incoming Clients/Messages, both Mapping pages)
  for consistency.
- The topbar bell's own popover list is now clickable the same way Logs → Notifications already is
  — straight to a threshold breach's own Chart settings drawer (already expanded), or a status/
  firmware change's Miniserver diagnostics panel. Dismissing an item (or clicking through) now also
  marks it — and anything older — read, so the badge count actually reflects it.
- "Rows per page" lives on Settings → General now (still your own per-user value, not shared) —
  folded into that page's single existing Save button rather than a second one of its own.
- The Shelly RGBW/White transform (Loxone → MQTT mapping) now also accepts a value prefixed with
  its own mode name ("rgb 17", "white 20.0") — some real-world Loxone virtual output configs send
  it that way rather than the plain "H,S,V"/percentage this was originally written against. Also
  accepts a bare hue number (no comma) for RGB, at full saturation/brightness. Verified end-to-end
  against a real RGBW2: hue 0/120/240 produced exactly red/green/blue, confirmed via the device's
  own status topic.

### Fixed
- A bug in creating a dashboard from Live Data's "Suggest dashboard" flow could crash the whole
  gateway process — and since the container stops itself if either of its two processes dies, that
  took Mosquitto down with it too. The route now catches its own errors and returns a normal 500,
  and a process-level safety net was added so no future uncaught error in any route can do this
  again.
- The version-check card wrongly blamed "offline, or GitHub unreachable" even when the real reason
  was simply that no release had ever been tagged yet — now distinguishes the two.
- A stray z-index rule meant a search bar's own clear ("×") button was hidden behind the input the
  moment you actually clicked into the box — only visible while it *wasn't* focused, backwards from
  the point of the button.
- Dismissing a notification from the bell popover previously left it still counted in the unread
  badge — dismissing now advances the read watermark the same way clicking through already does.
- Tables.js's own pagination toggle (`hidden = true`) silently had no effect once a table had any
  filter narrowing it below one page's worth of rows — an unrelated `display` rule on the same
  element was overriding the browser's default `[hidden]` behavior.

## [0.6.1-alpha.1] - 2026-08-03

### Fixed (stability)
- A bug in creating a dashboard from Live Data's "Suggest dashboard" flow could crash the whole
  gateway process — and since the container stops itself if either of its two processes dies,
  that took Mosquitto down with it too. The route now catches its own errors and returns a normal
  500 instead, and a process-level safety net was added so no future uncaught error in any route
  can do this again.

### Added
- **Monitor**: a new **Notification** column — shows whether a monitor's own threshold ladder (its
  chart settings, edited from this page) has at least one rung flagged **Notify**, without having
  to open each monitor's own chart settings to check.
- Logs → Notifications: the **Source** column is now a link straight to whatever the event was
  actually about — a Monitor's own detail page for a threshold breach/notify rung, or the
  Miniservers page with that row's diagnostics panel already open for a status/firmware change
  (new `?open=<id>` support there). The other three trigger types (MQTT client status, backup
  failure, LoxSuite update available) have no single entity of their own to land on, so those stay
  plain text. The topbar bell's own popover list now links the same way — clicking through to an
  item's source there also marks that notification (and anything older) as read.
- Live Data's Control/state filter now has a clear ("&times;") button in the search box, and
  pressing **Escape** while it has focus clears the filter the same way.
- Settings → Broker connection now shows the same live "Connected"/"Not connected" status badge as
  the home dashboard, right next to the **MQTT Broker** title — previously you could only see this
  on the home page.

### Fixed
- The Notification Center bell's unread badge cleared the moment you opened the popover, even if
  you'd only glanced at it — now only clears via **Mark all read**, **View all**, or once there's
  genuinely nothing left unread.
- The bell popover's own list of events only ever reflected whatever was baked into the page at its
  last full load — the unread badge already polled live, but a notification that arrived while you
  stayed on one page without navigating didn't show up in the list itself until an actual page
  reload. Now polls alongside the badge (same 60s cadence, same "don't overwrite what's currently
  open" guard).
- Logs → Notifications: a **warning**-severity row showed a plain gray badge instead of the
  existing yellow "warning" style already used elsewhere in the app — a leftover placeholder class
  that was never updated to the real one.
- Live Data's **Control / state** filter left every room visible regardless of match, even an
  already-expanded one with nothing matching in it — only a room that's never been expanded at all
  (nothing loaded yet to check) still stays visible now, since hiding that one really would be a
  guess. That fix alone still meant a non-matching room only disappeared once you happened to click
  it open yourself, so typing a query now also auto-expands every not-yet-loaded room right away —
  it correctly drops out (or stays, if it matches) the moment its own content actually arrives.
- Live Data's filter also never actually cleared: emptying the search box out was supposed to
  restore every hidden room/category/row, but a leftover early-return above that reset code made it
  unreachable, and even then it never touched individual rows. Clearing the box (or now, Escape/the
  new clear button) properly restores everything again.

## [0.6.0-alpha.1] - 2026-08-03

### Added
- **Device templates**: every Common Commands/Data device (all 16 named Shelly Gen1 types,
  Shelly Gen2/Gen3, and the new SDR Innovation HeatMeister below) is now a plain `.json`/`.xml`
  file under `device-templates/`, read once at startup — drop your own file in that same folder to
  add or override a device, no code or UI editing required. An invalid file is skipped with a log
  line naming the file and the problem, not a broken catalog. A generic fallback device (like
  Shelly's own "other/unlisted model") can set an explicit `order` so more specific devices are
  still auto-detected first.
- **SDR Innovation HeatMeister** (radiator/fan-coil controller): fan boost/control mode, fan
  speed, ambient temperature control, and the external sensor-override topics as commands; control
  state, fan speed, all four temperatures, and WiFi/firmware/runtime as data — confirmed against
  its own protocol spec and a real installation. A separate "Home Assistant discovery" variant
  publishes MQTT Discovery configs for the same topics (LoxSuite's own addition — Home Assistant
  has no native integration with this device).
- **Notification Center**: a "LoxSuite update available" trigger type — the sidebar's existing
  daily GitHub tags check can now also log here and notify a channel, not just show its own badge.
  Each item gained a "×" to dismiss just that one from your own popover (not a delete — it still
  shows in Logs → Notifications and everyone else's popover), and a "Mark all read" button at the
  bottom.
- **Users (MQTT accounts)**: an off-by-default "Per-device MQTT roles" setting (Settings → MQTT
  Broker) — filling in a topic prefix when adding a device account creates a role scoped to just
  `<prefix>/#` and assigns it, instead of the shared `client` role with access to every topic.
- Mappings → MQTT to Loxone: the Virtual input name field now suggests names already used in
  other mappings, covering the common case of one Virtual Input receiving several commands.
- Logs → Loxone commands: a rejected row's **+ Mapping** button now also pre-selects Transport
  (HTTP/UDP) and Miniserver on the new mapping form, matching exactly what that command actually
  arrived as, instead of just pre-filling the topic.
- Dashboard: **Total messages since start** is now abbreviated past 1000 (`1.2K`, `3.4M`, full
  number on hover), same convention Live Messages' own per-topic count already used.

### Fixed
- A Loxone UDP Virtual Output command whose value contains spaces (e.g. a Shelly JSON payload like
  `{"turn": "off", "brightness": 30}`) got silently truncated to just its last few characters — the
  parser split on the *last* space in the whole message, which is the JSON's own last space, not
  the boundary between topic and value. Now matches against already-registered tokens/topics
  first, only falling back to the first space for a brand-new, not-yet-registered one.
- Dragging a table column wider or narrower didn't change how much of its own text showed — a
  truncated cell's ellipsis width was a fixed value, completely disconnected from the column's
  actual (possibly resized) width. Fixed together with a related issue where the very first resize
  on a table only took effect after the next page load, not during the drag itself.
- Miniservers diagnostics panel: the state row showed a redundant/opaque `PLC 5: Running` — now
  just `Running`, with the numeric code moved into the tooltip.
- **Upgrade safety**: an existing install upgrading to this version without also adding the new
  `device-templates` volume/path mapping (see Data and persistence in the README) ended up with an
  entirely EMPTY Common Commands catalog — every built-in device, not just custom ones, used to
  live only in that folder once the old hardcoded list was removed. The image now also carries its
  own always-available copy of the built-in devices, used as a fallback whenever the configurable
  folder is missing, empty, or not yet mounted, so a not-yet-updated `docker-compose.yml`/Unraid
  template degrades to "your own customizations aren't picked up yet," not "no devices at all."
- A missing `SESSION_SECRET` at boot (e.g. an Unraid container edit that blanked the field — see
  the Security section) silently fell back to an insecure hardcoded value with no indication
  anything was wrong, until every already-encrypted secret started failing to decrypt with errors
  that looked completely unrelated (MQTT "not authorised", a Miniserver HTTP 403, ...). The
  container log now prints an unmissable warning the moment this happens, naming the actual cause
  and what to do about it.
- Client Activity's **Suggest commands** shortcut only ever guessed "this looks like a Shelly" from
  the client id's own text — broke down for any device whose id isn't self-describing (a HeatMeister
  module is just whatever name you gave it in its own config, e.g. "radiator-gang", nothing in that
  string says "heatmeister"). Now uses the same family resolution Common Commands auto-detection
  already relies on, so it works for HeatMeister (and any future device template) too, not just
  Shelly. Also fixed HeatMeister's own two families (the real one and its Home Assistant discovery
  variant) sharing one topic pattern, which meant a real device could get auto-detected as the HA
  variant depending on file load order — the real one now always wins that tie.

### Changed
- Miniservers page: Firmware and Generation moved out of the main table into the diagnostics
  expand panel (labeled "Miniserver state" instead of "PLC state"), alongside the other
  per-Miniserver details; a bit more spacing between that panel and its action buttons.
- Monitor's "Loxone (direct)" source description corrected in the README — it already reads from a
  persistent, shared, pushed websocket connection (same one Live Data uses), not HTTP polling; the
  interval you set only controls how often a history *row* gets written from that live cache.

## [0.5.0-alpha.1] - 2026-08-02

### Added
- **Notification Center**: a bell icon next to Help, visible to every logged-in user, polling for
  new events every 60s — opening it marks them read and links to a full history under the new
  **Logs → Notifications** tab (its own permission area). Reuses the existing Apprise rule engine
  for delivery and adds two events that only ever show up here: **Firmware changed** (a
  Miniserver's reported version changed since the last check) and a per-rung **Notify** flag on any
  threshold ladder (Monitor or Dashboard chart), which logs directly without needing a separate
  rule/channel.
- **Dashboard chart panels**: five new snapshot chart types — **Bar (compare)**, **Doughnut**,
  **Pie**, **Polar Area**, **Radar** — comparing every selected monitor's *current* value side by
  side, alongside the existing time-series line chart.
- **Monitor detail page**: its chart is now as configurable as a Dashboard chart panel (appearance,
  thresholds with the new Notify flag, axis, annotations), via a resizable edit drawer with a live
  preview, plus save/reset-as-default across every Monitor's chart at once. The custom time-range
  field accepts absolute dates too (`1-8-2026`, `1-8-2026/-now`), Grafana-style.
- **Miniservers**: a **Generation** column (Miniserver Gen 1/Gen 2, Miniserver Go Gen 1/Gen 2,
  Compact) — `msInfo.miniserverType` from the structure file, fetched once per Miniserver (a
  physical device's generation never changes) and confirmed against Loxone's own official
  Structure File documentation before shipping, not guessed.
- **Loxone commands log**: a **+ Mapping** button on a "no matching mapping" rejected row (pre-fills
  the Loxone → MQTT add form with that exact topic) and a **+ Reject** button on an accepted row
  (disables its mapping on the spot).
- **Backups**: offsite copy (rclone) gained graphical setup forms for **S3-compatible** (AWS S3,
  MinIO, Wasabi, DigitalOcean Spaces, Cloudflare R2), **SFTP**, **WebDAV**, and **Backblaze B2** —
  each builds the underlying `rclone.conf` from plain fields (passwords obscured via rclone's own
  `rclone obscure`, never plain text) instead of requiring `rclone config` run elsewhere and pasted
  in. Pasting a hand-written config directly is still there for any of rclone's other 65+ backends.
- **Notifications**: a channel's **Service** picker gained graphical forms for **Email (SMTP)**,
  **Telegram**, **Slack**, **Microsoft Teams**, and **Discord** — paste the webhook URL/bot
  token/SMTP details the service itself gives you and the actual Apprise URL is built for you, with
  a live preview before saving. **Custom (Apprise URL)** still takes any raw Apprise URL directly.
- Per-table Columns menu: a column can now start hidden by default until explicitly shown (used for
  Miniservers' Generation/UDP port/External URL, all sparse for a typical row) — previously every
  column always started visible.
- Any single database query taking 200ms or longer is now logged to the System log — groundwork
  from investigating slow monitor-data loads on some self-hosting setups (e.g. Unraid), where a
  slow underlying disk is a real, visible-this-way possibility.

### Fixed
- The Miniservers table sorted alphabetically by name instead of by when a Miniserver was added,
  so a newly added one didn't reliably appear where expected.
- The Miniservers table needed horizontal scrolling to see the Actions column on common laptop
  widths, even before the new Generation column — tightened its padding and capped the Name column
  with a click-to-expand ellipsis instead of letting one long name stretch the whole table.
- A `required` form field inside a `hidden`-attribute ancestor (not the field itself) still blocked
  submission in Chromium, silently, with no visible error — confirmed empirically while building
  the new Notifications Service picker; toggling `required` itself, not just visibility, is what
  actually fixes it.
- The topbar notification bell wasn't visually centered in its circle (first a vertical offset, then
  a separate ~5px horizontal one from a `margin-right` rule meant for icon+label buttons bleeding
  onto icon-only ones) and was a slightly different, wrong shade of gray from the neighboring Help
  button (a copy/paste typo: `var(--text)` instead of `var(--text-muted)`).
- `loxoneStructure.js`'s `getStructure` (the in-memory, fetch-once-per-Miniserver structure cache)
  wasn't actually exported, only its higher-level derived helpers were — meant the new Generation
  lookup silently failed on its own require until this was found by exercising it against a real
  Miniserver rather than trusting a clean container boot alone.

## [0.4.1-alpha.1] - 2026-08-01

### Added
- **Monitor**: a new "Miniserver diagnostic" source — track CPU load, heap, or task count as a
  regular monitor with history/chart/CSV export. Fed from the Miniservers page's own existing
  background check, not polled a second time.
- **Miniservers**: **Add to Dashboard** / **Add to Monitor** buttons on the diagnostics panel pin
  CPU load, heap, and task count in one click — the former also adds each as a widget on the
  shared home Dashboard, the latter only starts recording history without pinning anything.
- A permanent "Demo (offline, for UI testing)" Miniserver, so empty/offline states have something
  to show without needing a real, reachable device.

### Fixed
- The Miniservers diagnostics panel's **Check for update**, **Update to latest release**, **Add to
  Dashboard**, and **Add to Monitor** buttons are now disabled (visible, not clickable) while that
  Miniserver is offline, instead of staying active against a device that can't answer.
- No button anywhere had visible `:disabled` styling — the explicit colors every button class sets
  override the browser's own default dimming, so a disabled button (Update to latest release
  before its first check, any button while offline, ...) looked exactly as clickable as an enabled
  one, and still lit up on hover. All five button classes now dim and ignore hover while disabled.
- Check for update / Update to latest release / Add to Dashboard / Add to Monitor now use the
  app's existing color convention (purple/yellow/green) instead of a plain bordered gray, matching
  every other action button in the app.
- Sorting a table while a row's expand-panel was open could send the wrong row to the top, or
  strand one behind — root-caused to the Miniservers row's own Actions-column overflow already
  generating its own "..." kebab expand-row, so a row could carry two stacked expand-rows, not
  one; the sort logic now re-pairs the whole chain instead of just the next sibling.
- A Miniserver's diagnostics panel could render at a visibly different collapsed height than its
  neighbor's — its card kept a fixed border and padding even while collapsed, which doesn't shrink
  to zero just because the row's height/overflow do.
- Duplicate `miniserver_id` form fields (a hidden one in the Loxone section, a visible one in the
  new diagnostics section) could both submit at once on the Monitor "Add" form, producing "Too
  many parameter values were provided" and a follow-on "monitor not found" for the partially
  created row. Fixed by disabling whichever section isn't active, plus a defensive fallback
  server-side.
- A rebuild landing mid-migration could leave a stale `monitors_new` table behind, crash-looping
  the gateway on every subsequent boot. The `miniserver_diag` migration now runs inside a
  transaction with a `DROP TABLE IF EXISTS` guard, so a retry after an interrupted run is safe.

## [0.4.0-alpha.1] - 2026-08-01

### Added
- **Miniservers**: an expandable diagnostics panel per row — PLC run state (Loxone's own
  documented 0-8 values), CPU load, heap usage, task count, firmware date, and update channel, via
  Miniserver HTTP commands not in Loxone's official API reference but individually verified
  against real firmware. **Check for update** reads the current release channel and unlocks
  **Update to latest release**, which sends a real update command (confirmation dialog spells out
  the consequences — this is a genuine firmware update and reboot, not a dry run). The background
  check interval is now configurable in Settings (default 60s, 10s minimum) instead of a fixed
  60s. "Test now" and the Add-Miniserver test both gained a **Loxone API** line, confirming the
  response actually looks like a Loxone Miniserver's own API rather than just "something answered
  HTTP" (what the existing Local/External checks prove).
- **Dashboard panels**: a star/reset pair on every panel's Edit form — star saves that panel's
  whole appearance as the default for every panel of that type *on that specific dashboard*; reset
  applies it back. Line/series colors remap by monitor *position* rather than id, so a saved
  default still makes sense applied to a panel wired to entirely different monitors.
- **Suggest dashboard** (Live Data): the preview is now editable before creating anything — **+
  Add** pins another state of a control already in a bucket (e.g. a climate control's target
  alongside its actual reading), and any item's panel type or bucket can be overridden per item.
- **MQTT Roles**: an existing ACL's type/topic/allow can be edited in place instead of removing
  and re-adding it.
- **Access Roles**: a **None** button clears every log-permission checkbox for a role in one click.
- Connected Clients (Live Traffic) splits into **Devices** and **LoxSuite itself** tabs — the
  gateway's own connections (persistent broker connection, dynamic-security bootstrap, ad-hoc Test
  button use) now connect under a stable `loxsuite-...` client ID instead of a random one each
  time, specifically so they can be told apart from real devices here.
- Live Messages (Live Traffic) shows a running total topic count, and abbreviates each topic's
  message count past 1000 (`1.2K`, `3.4M`) for a broker that's been running a long time.
- MQTT over WebSocket support (port `9001`) can now be added retroactively to an existing
  install — see the upgrade note under 0.3.1-alpha.1 below.

### Fixed
- **Suggest dashboard**'s Lighting bucket matched any generic `Switch`/`Pushbutton` control
  regardless of its actual category — a ventilation "turbo" button, a shading lock flag, or a
  media trigger could all get miscategorized as lighting purely by control type. Those two types
  now only match Lighting via Loxone's own `lights` category tag; `Dimmer`/`LightControllerV2`/
  `ColorPickerV2` (unambiguous regardless of category) still match by type alone.
- Firmware version on the Miniservers page was silently always blank on at least one real
  Miniserver — it read `msInfo.swVersion` from the structure export, which doesn't exist in that
  field on real hardware. Switched to a dedicated `/jdev/cfg/version` command.
- A disconnected MQTT client that was still marked "Connected" at the exact moment of a gateway
  restart stayed stuck showing Connected forever afterward (the broker restarts in lockstep with
  the gateway, so nothing from before a restart can still genuinely be connected, but the process
  dying doesn't get to log a clean disconnect line for whoever was live at that instant). The first
  log replay after each restart now sweeps any such leftover into Disconnected.
- A Viewer-role user on the Settings page saw the page's shell but no content (every field there
  is edit-only, so a view-only grant was a dead end) — Settings nav links now gate on edit access
  instead of view.
- The Administration nav link (sidebar and Help) pointed at the Users tab instead of General.
- Uneven spacing around Monitor/Client Activity toolbar buttons that have a `data-confirm`
  dropdown — the confirm bar's zero-width collapsed state was still consuming a full flex `gap` on
  both sides, doubling the visible space around those specific buttons.
- Saving or resetting a panel's default appearance closed its still-open Edit drawer, and (briefly)
  broke the drawer's own autosave content-patching for every panel on the page — an earlier
  version's cross-DOM `button[form=]` trick added extra elements the patch logic mistook for panel
  content. Replaced with a plain `fetch()` that adds no DOM nodes and patches just that panel's
  own rendered content in place.

## [0.3.1-alpha.1] - 2026-08-01

### Added
- The bundled Mosquitto broker now also listens for **MQTT over WebSocket** on port `9001`
  (`ws://<gateway-host>:9001`), alongside plain MQTT on `1883` — same accounts, roles, and ACLs
  either way. For browser-based MQTT clients/dashboards that can't open a raw TCP socket. Only
  written into a genuinely fresh `mosquitto.conf`, same as the rest of that file — add
  `listener 9001` / `protocol websockets` to an existing one yourself to pick it up on upgrade.

## [0.3.0-alpha.1] - 2026-08-01

### Fixed
- **Critical**: the dynamic-security bootstrap (creating the gateway's own MQTT broker account on
  first boot) read the MQTT password straight out of the database without decrypting it, so the
  broker account ended up with the *encrypted ciphertext* as its actual password — mismatched
  against the real password the gateway itself tries to authenticate with. This broke the MQTT
  connection on every fresh bootstrap since encryption at rest was introduced in 0.2.0-alpha.1
  (a brand new install, or an existing one whose `dynamic-security.json` was ever reset).
- Setup wizard buttons that sit next to a Test button (Continue/Save & continue/Add & continue)
  were a few pixels lower than their neighbor — a login-page-only CSS rule's `margin-top` was
  bleeding onto every `.primary` button in the wizard, not just the login form's own submit button.

### Added
- Setup wizard: a new **MQTT Broker** step (host/port/TLS/username/password, pre-filled with the
  already-working bundled-broker connection), with the same ad-hoc **Test** button the Miniserver
  step already had.
- **Administration -> General**: a new first tab holding "Run setup wizard again" (moved out of
  the general Settings page, where it didn't fit alongside per-account preferences).

### Changed
- Setup wizard step badges: redesigned as plain single-line text (no boxed/pill background),
  checkmark shown before the label. A step's checkmark now only appears once that step has
  actually been submitted (Skip or a real save) — previously a step could show complete just
  because its default state happened to already be "valid" (e.g. SSO disabled), even if nobody
  had looked at it yet.

## [0.2.2-alpha.1] - 2026-08-01

### Fixed
- Unraid template: `ADMIN_PASSWORD`, `SESSION_SECRET`, `MQTT_PASSWORD`, and `MQTT_ADMIN_PASSWORD`
  are no longer masked in Unraid's Edit Container screen. A masked field always renders blank
  there regardless of whether it's actually set, and clicking Apply while it looks empty silently
  saves that blank value over the real one — which is exactly what caused the SESSION_SECRET
  incident in 0.2.1-alpha.1. Showing the real value beats hiding it from a screen glance on a
  self-hosted single-admin box.

### Added
- More README screenshots: Live Data, and the Administration Backups/Notifications/Security pages.

## [0.2.1-alpha.1] - 2026-08-01

### Added
- **Emergency password reset** — drop a `reset-password.txt` file (containing a username) into the
  `Data` volume and restart; that account gets a fresh random password printed once to the
  container log, and every session is signed out. For anyone locked out of the web UI without
  container/database access.

### Changed
- Documented, more prominently, that `SESSION_SECRET` must stay the same across restarts once
  set — it's now also the key secrets are encrypted with (see 0.2.0-alpha.1), not just the session
  cookie signing key it always was. Changing it after secrets have already been encrypted makes
  them unreadable (not lost — they can be re-entered once `SESSION_SECRET` is stable again).

## [0.2.0-alpha.1] - 2026-08-01

### Added
- **Encryption at rest** for every secret LoxSuite has to actively use (not just check a login
  against): Miniserver passwords, the MQTT broker password, the SSO client secret, and any saved
  `rclone.conf`. AES-256-GCM, key derived from `SESSION_SECRET` — no new required environment
  variable. Existing plain-text values are encrypted automatically on first boot after upgrading.
- **Setup wizard**: three new steps (Single Sign-On, Backups, Notifications), all optional and
  skippable like the rest of the wizard. The Miniserver step gained the UDP port/External URL
  fields and Test button the regular Add Miniserver form already had. Step badges are clickable
  and show a checkmark once that step's own state is complete.
- **Administration -> Security**: the login page's rate limit (attempts and time window) is now
  configurable, instead of a fixed 10-per-15-minutes.

### Fixed
- The setup wizard's Miniserver step sent you straight to the last step instead of the next one
  when a Miniserver was already configured.
- A dashboard panel's Test/Add buttons in the wizard sat on their own row above Skip/Continue
  instead of alongside them.
- Two "Known scope limitations" entries in the README were stale — a Shelly RGBW/White/Tunable
  value transform and live-websocket-backed Loxone monitors were already built, just not
  documented as such.

## [0.1.0-alpha.1] - 2026-07-31

### Added
- **Dashboard charts**: fill-under-line, stepped lines, point markers, a linear or logarithmic
  Y-axis with an optional fixed min/max, scroll-to-zoom/drag-to-pan, threshold lines *or* filled
  bands, time-anchored annotations, and per-series overrides (rename, unit, scale, decimals,
  right-hand axis, color, line style/width).
- **Auto order**: resizes every dashboard panel to fit its own content, then repacks them with the
  fewest gaps, in one click. Every panel type's Edit form is now grouped into the same labeled
  sections (Appearance, Axis, Condition, ...) regardless of type.
- **Dashboard sharing**: share a personal dashboard with specific users (viewer or editor) or with
  an entire Access Role; **Favorite Dashboards** stars one into its own sidebar section.
- **Notifications**: admin-wide alert rules/channels via [Apprise](https://github.com/caronc/apprise)
  (Monitor threshold, Miniserver/MQTT client status, backup failures), plus fully independent
  per-user notifications on the Profile page — a personal Apprise channel, personal trigger rules
  needing no admin involvement, and the option to subscribe to admin-wide rules too.
- **Command catalog**: 18 named Shelly Gen1 device types, Shelly Gen2/Gen3 (both the full RPC form
  and the simpler "command/switch:N" form), a matching telemetry catalog ("Common data"), JSON/XML
  catalog import & export, and a native Shelly RGBW/White/Tunable-white value transform for
  Loxone → MQTT mappings.
- **Monitor**: history table grouped by day/hour instead of one unbounded list; hover tooltips with
  time + value on the chart.
- Miniserver firmware version, shown alongside the existing Online/Offline status.
- Offsite backup copy via rclone (70+ storage backends), on top of the existing local
  scheduled/manual backups.
- A first-boot setup wizard, a GitHub release version check in the sidebar, a shared toggle-switch
  UI component applied across every admin settings page, and a first automated test suite.
- A GitHub Actions workflow publishing a Docker image to GHCR on every push to `main` and on
  version tags, and an Unraid Community Applications template (`unraid/loxsuite.xml`).

### Fixed
- Dashboard panels not visually refreshing after being edited/saved, caused by a leaked
  `setInterval` that kept every previous edit's old chart polling in the background indefinitely.
- Drag-and-drop panel reordering flickering/jumping, and the resize cursor not showing while
  actively dragging a panel, drawer, or table column edge.
- A chart's plotted line silently connecting to the wrong value at "now" when its underlying data
  arrived newest-first, producing a spurious flat line across the whole chart.

### Changed
- Dashboard chart panels no longer set Decimals/Value scale at the panel level — every series sets
  its own now, matching how the Current Value panel type already worked.

## [0.0.1-alpha.1] - 2026-07-29

Initial alpha. First tagged snapshot after consolidating the stack into a single container.

### Added
- MQTT gateway with bidirectional Loxone &harr; MQTT mapping (HTTP and UDP transports).
- Monitor: value history over time with charts, tables, and CSV export.
- Custom dashboards (chart/table/current value/gauge/stat-with-change/threshold panels).
- Logs: live + persisted view of the Mosquitto broker log and each Miniserver's own log.
- Web UI with login, Users, Access Roles, and optional Pocket ID (OIDC) Single Sign-On.
- MQTT Users/Roles management backed by Mosquitto's dynamic-security plugin.
- Gateway database backup/restore, including scheduled backups and restore from existing storage.
- CSRF protection (synchronizer token) and login rate-limiting.
- `/healthz` endpoint and a Docker `HEALTHCHECK`.

### Changed
- Mosquitto now runs inside the same container as the gateway (previously three separate
  containers) — only one container (`loxsuite`) is visible externally.

### Known limitations
- No automated test suite yet.
- No autocomplete for Virtual Input names, no per-device MQTT topic ACLs, no device-specific
  value transforms beyond a plain translation table — see the README's "Known scope limitations".
- Miniserver/Audioserver backup (distinct from the gateway's own database backup) is not
  implemented — deliberately deferred, not an oversight.
