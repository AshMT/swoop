#!/bin/sh
# Swoop container entrypoint.
#
# Starts as root just long enough to make /app/data writable by the user the
# app will run as, then drops privileges. This is the PUID/PGID convention
# Unraid and most self-hosting guides expect (Unraid's defaults are 99/100).
#
# Why this exists: an earlier image ran as root, so a data folder created by it
# is root-owned. Once the image switched to a non-root user, SQLite could no
# longer write there and startup failed with "attempt to write a readonly
# database". Fixing ownership here on every start means an upgrade can never
# strand an existing install that way again.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${SWOOP_DATA_DIR:-/app/data}"

# Already unprivileged (e.g. `docker run --user`), so there is nothing we are
# allowed to fix. Run as-is and let the app report a clear error if needed.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

case "$PUID" in ''|*[!0-9]*) echo "[entrypoint] PUID must be a number, got '$PUID'" >&2; exit 1 ;; esac
case "$PGID" in ''|*[!0-9]*) echo "[entrypoint] PGID must be a number, got '$PGID'" >&2; exit 1 ;; esac

if [ "$PUID" = "0" ]; then
  echo "[entrypoint] Refusing to run as root (PUID=0). Set PUID to an unprivileged user, e.g. 99 on Unraid." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

# Only touch files whose ownership is wrong. A blanket `chown -R` would rewrite
# every file on every start, which is slow on a large database and needlessly
# churns backups that track modification metadata.
fixed=$(find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -print 2>/dev/null | wc -l)
if [ "$fixed" -gt 0 ]; then
  echo "[entrypoint] Fixing ownership of $fixed path(s) in $DATA_DIR to $PUID:$PGID"
  find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +
fi

# Owner read/write, group read/write, no access for others: the database holds
# encrypted credentials and ticket contents.
chmod u+rwX,g+rwX,o-rwx "$DATA_DIR" 2>/dev/null || true

exec su-exec "$PUID:$PGID" "$@"
