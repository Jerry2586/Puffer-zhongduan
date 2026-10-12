#!/usr/bin/env bash
# Isolated control-flow checks; no real listeners, certificates or host sites touched.
# Subshell results are intentionally persisted then explicitly reloaded from the fixture.
# shellcheck disable=SC2031
set -Eeuo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/linux-menu.sh
source scripts/linux-menu.sh
# shellcheck source=scripts/domain-auto.sh
source scripts/domain-auto.sh
if ! command -v flock >/dev/null; then flock() { return 0; }; fi
sandbox=$(mktemp -d)
trap 'rm -rf -- "$sandbox"' EXIT
CONFIG_DIR=$sandbox/config DATA_BASE=$sandbox/data
ENV_FILE=$CONFIG_DIR/terminal.env COMPOSE_FILE=$CONFIG_DIR/compose.yaml
mkdir -p "$CONFIG_DIR" "$DATA_BASE" "$sandbox/sites"
# Read-only diagnostics and absent-unit detection must not mutate host services.
(
  systemctl() { [[ "$*" == 'show puffer-terminal-certificate.timer --property=LoadState --value' ]] || return 9; printf '%s\n' "$fixture_state"; }
  fixture_state=not-found
  if certificate_unit_exists puffer-terminal-certificate.timer; then exit 1; fi
  fixture_state=loaded
  certificate_unit_exists puffer-terminal-certificate.timer
  fixture_state=''
  if certificate_unit_exists puffer-terminal-certificate.timer; then exit 1; fi
  ss() { [[ "$*" == '-H -ltnp ( sport = :80 or sport = :443 )' ]] || return 9; printf 'LISTEN docker-proxy:80\n'; }
  docker() { [[ "$1" == ps && "$2" == --format ]] || return 9; printf 'gateway nginx 0.0.0.0:443->443/tcp\n'; }
  command() { if [[ "$1" == -v && ( "$2" == ss || "$2" == docker ) ]]; then return 0; fi; builtin command "$@"; }
  ingress_diagnostics >"$sandbox/ingress.log"
  grep -q 'docker-proxy:80' "$sandbox/ingress.log"
  grep -q 'gateway nginx' "$sandbox/ingress.log"
  grep -q 'sudo hetun ingress' "$sandbox/ingress.log"
)
TARGET=$sandbox/sites/hetun.conf
printf 'other website\n' >"$sandbox/sites/unrelated.conf"
load_config() {
  # shellcheck source=/dev/null
  source "$ENV_FILE"
}
write_config() { printf 'DOMAIN=%s\nMODE=%s\nLOCAL_PORT=34567\nACME_EMAIL=\n' "$DOMAIN" "$MODE" >"$ENV_FILE"; }
reset_fixture() {
  rm -rf -- "$CONFIG_DIR/domain"
  rm -f -- "$TARGET" "$sandbox/FAIL_CERT" "$sandbox/FAIL_VERIFY"
  DOMAIN='' MODE=direct LOCAL_PORT=34567
  write_config
  printf 'old compose\n' >"$COMPOSE_FILE"
  : >"$sandbox/calls"
}
up() { printf 'UP:%s\n' "$MODE" >>"$sandbox/calls"; }
wait_health() { return 0; }
port_busy() { [[ "$PORTS_OCCUPIED" == true ]]; }
ss() { return 0; }
nginx_detect() { NGINX_BIN=/bin/true; printf 'mock nginx\n' >"$domain_tx/nginx.dump"; }
compose() {
  if [[ "$*" == *nginx-domain-plan.mjs* ]]; then cat >/dev/null; printf '%s\n' "$TARGET"; fi
}
nginx_apply() { printf 'NGINX_RELOAD\n' >>"$sandbox/calls"; }
nginx_write_site() { printf 'managed:%s:%s\n' "$DOMAIN" "$2" >"$1"; }
domain_prepare_webroot() { :; }
certbot_run() { printf 'CERT:%s\n' "$DOMAIN" >>"$sandbox/calls"; [[ ! -f "$sandbox/FAIL_CERT" ]]; }
domain_verify() { [[ ! -f "$sandbox/FAIL_VERIFY" ]]; }
domain_renew_install() { printf 'RENEW_ON\n' >>"$sandbox/calls"; }
domain_renew_remove() { printf 'RENEW_OFF\n' >>"$sandbox/calls"; }
install() { mkdir -p -- "${@: -1}"; }
install_menu() { printf 'MENU\n' >>"$sandbox/calls"; }
show_access() { printf 'ACCESS:%s\n' "$MODE"; }
# Real active metadata has strict production paths. Mock only this reader for the sandbox.
managed_domain_read() {
  MANAGED_CONF='' MANAGED_DOMAIN='' NGINX_BIN=''
  if [[ -f "$CONFIG_DIR/domain/active" ]]; then
    MANAGED_CONF=$(sed -n '1p' "$CONFIG_DIR/domain/active")
    MANAGED_DOMAIN=$(sed -n '2p' "$CONFIG_DIR/domain/active")
    NGINX_BIN=$(sed -n '3p' "$CONFIG_DIR/domain/active")
  fi
}
# Free ports: no token or certificate-email prompt, no Nginx files created.
reset_fixture
PORTS_OCCUPIED=false
bind_auto_domain sq.example.com </dev/null
load_config
[[ "$MODE" == standalone && "$DOMAIN" == sq.example.com && ! -f "$TARGET" ]]
# Occupied ports: automatic managed Nginx, renewal registered, unrelated files preserved.
reset_fixture
PORTS_OCCUPIED=true
bind_auto_domain sq.example.com </dev/null
load_config
[[ "$MODE" == reverse-proxy && -f "$CONFIG_DIR/domain/active" ]]
grep -q 'RENEW_ON' "$sandbox/calls"
[[ $(cat "$sandbox/sites/unrelated.conf") == 'other website' ]]
# Clear hostname restores IP mode and removes only the managed vhost.
clear_auto_domain
load_config
[[ "$MODE" == direct && "$DOMAIN" == '' && ! -e "$TARGET" ]]
# Dedicated old site is restored on certificate or HTTPS-identity failure.
for failure in FAIL_CERT FAIL_VERIFY; do
  reset_fixture
  printf 'old dedicated site\n' >"$TARGET"
  cp "$ENV_FILE" "$sandbox/env-before"
  touch "$sandbox/$failure"
  if bind_auto_domain sq.example.com </dev/null; then echo '失败绑定错误报告成功' >&2; exit 1; fi
  cmp "$ENV_FILE" "$sandbox/env-before"
  [[ $(cat "$TARGET") == 'old dedicated site' && ! -f "$CONFIG_DIR/domain/active" ]]
  [[ $(cat "$sandbox/sites/unrelated.conf") == 'other website' ]]
done
# Rebinding the same domain preserves the real pre-install original for later removal.
reset_fixture
printf 'old dedicated site\n' >"$TARGET"
bind_auto_domain sq.example.com </dev/null
bind_auto_domain sq.example.com </dev/null
clear_auto_domain
[[ $(cat "$TARGET") == 'old dedicated site' ]]
# User edits must survive an attempted rebind.
reset_fixture
bind_auto_domain sq.example.com </dev/null
printf 'user edit\n' >"$TARGET"
if bind_auto_domain sq.example.com </dev/null; then echo '手工修改被覆盖' >&2; exit 1; fi
[[ $(cat "$TARGET") == 'user edit' ]]
printf '自动域名独立/共存/续期/清除/证书失败/身份失败/重绑定/保护手工修改验收通过\n'
