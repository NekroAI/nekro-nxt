#!/bin/sh
# Starts as root only to give /data to the runtime user, then runs NekroNXT as that user. A bind-mounted host
# directory arrives with the host's owner (often root), which the runtime user could not write to.
set -eu

uid="${NEKRO_UID:-10001}"
gid="${NEKRO_GID:-10001}"

if [ "$(id -u)" != 0 ]; then
  # Started with `user:`; the operator already chose the owner.
  exec "$@"
fi

case "$uid$gid" in
  *[!0-9]*) echo "[nekro-nxt] NEKRO_UID 与 NEKRO_GID 必须是数字。" >&2; exit 1 ;;
esac

if [ "$(stat -c '%u:%g' "$NEKRO_DATA")" != "$uid:$gid" ]; then
  # First start on this directory, or files left by an earlier root run: hand the whole tree over once.
  chown -R "$uid:$gid" "$NEKRO_DATA"
fi

# Same home as the nekro account had when the image ran as that user directly.
export HOME="$NEKRO_DATA"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all -- "$@"
