#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${1:-} == --help ]]; then
  echo '河豚终端安装入口：sudo bash install.sh [deploy|install|menu|update]'
  exit 0
fi
[[ $(id -u) == 0 ]] || { echo '请使用 sudo 或 root 执行。' >&2; exit 1; }
command -v curl >/dev/null || { echo '需要 curl：Debian/Ubuntu 执行 apt-get install -y curl；RPM 系统执行 dnf install -y curl。' >&2; exit 1; }
command -v tar >/dev/null || { echo '请先安装 tar。' >&2; exit 1; }
WORK=$(mktemp -d /tmp/puffer-bootstrap.XXXXXX)
trap 'rm -rf -- "$WORK"' EXIT
REF=${HETUN_REF:-main}
[[ "$REF" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || { echo '版本引用无效。' >&2; exit 1; }
curl --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 300 "https://codeload.github.com/Jerry2586/Puffer-zhongduan/tar.gz/$REF" -o "$WORK/source.tar.gz"
tar -xzf "$WORK/source.tar.gz" --strip-components=1 -C "$WORK"
bash "$WORK/scripts/linux-menu.sh" "${1:-deploy}"
