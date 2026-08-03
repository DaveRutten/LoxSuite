#!/bin/sh
# Runs Mosquitto and the gateway as two processes inside one container, so only one container
# is visible from the outside (docker ps / Docker Desktop) even though they're still two
# independent programs internally. Plain POSIX sh, no bash-only features (e.g. `wait -n`),
# so this keeps working if the base image ever loses bash.
set -e

MOSQUITTO_CONF=/mosquitto/config/mosquitto.conf
DYNSEC_FILE=/mosquitto/config/dynamic-security.json

mkdir -p /mosquitto/data /mosquitto/log

# First boot only, on a fresh/empty bind-mounted device-templates volume — same "seed once, never
# again" idempotency as mosquitto.conf above, just checked by directory emptiness instead of one
# file's existence (there's no single fixed filename to check for here). The image's own copy at
# device-templates-defaults (see Dockerfile) stays untouched either way, so it's always there to
# reseed from if this volume is ever wiped.
mkdir -p /device-templates
if [ -z "$(ls -A /device-templates 2>/dev/null)" ]; then
  echo "Seeding device-templates with built-in examples..."
  cp /app/device-templates-defaults/* /device-templates/ 2>/dev/null || true
fi

# First boot only, on a fresh/empty bind-mounted config volume (e.g. a brand new Unraid appdata
# folder, or any host directory that's never had this stack running against it before). The image
# itself has no baked-in fallback to copy from here — mosquitto/config/mosquitto.conf lives at the
# repo root, one level above gateway/ (the Docker build context), so it's simply outside what the
# Dockerfile can COPY at all. Embedded directly rather than restructuring the build context around
# it — keep this in sync with mosquitto/config/mosquitto.conf in the repo if that ever changes.
# Idempotent: never overwrites an existing file, so a user's own edits survive every later restart.
if [ ! -f "$MOSQUITTO_CONF" ]; then
  echo "Writing default mosquitto.conf..."
  cat > "$MOSQUITTO_CONF" <<'MOSQUITTO_CONF_EOF'
listener 1883
allow_anonymous false

listener 9001
protocol websockets
allow_anonymous false

plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /mosquitto/config/dynamic-security.json

persistence true
persistence_location /mosquitto/data/
log_dest stdout
log_dest file /mosquitto/log/mosquitto.log
connection_messages true
MOSQUITTO_CONF_EOF
fi

# First boot only — mosquitto_ctrl writes this file directly, it doesn't need a running broker
# to talk to. Idempotent: does nothing once the file exists (same behavior as the old
# mosquitto-init container).
if [ ! -f "$DYNSEC_FILE" ]; then
  echo "Bootstrapping Mosquitto dynamic-security.json..."
  mosquitto_ctrl dynsec init "$DYNSEC_FILE" "$MQTT_ADMIN_USERNAME" "$MQTT_ADMIN_PASSWORD"
fi

# Mosquitto (Debian's own build) drops from root to its own unprivileged "mosquitto" system user
# as soon as it starts, unless told not to — same security posture the old, separate mosquitto
# container had. That means these paths need to be owned by that user, not root — and this also
# repairs files still owned by the *previous* container's "mosquitto" user, which was a different
# UID (a different base image, so "mosquitto" in /etc/passwd didn't mean the same number there).
chown -R mosquitto:mosquitto /mosquitto/config /mosquitto/data /mosquitto/log
chmod 600 "$DYNSEC_FILE"

mosquitto -c "$MOSQUITTO_CONF" &
MOSQ_PID=$!

node src/server.js &
NODE_PID=$!

stopping=0
shutdown() {
  stopping=1
  kill -TERM "$NODE_PID" 2>/dev/null
  kill -TERM "$MOSQ_PID" 2>/dev/null
  wait "$NODE_PID" 2>/dev/null
  wait "$MOSQ_PID" 2>/dev/null
}
trap 'shutdown; exit 0' TERM INT

# No `wait -n` (bash-only) — poll instead. Either process dying takes the whole container down;
# the compose restart policy brings both back up together.
while kill -0 "$MOSQ_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  sleep 2
done

if [ "$stopping" = "0" ]; then
  echo "One of the two processes exited unexpectedly — stopping the container so the restart policy can recover it."
  shutdown
  exit 1
fi
