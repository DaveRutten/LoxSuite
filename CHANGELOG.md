# Changelog

All notable changes to this project are documented in this file.

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
  Loxone &rarr; MQTT mappings.
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
