#!/usr/bin/env bash
# 仅在 GitHub Actions 临时 Linux runner 执行；拒绝覆盖已有安装。
set -Eeuo pipefail
[[ $(id -u) == 0 ]] || exit 1
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo '仅允许在 GitHub Actions 临时 runner 验收。' >&2; exit 1; }
[[ ! -e /opt/puffer-terminal && ! -e /etc/puffer-terminal && ! -e /var/lib/puffer-terminal ]] || { echo '检测到已有安装，拒绝验收。' >&2; exit 1; }
REPOSITORY_ROOT=$(pwd)
# shellcheck source=scripts/linux-menu.sh
source "$REPOSITORY_ROOT/scripts/linux-menu.sh"
cleanup() {
  if [[ -f "$ENV_FILE" ]]; then compose --profile tls down --remove-orphans || true; fi
}
trap cleanup EXIT
REVISION=$GITHUB_SHA
SOURCE_DIR=$APP_BASE/releases/$REVISION
DOMAIN=terminal.example.test ACME_EMAIL=ci@example.test MODE=reverse-proxy LOCAL_PORT=8792
STATE_DIR=$DATA_BASE/state CADDY_DIR=$DATA_BASE/caddy TERMINAL_IMAGE=puffer-terminal:$REVISION
install -d -m 0755 "$SOURCE_DIR"
git archive HEAD | tar -x -C "$SOURCE_DIR"
install -d -m 0700 "$STATE_DIR" "$CADDY_DIR/data" "$CADDY_DIR/config"
chown 1000:1000 "$STATE_DIR"
write_config
compose config -q
compose --profile tls config -q
compose build --pull terminal
up
wait_health
[[ $(compose exec -T terminal id -u) == 1000 ]]
[[ -s "$STATE_DIR/bootstrap-admin.txt" && -s "$STATE_DIR/keys/private.pem" ]]
curl -fsS "http://127.0.0.1:$LOCAL_PORT/" | grep -q '河豚终端'
key_before=$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)
docker run --rm -e DOMAIN="$DOMAIN" -e ACME_EMAIL="$ACME_EMAIL" -v "$SOURCE_DIR/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
backup_app
[[ -s "$LAST_BACKUP.sha256" ]]
compose stop terminal
start_app
[[ "$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)" == "$key_before" ]]
# 错误域名必须在停止服务之前被拒绝。
if printf 'bad/domain\n' | bash "$SOURCE_DIR/scripts/linux-menu.sh" domain; then echo '错误域名未被拒绝' >&2; exit 1; fi
wait_health
archive_to_restore=$LAST_BACKUP
# 从另一个文件名恢复，核验备份可以迁移位置。
cp "$archive_to_restore" "$BACKUP_DIR/portable.tar.gz"
cp "$archive_to_restore.sha256" "$BACKUP_DIR/portable.tar.gz.sha256"
printf '%s\nRESTORE\n' "$BACKUP_DIR/portable.tar.gz" | bash "$SOURCE_DIR/scripts/linux-menu.sh" restore
wait_health
[[ "$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)" == "$key_before" ]]
echo 'Linux Docker / 非 root / 重启 / 备份恢复 / Caddy 配置验收通过'
