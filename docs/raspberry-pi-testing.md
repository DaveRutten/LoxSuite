# Raspberry Pi / DietPi verification checklist

What's been checked against real Pi hardware, versus what's expected to work because the image is
now multi-arch (`linux/amd64` + `linux/arm64`, see [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml))
but hasn't been separately verified on a device yet. If you run through this on real hardware,
please open an issue or PR updating this file with the result (pass/fail, board model, OS image) —
that's how the "expected to work" rows below get promoted to "verified".

## Status

| # | Check | Status |
|---|-------|--------|
| 1 | arm64 image builds successfully in CI (`docker/build-push-action` with `platforms: linux/amd64,linux/arm64`) | Expected to work — QEMU cross-build, not yet confirmed against a real run's logs |
| 2 | `docker compose pull` on a real 64-bit Pi resolves the arm64 manifest automatically | Expected to work (standard Docker multi-arch manifest behavior) — not yet run on real hardware |
| 3 | Container boots: Mosquitto starts, dynamic-security bootstrap creates the admin/`client`/gateway MQTT accounts | Not yet verified on real hardware |
| 4 | Gateway connects to Mosquitto, web UI reachable at `:5582`, first admin web account created | Not yet verified on real hardware |
| 5 | `better-sqlite3`'s native binding actually loads at runtime (not just compiles) — this is the dependency most likely to break on arm64 | Not yet verified on real hardware |
| 6 | A Shelly (or similar) device connects over MQTT and shows up under Live Data/Hardware | Not yet verified on real hardware |
| 7 | A Virtual Output UDP/HTTP callback from a real Loxone Miniserver reaches the gateway and publishes to MQTT | Not yet verified on real hardware |
| 8 | Dashboard chart rendering performance with a realistic amount of Monitor history (hundreds of thousands of rows) | Not yet verified on real hardware — expect this to be the most noticeable slowdown vs. an x86 host |
| 9 | Scheduled backup (SQLite online backup) completes within a reasonable time on SD-card/USB storage | Not yet verified on real hardware |
| 10 | Container survives a Pi power-loss/hard-reset (no corrupted `gateway.db`, WAL recovers cleanly) | Not yet verified on real hardware |
| 11 | `HEALTHCHECK` (`wget` against `/healthz`) reports healthy in `docker ps` | Expected to work (same Alpine `wget`, arch-independent) — not yet run on real hardware |
| 12 | Memory footprint stays within a Pi's real constraints (1GB Pi 3B+/Zero 2 W vs. 4-8GB Pi 4/5) under normal load | Not yet verified on real hardware |

## How to run this checklist

Hardware used for the most recent pass (fill in when you run this):

- Board: _______________
- OS image: _______________ (`uname -m` output: _______________)
- Docker version: _______________
- LoxSuite version/commit: _______________

Steps:

1. Follow "Running on a Raspberry Pi / DietPi" in the main [README](../README.md) to get the stack
   up.
2. Work through each numbered check above in order — most later ones assume the container is
   already up and connected to MQTT/a Miniserver from the earlier steps.
3. For #8 (chart performance), the Monitor page's own history table page size and the Dashboard
   chart panels' own range selector are the two places a slowdown would first be visible — try a
   30-day range on a monitor that's been polling at a short interval for a while.
4. For #10, `docker kill -s SIGKILL loxsuite` (not a graceful `docker stop`) is a closer simulation
   of a real power loss than a normal restart.
5. Update the table above with the actual result and this run's hardware/OS details, and note
   anything unexpected in a short paragraph below the table (new row if it's a genuinely new
   finding, not covered by an existing check).

## Known constraints going in (not bugs to "fix" during testing)

- No `armv7` (32-bit) image — see the README's "Known scope limitations". Don't test 32-bit OS
  images against this multi-arch image; they aren't expected to pull an image at all (no matching
  manifest).
- A Raspberry Pi is expected to be measurably slower than a typical x86 Docker host for anything
  CPU-bound (see check #8) — the point of this checklist is "does it work and stay stable", not
  "is it as fast as a NUC".
