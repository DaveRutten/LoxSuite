#!/bin/sh
# Same as run.sh, but without Docker: runs the seed, the fake Miniserver, the app and Playwright
# straight from this checkout. Needs Node 20+, the gateway's node_modules (npm ci in gateway/) and
# Playwright with a Chromium (npm i -g playwright && npx playwright install chromium, or point
# CHROMIUM_PATH at an installed Chromium). Without internet set OFFLINE_TILES=1 for the car map.
#
# Usage: ./dev/screenshots/run-local.sh            (writes docs/screenshots/*.png)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATEWAY_DIR="$REPO_ROOT/gateway"
WORK="${WORK:-$(mktemp -d)}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/docs/screenshots}"

export APP_DIR="$GATEWAY_DIR" DB_PATH="$WORK/screenshot.db" SESSION_SECRET=screenshot \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=admin12345678 BACKUP_DIR="$WORK/backups" \
  FAKE_MS_HOST=127.0.0.1 FAKE_MS_PORT=7701 TZ=Europe/Amsterdam \
  NODE_PATH="$GATEWAY_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"

echo "==> Seeding $DB_PATH ..."
node "$SCRIPT_DIR/seed-screenshot-data.js"
node "$SCRIPT_DIR/seed-energy-data.js"

echo "==> Starting the fake Miniserver and the app ..."
node "$SCRIPT_DIR/fake-miniserver.js" > "$WORK/fake.log" 2>&1 &
FAKE_PID=$!
sleep 1
(cd "$GATEWAY_DIR" && PORT=15590 HTTPS_PORT=15591 node -r "$SCRIPT_DIR/offline-stubs.js" src/server.js > "$WORK/app.log" 2>&1) &
APP_PID=$!
trap 'kill $APP_PID $FAKE_PID 2>/dev/null || true' EXIT
# the app connects to the Miniserver, syncs the calendar and reads the car in its first minute
sleep 75

echo "==> Taking the screenshots ..."
SHOTS_DIR="$WORK/shots" APP_PORT=15590 node "$SCRIPT_DIR/take-screenshots.js"
mkdir -p "$OUT_DIR"
cp "$WORK/shots/"*.png "$OUT_DIR/"
echo "==> Done: $(ls "$WORK/shots" | wc -l) files in $OUT_DIR (work dir $WORK)."
