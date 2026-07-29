#!/bin/sh
# Runs Mosquitto and the gateway as two processes inside one container, so only one container
# is visible from the outside (docker ps / Docker Desktop) even though they're still two
# independent programs internally. Plain POSIX sh, no bash-only features (e.g. `wait -n`),
# so this keeps working if the base image ever loses bash.
set -e

MOSQUITTO_CONF=/mosquitto/config/mosquitto.conf
DYNSEC_FILE=/mosquitto/config/dynamic-security.json

mkdir -p /mosquitto/data /mosquitto/log

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
