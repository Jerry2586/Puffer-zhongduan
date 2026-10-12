#!/usr/bin/env bash
# 只测试交互配置和端口选择，不操作宿主机 Docker 或安装目录。
set -Eeuo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/linux-menu.sh
source scripts/linux-menu.sh
ss() {
  case "$*" in
    *':80'|*':443'|*':8792') printf 'LISTEN occupied\n' ;;
    *) return 0 ;;
  esac
}
candidate=$(free_port)
[[ "$candidate" -ge 20000 && "$candidate" -le 59999 ]]
settings_prompt <<<'
'
[[ "$DOMAIN" == '' && "$MODE" == direct && "$LOCAL_PORT" -ge 20000 && "$BIND_ADDRESS" == 0.0.0.0 && "$DIRECT_HTTP" == true && "$PUBLIC_ORIGIN" == '' ]]
unset DOMAIN ACME_EMAIL LOCAL_PORT
settings_prompt <<<'sq.appgog.com

'
[[ "$MODE" == reverse-proxy && "$LOCAL_PORT" -ge 20000 && "$BIND_ADDRESS" == 127.0.0.1 && "$PUBLIC_ORIGIN" == https://sq.appgog.com ]]
settings_prompt <<<'-
'
[[ "$DOMAIN" == '' && "$MODE" == direct ]]
if (settings_prompt <<<'bad/domain'); then echo '错误域名未拒绝' >&2; exit 1; fi
if (settings_prompt <<<'-
80'); then echo '错误端口未拒绝' >&2; exit 1; fi
printf '可选域名 / 自动空闲端口 / 共存模式推荐 / 清除域名验收通过\n'
