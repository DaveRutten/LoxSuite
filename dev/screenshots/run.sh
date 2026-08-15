#!/bin/sh
# Regenerates every screenshot under docs/screenshots/ from a freshly seeded, entirely synthetic
# LoxSuite instance — no real Miniserver/broker/device data anywhere in this pipeline. Safe to
# re-run any time the UI changes enough that the docs screenshots go stale.
#
# What this does, end to end:
#   1. Builds (or reuses) the app's own Docker image and starts a throwaway container from it.
#   2. Installs Alpine's own system Chromium + playwright-core INSIDE that container — Playwright's
#      own bundled Chromium download is glibc-only and won't run on this image's musl/Alpine base
#      (confirmed the hard way; don't try `npx playwright install chromium` here, it downloads a
#      binary that just fails to exec).
#   3. Seeds a fresh SQLite DB with synthetic miniservers/mappings/monitors/dashboards/
#      notifications/hardware/backup data (seed-screenshot-data.js).
#   4. Starts a minimal fake Loxone Miniserver (fake-miniserver.js) — a real RSA/AES websocket
#      handshake, not a stub — so Live Data has real, populated room/category/value data instead
#      of an empty structure.
#   5. Starts the real app (node src/server.js) against that seeded DB.
#   6. Drives it with Playwright (take-screenshots.js) — light + dark, 1440x900, one shot per page
#      in docs/screenshots/*.png — and copies the results out.
#
# Usage: ./dev/screenshots/run.sh
# Requires: Docker, network access (apk + npm install run inside the container).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATEWAY_DIR="$REPO_ROOT/gateway"
OUT_DIR="$REPO_ROOT/docs/screenshots"
IMAGE="${IMAGE:-loxsuite-loxsuite:latest}"
CONTAINER="loxsuite-screenshots-run"

echo "==> Cleaning up any leftover container from a previous run..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> $IMAGE not found locally, building it (docker compose build loxsuite)..."
  (cd "$REPO_ROOT" && docker compose build loxsuite)
fi

echo "==> Starting throwaway container from $IMAGE..."
docker run -d --name "$CONTAINER" --entrypoint sleep "$IMAGE" 7200 >/dev/null

echo "==> Copying current app source into the container..."
docker cp "$GATEWAY_DIR/src" "$CONTAINER:/app/"
docker cp "$GATEWAY_DIR/public" "$CONTAINER:/app/"
docker cp "$GATEWAY_DIR/package.json" "$CONTAINER:/app/"
docker cp "$GATEWAY_DIR/package-lock.json" "$CONTAINER:/app/"

echo "==> Installing system Chromium (apk) + playwright-core (npm) — this needs network access..."
docker exec "$CONTAINER" sh -c 'apk add --no-cache chromium' >/dev/null
docker exec -w /app -e NODE_ENV=development "$CONTAINER" sh -c 'npm install --no-save playwright-core@latest' >/dev/null

echo "==> Copying the screenshot scripts themselves in..."
docker cp "$SCRIPT_DIR/fake-miniserver.js" "$CONTAINER:/app/fake-miniserver.js"
docker cp "$SCRIPT_DIR/seed-screenshot-data.js" "$CONTAINER:/app/seed-screenshot-data.js"
docker cp "$SCRIPT_DIR/take-screenshots.js" "$CONTAINER:/app/take-screenshots.js"

echo "==> Seeding a fresh synthetic database..."
docker exec \
  -e DB_PATH=/data/screenshot.db -e SESSION_SECRET=screenshot \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=admin12345678 \
  -e BACKUP_DIR=/data/backups -e FAKE_MS_HOST=127.0.0.1 -e FAKE_MS_PORT=7701 \
  "$CONTAINER" sh -c 'rm -f /data/screenshot.db && rm -rf /data/backups && node /app/seed-screenshot-data.js'

echo "==> Starting the fake Miniserver..."
# --security-revert=CVE-2023-46809: Node 20+ disables RSA_PKCS1_PADDING for private decryption by
# default; Loxone's own handshake uses PKCS#1v1.5 throughout with no alternative — safe to revert
# here specifically because this is a local, throwaway dev tool never exposed to real traffic.
docker exec -d "$CONTAINER" node --security-revert=CVE-2023-46809 /app/fake-miniserver.js
sleep 1

echo "==> Starting the app against the seeded database..."
docker exec -d \
  -e DB_PATH=/data/screenshot.db -e PORT=15590 -e SESSION_SECRET=screenshot \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=admin12345678 -e BACKUP_DIR=/data/backups \
  "$CONTAINER" sh -c 'cd /app && node src/server.js > /tmp/app.log 2>&1'
sleep 5

echo "==> Running the Playwright screenshot pass (light + dark, 13 pages each)..."
docker exec "$CONTAINER" sh -c 'rm -rf /data/shots'
docker exec -w /app "$CONTAINER" node take-screenshots.js

echo "==> Copying screenshots out to $OUT_DIR ..."
docker cp "$CONTAINER:/data/shots/." "$OUT_DIR/"

echo "==> Cleaning up..."
docker rm -f "$CONTAINER" >/dev/null

echo "==> Done. Review the diff (git status/diff docs/screenshots/) before committing —"
echo "    some pages (Dashboard especially) may need a manual click-through first; see this"
echo "    script's own git history / take-screenshots.js comments for the sections that already"
echo "    needed one (collapsing Status/Load/Miniservers, expanding Gateway/Client rows, ...)."
