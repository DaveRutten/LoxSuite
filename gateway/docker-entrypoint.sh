#!/bin/sh
# Runs Mosquitto and the gateway as two processes inside one container, so only one container
# is visible from the outside (docker ps / Docker Desktop) even though they're still two
# independent programs internally. Plain POSIX sh, no bash-only features (e.g. `wait -n`),
# so this keeps working if the base image ever loses bash.
set -e

MOSQUITTO_CONF=/mosquitto/config/mosquitto.conf
DYNSEC_FILE=/mosquitto/config/dynamic-security.json

mkdir -p /mosquitto/data /mosquitto/log

# One-time migration, on a bind-mounted device-templates volume that predates the user/synced
# split (see deviceTemplates.js's getTemplateDirs): this volume used to get seeded ONCE, ever, from
# the image's own built-in defaults, then never touched again — so any file already sitting here
# permanently shadowed a newer built-in with the same name, forever, even after every later update.
# The built-ins are read directly from device-templates-defaults now (see Dockerfile), never
# copied in here at all, so this volume only ever needs to hold what the user actually put there.
# Staged into user.migrating/ then renamed into user/ as one atomic last step (mv within the same
# filesystem is atomic) specifically so this is safe to interrupt and retry: a kill mid-loop leaves
# some files already moved (skipped on retry, since they're no longer at the top level) while
# user/ still doesn't exist — so the whole block just runs again next boot instead of leaving a
# half-migrated, never-finished state. Every step is `|| true` (like the old seed line already
# was) so a read-only or unusually-permissioned bind mount degrades to "migration didn't run, the
# built-ins still work" rather than `set -e` aborting the whole entrypoint — which would also take
# mosquitto down with it.
mkdir -p /device-templates
if [ ! -d /device-templates/user ] && [ -n "$(ls -A /device-templates 2>/dev/null)" ]; then
  echo "Migrating existing device-templates into device-templates/user/ ..."
  mkdir -p /device-templates/user.migrating 2>/dev/null || true
  moved=0
  discarded=0
  for f in /device-templates/*; do
    base=$(basename "$f")
    case "$base" in user|user.migrating|synced) continue ;; esac
    # A file byte-for-byte identical to what this exact image already ships as a built-in adds
    # nothing — it's just an old, never-edited seed copy, not a customization — so it's dropped
    # here rather than migrated, instead of moving it in only to flag it as stale afterward (see
    # deviceTemplates.js's listTemplateSources, which still catches this same case for anything
    # already migrated before this check existed). Anything that DIFFERS still gets migrated,
    # deliberately erring toward keeping it: a file that's stale because the built-in changed SINCE
    # it was seeded looks exactly like a genuine customization from content alone — there's no way
    # to tell them apart here, only the admin looking at it can.
    if [ -f "/app/device-templates-defaults/$base" ] && cmp -s "$f" "/app/device-templates-defaults/$base"; then
      rm -f "$f" 2>/dev/null || true
      discarded=$((discarded + 1))
      continue
    fi
    mv "$f" /device-templates/user.migrating/ 2>/dev/null || true
    moved=$((moved + 1))
  done
  mv /device-templates/user.migrating /device-templates/user 2>/dev/null || true
  echo "Migrated $moved existing device-template file(s) into device-templates/user/ (discarded $discarded identical to a current built-in) - see the Device templates card under Administration -> General: any file flagged there as identical to a current built-in is safe to delete so the built-in (or a GitHub-synced update) takes over again."
fi
mkdir -p /device-templates/user /device-templates/synced 2>/dev/null || true

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
