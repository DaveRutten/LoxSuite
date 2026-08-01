# Changelog

All notable changes to this project are documented in this file.

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
