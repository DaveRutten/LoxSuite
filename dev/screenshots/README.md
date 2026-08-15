# Screenshot refresh pipeline

Regenerates every screenshot under `docs/screenshots/` (the light/dark pairs embedded in the main
README) from a freshly seeded, entirely synthetic LoxSuite instance. No real Miniserver, broker,
or device data is ever involved — everything on screen is invented for this purpose by
`seed-screenshot-data.js` and `fake-miniserver.js`.

## Usage

```sh
./dev/screenshots/run.sh
```

Needs Docker and network access (it `apk add`s Chromium and `npm install`s `playwright-core`
inside a throwaway container — nothing is installed on your host). Takes a couple of minutes.
Review `git diff docs/screenshots/` afterward before committing; not every page necessarily needs
a fresh shot just because the pipeline touched it.

## How it fits together

- **`fake-miniserver.js`** — a minimal fake Loxone Miniserver: serves `/data/LoxAPP3.json` and
  performs the real RSA/AES websocket handshake `gateway/src/loxoneWebSocket.js`'s client expects,
  then pushes live (synthetic) values. Without this, Live Data would only ever show an empty
  structure — Playwright can't get real per-control values out of the app any other way, since
  they live in an in-memory cache fed only by that handshake, never the database.
- **`seed-screenshot-data.js`** — seeds miniservers, mappings, monitors (+ 24h of history),
  dashboards (including a dedicated "Chart types" one — see its own comment on why that's separate
  from the shared home dashboard), notifications, hardware inventory, and backup settings directly
  into a fresh SQLite database. Run once per pipeline invocation, before the app itself starts.
- **`take-screenshots.js`** — Playwright, driving the seeded app at `http://127.0.0.1:15590`
  (`playwright-core` + Alpine's own system Chromium — Playwright's bundled Chromium download is
  glibc-only and doesn't run on this image's musl base). Logs in once, then for each of light/dark:
  navigates every page docs/screenshots/ has a shot of, expanding/collapsing whatever that
  particular page needs first (e.g. the Dashboard's own Status/Load/Miniservers sections, a
  Miniserver's Gateway/Client tree, a Live Data room + category) so the shot shows something
  meaningful rather than a fresh-session default state.
- **`run.sh`** — orchestrates all of the above inside one throwaway container built from the app's
  own image, and copies the results into `docs/screenshots/`.

## Adding a new page

Add a `page.goto(...)` + `shoot(page, 'name', theme)` call to `take-screenshots.js`, and reference
`docs/screenshots/name-light.png`/`name-dark.png` from the README same as the existing ones. If the
page needs data that isn't already seeded, add it to `seed-screenshot-data.js` — check the relevant
migration in `gateway/src/db/migrations/` for the exact columns before writing the `INSERT`.
