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
compose --profile tunnel config -q
docker run --rm cloudflare/cloudflared:2026.9.1 tunnel run --help | grep -- '--token-file' >/dev/null
compose build --pull terminal
up
wait_health
[[ $(compose exec -T terminal id -u) == 1000 ]]
compose exec -T terminal node --check scripts/nginx-domain-plan.mjs
compose exec -T terminal node --check scripts/diagnose-domain.mjs
compose exec -T terminal node --check scripts/bind-cloudflare.mjs
[[ -s "$STATE_DIR/bootstrap-admin.txt" && -s "$STATE_DIR/keys/private.pem" ]]
curl -fsS "http://127.0.0.1:$LOCAL_PORT/" | grep -q '河豚终端'
key_before=$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)
docker run --rm -e DOMAIN="$DOMAIN" -e ACME_EMAIL="$ACME_EMAIL" -v "$SOURCE_DIR/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
mkdir -p "$DATA_BASE/acme/letsencrypt/archive/hetun-test" "$DATA_BASE/acme/letsencrypt/live/hetun-test"
printf certificate-proof >"$DATA_BASE/acme/letsencrypt/archive/hetun-test/fullchain1.pem"
ln -s ../../archive/hetun-test/fullchain1.pem "$DATA_BASE/acme/letsencrypt/live/hetun-test/fullchain.pem"
backup_app
[[ -s "$LAST_BACKUP.sha256" ]]
compose stop terminal
start_app
[[ "$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)" == "$key_before" ]]
# 错误域名必须在停止服务之前被拒绝。
if printf 'bad/domain\n' | bash "$SOURCE_DIR/scripts/linux-menu.sh" advanced-domain; then echo '错误域名未被拒绝' >&2; exit 1; fi
wait_health
archive_to_restore=$LAST_BACKUP
# 从另一个文件名恢复，核验备份可以迁移位置。
cp "$archive_to_restore" "$BACKUP_DIR/portable.tar.gz"
cp "$archive_to_restore.sha256" "$BACKUP_DIR/portable.tar.gz.sha256"
printf '%s\nRESTORE\n' "$BACKUP_DIR/portable.tar.gz" | bash "$SOURCE_DIR/scripts/linux-menu.sh" restore
wait_health
[[ "$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)" == "$key_before" ]]
[[ $(cat "$DATA_BASE/acme/letsencrypt/live/hetun-test/fullchain.pem") == certificate-proof ]]
[[ ! -L "$DATA_BASE/acme/letsencrypt/live/hetun-test/fullchain.pem" ]]
# 从共存模式切换到无域名模式，确认公网端口映射、真实 HTTP 和数据保留。
printf '%s\n' '-' '8793' | bash "$SOURCE_DIR/scripts/linux-menu.sh" advanced-domain
load_config
[[ "$MODE" == direct && "$DOMAIN" == '' && "$BIND_ADDRESS" == 0.0.0.0 && "$PUBLIC_ORIGIN" == '' ]]
wait_health
compose --profile tls config -q
[[ $(compose port terminal 8792) == 0.0.0.0:8793 ]]
curl -fsS -H 'Host: 192.0.2.10:8793' "http://127.0.0.1:$LOCAL_PORT/" | grep -q '河豚终端'
[[ "$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)" == "$key_before" ]]
[[ -L /usr/local/bin/hetun ]]
# 验证密码管理确实在容器中生效，且没有消费后续菜单输入。
printf '\ny\n' | bash "$SOURCE_DIR/scripts/linux-menu.sh" reset-password
wait_health
[[ -s "$STATE_DIR/bootstrap-admin.txt" ]]
bash "$SOURCE_DIR/scripts/linux-menu.sh" credentials >/dev/null
printf '8\n2\n1\n1\ny\n\n0\n0\n' | bash "$SOURCE_DIR/scripts/linux-menu.sh" menu >"$BACKUP_DIR/menu-reset-test.txt" 2>&1
grep -q '密码修改成功' "$BACKUP_DIR/menu-reset-test.txt"
wait_health
[[ ! -e "$STATE_DIR/bootstrap-admin.txt" ]]
bash "$SOURCE_DIR/scripts/linux-menu.sh" credentials | grep -q '无法读取当前密码'
curl -fsS -H "Origin: http://127.0.0.1:$LOCAL_PORT" -H 'Content-Type: application/json' -d '{"username":"admin","password":"1"}' "http://127.0.0.1:$LOCAL_PORT/api/login" | grep -q '"mustChange":false'
printf '8\n1\n\n2\nMismatch-password-1\nMismatch-password-2\n\n0\n0\n' | bash "$SOURCE_DIR/scripts/linux-menu.sh" menu >"$BACKUP_DIR/menu-test.txt" 2>&1
grep -q '无法读取当前密码' "$BACKUP_DIR/menu-test.txt"
grep -q '两次密码不一致' "$BACKUP_DIR/menu-test.txt"
grep -q '操作未完成' "$BACKUP_DIR/menu-test.txt"
[[ "$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)" == "$key_before" ]]
# 已取消的域名加端口模式必须拒绝，且不能停止或改写当前有效服务。
if printf '%s\n' 'sq.example.test' '3' "$LOCAL_PORT" | bash "$SOURCE_DIR/scripts/linux-menu.sh" advanced-domain; then
  echo '已取消的域名端口模式未被拒绝' >&2; exit 1
fi
load_config
[[ "$MODE" == direct && "$DOMAIN" == '' && "$PUBLIC_ORIGIN" == '' ]]
wait_health
curl -fsS -H "Origin: http://127.0.0.1:$LOCAL_PORT" -H 'Content-Type: application/json' -d '{"username":"admin","password":"1"}' "http://127.0.0.1:$LOCAL_PORT/api/login" | grep -q '"mustChange":false'
[[ $(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"username":"admin","password":"1"}' "http://127.0.0.1:$LOCAL_PORT/api/login") == 403 ]]
[[ "$(sha256sum "$STATE_DIR/keys/private.pem" | cut -d ' ' -f1)" == "$key_before" ]]
echo 'Linux Docker / 无域名 IP访问 / 共存切换 / 非 root / 重启 / 备份恢复 / Caddy 配置验收通过'
