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

# First start on this directory, or files left by an earlier root run (such as backups an old image wrote as root
# inside an already handed-over directory): hand them over. Stops at the first such file, so a clean tree costs one walk.
stray="$(find "$NEKRO_DATA" \( ! -uid "$uid" -o ! -gid "$gid" \) -print -quit)"
if [ -n "$stray" ]; then
  echo "[nekro-nxt] 数据目录里有不属于运行用户的文件（例如 $stray），正在改为 $uid:$gid。" >&2
  chown -R "$uid:$gid" "$NEKRO_DATA"
fi

# Same home as the nekro account had when the image ran as that user directly.
export HOME="$NEKRO_DATA"
# Android kernels let only root and members of the inet group (3003) open network sockets; other kernels give that
# group no meaning. Fall back to no supplementary groups where it cannot be set, such as a narrow rootless gid map.
groups=3003
if ! setpriv --reuid="$uid" --regid="$gid" --groups="$groups" --inh-caps=-all -- true 2>/dev/null; then
  echo "[nekro-nxt] 无法为运行用户加入网络权限组 3003。在 Android 上如果因此无法监听端口，可设置 NEKRO_UID=0 和 NEKRO_GID=0。" >&2
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all -- "$@"
fi
exec setpriv --reuid="$uid" --regid="$gid" --groups="$groups" --inh-caps=-all -- "$@"
