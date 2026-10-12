#!/usr/bin/env bash
# Fixed-purpose host updater. Requests never contain executable commands.
set -Eeuo pipefail
umask 077
DIR=/var/lib/puffer-terminal/maintenance
[[ $(id -u) == 0 && -d "$DIR" && ! -L "$DIR" ]] || exit 1
exec 9>/run/lock/puffer-terminal-agent.lock
flock -n 9 || exit 0
atomic_json() {
  local name=$1 value=$2 temp
  temp=$(mktemp "$DIR/.agent.XXXXXX")
  printf '%s\n' "$value" >"$temp"
  chown root:1000 "$temp"
  chmod 640 "$temp"
  mv -Tf -- "$temp" "$DIR/$name"
}
heartbeat() { atomic_json agent.json "{\"at\":\"$(date -u +%FT%TZ)\"}"; }
heartbeat
# Holding the agent lock means a previous running task no longer has a worker.
if [[ -f "$DIR/status.json" ]] && grep -q '"state":"running"' "$DIR/status.json"; then
  atomic_json status.json "{\"state\":\"failed\",\"message\":\"更新服务曾中断，请查看日志并重新检查更新\",\"at\":\"$(date -u +%FT%TZ)\"}"
fi
[[ -f "$DIR/request" && ! -L "$DIR/request" ]] || exit 0
private=$(mktemp -d /run/puffer-update.XXXXXX)
trap 'rm -rf -- "$private"' EXIT
mv -T -- "$DIR/request" "$private/request"
[[ -f "$private/request" && ! -L "$private/request" && $(stat -c %s "$private/request") -le 200 ]] || exit 1
read -r job revision extra <"$private/request" || exit 1
[[ "$job" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ && "$revision" =~ ^[a-f0-9]{40}$ && -z "$extra" ]] || exit 1
status() { atomic_json status.json "{\"id\":\"$job\",\"revision\":\"$revision\",\"state\":\"$1\",\"message\":\"$2\",\"at\":\"$(date -u +%FT%TZ)\"}"; }
status running '正在核对 Git 版本、备份并更新，请稍候'
( while true; do heartbeat; sleep 10; done ) &
pulse=$!
trap 'kill "$pulse" 2>/dev/null || true; wait "$pulse" 2>/dev/null || true; rm -rf -- "$private"' EXIT
latest=$(curl -fsSL --max-time 30 --retry 2 https://api.github.com/repos/Jerry2586/Puffer-zhongduan/commits/main | sed -n 's/^  "sha": "\([a-f0-9]\{40\}\)",$/\1/p' | head -n 1) || latest=''
if [[ "$latest" != "$revision" ]]; then
  status failed '仓库版本已变化或连接失败，请重新检查更新'
  exit 1
fi
logtemp=$(mktemp "$DIR/.log.XXXXXX")
mv -Tf -- "$logtemp" "$DIR/update.log"
if HETUN_REF="$revision" /usr/local/bin/puffer-terminal update >"$DIR/update.log" 2>&1; then
  status complete '更新完成，终端已重新启动'
else
  status failed '更新未完成，请查看服务日志与更新日志；更新程序会尝试回退'
  exit 1
fi
