FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev

FROM eclipse-mosquitto:2 AS mosquitto

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Backs the Backups page's optional rclone offsite copy (see backup.js's uploadToRclone) — invoked
# as a plain child process rather than an npm rclone wrapper, since the real binary supports every
# backend (S3, Google Drive, SFTP, Backblaze, ...) rclone itself does, with no per-backend code of
# our own to maintain.
RUN apk add --no-cache rclone

# Backs the Notifications feature's Teams/Slack/Telegram/Email sending (see notifications.js) —
# same reasoning as rclone above: apprise already speaks 100+ notification services' own APIs
# correctly, shelled out to as a CLI rather than reimplemented per service here. Alpine's Python
# marks its system interpreter "externally managed" (PEP 668) by default, refusing a bare `pip
# install`; --break-system-packages is safe here since this image has no other Python use that a
# dependency conflict could break.
RUN apk add --no-cache python3 py3-pip && \
    pip install --no-cache-dir --break-system-packages apprise

# Mosquitto runs inside this same container, so the whole stack is a single container from the
# outside — docker-entrypoint.sh starts and supervises both processes. Vendored directly from the
# eclipse-mosquitto image (same Alpine 3.23 base as node:20-alpine, so musl/openssl/etc. are
# ABI-compatible) rather than installed from Alpine's own repo: Alpine's own mosquitto package
# (2.0.22) cannot read this project's actual dynamic-security.json at all — reproduced against a
# copy of the real file and confirmed as a genuine cross-build incompatibility (not a permissions
# or content issue) before reaching for this. The exact binary/libs already proven against that
# file avoid the incompatibility entirely.
COPY --from=mosquitto /usr/sbin/mosquitto /usr/sbin/mosquitto
COPY --from=mosquitto /usr/bin/mosquitto_ctrl /usr/bin/mosquitto_pub /usr/bin/mosquitto_sub /usr/bin/
COPY --from=mosquitto /usr/lib/libmosquitto.so.1 /usr/lib/mosquitto_dynamic_security.so /usr/lib/
COPY --from=mosquitto \
  /usr/lib/libcjson.so.1 \
  /usr/lib/libmicrohttpd.so.12 \
  /usr/lib/libssl.so.3 \
  /usr/lib/libcrypto.so.3 \
  /usr/lib/libgnutls.so.30 \
  /usr/lib/libz.so.1 \
  /usr/lib/libzstd.so.1 \
  /usr/lib/libbrotlienc.so.1 \
  /usr/lib/libbrotlidec.so.1 \
  /usr/lib/libbrotlicommon.so.1 \
  /usr/lib/libp11-kit.so.0 \
  /usr/lib/libidn2.so.0 \
  /usr/lib/libunistring.so.5 \
  /usr/lib/libtasn1.so.6 \
  /usr/lib/libhogweed.so.6 \
  /usr/lib/libnettle.so.8 \
  /usr/lib/libgmp.so.10 \
  /usr/lib/libffi.so.8 \
  /usr/lib/libedit.so.0 \
  /usr/lib/libncursesw.so.6 \
  /usr/lib/
# libedit/libncursesw above are mosquitto_ctrl's own deps (readline-style line editing), not
# mosquitto's — `ldd /usr/sbin/mosquitto` alone won't surface them. Found by actually running a
# fresh (no pre-existing dynamic-security.json) container end to end: mosquitto_ctrl is only
# invoked once, during first-boot bootstrap, so this was otherwise easy to miss with a reused
# config volume where that code path never runs again.
RUN chmod +x /usr/sbin/mosquitto /usr/bin/mosquitto_ctrl /usr/bin/mosquitto_pub /usr/bin/mosquitto_sub \
  && addgroup -S mosquitto && adduser -S -D -H -G mosquitto mosquitto

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Seed-only copy, kept separate from the bind-mounted runtime folder (/device-templates, see
# docker-compose.yml and docker-entrypoint.sh) — a bind mount replaces a directory's contents
# entirely rather than merging with what the image already has there, so the built-in HeatMeister
# examples would otherwise vanish the moment a host folder is mounted over /app/device-templates.
COPY device-templates ./device-templates-defaults
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 5582 1883
# Checks the gateway's own HTTP server only — Mosquitto's own listener isn't probed here, but a
# wedged Node process (which also carries mosquitto's supervision loop, see
# docker-entrypoint.sh) is the failure mode that actually matters for auto-recovery.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:5582/healthz || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
