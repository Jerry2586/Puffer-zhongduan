#!/usr/bin/env bash
# 河豚终端：环境与状态和项目源码分离。只操作 puffer-terminal Compose 项目。
set -Eeuo pipefail
umask 077
APP_BASE=/opt/puffer-terminal
CONFIG_DIR=/etc/puffer-terminal
DATA_BASE=/var/lib/puffer-terminal
BACKUP_DIR=/var/backups/puffer-terminal
REPO=Jerry2586/Puffer-zhongduan
ENV_FILE=$CONFIG_DIR/terminal.env
COMPOSE_FILE=$CONFIG_DIR/compose.yaml
MENU_VERSION=0.2.3
say() { printf '\n%s\n' "$*"; }
die() { say "$*" >&2; exit 1; }
require_root() { [[ $(id -u) == 0 ]] || die '请使用 sudo 或 root 执行。'; }
load_config() {
  [[ -f "$ENV_FILE" ]] || die '还未安装，请先执行 puffer-terminal install。'
  # 仅加载本工具生成、root 拥有且没有组/其他用户写权限的文件。
  [[ $(stat -c %u "$ENV_FILE") == 0 ]] || die '配置文件所有者不是 root。'
  [[ $(stat -c %a "$ENV_FILE") == 600 ]] || die '配置文件权限必须为 600。'
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  BIND_ADDRESS=${BIND_ADDRESS:-127.0.0.1}
  DIRECT_HTTP=${DIRECT_HTTP:-false}
  PUBLIC_ORIGIN=${PUBLIC_ORIGIN-https://$DOMAIN}
  [[ "$SOURCE_DIR" =~ ^/opt/puffer-terminal/releases/[a-f0-9]{40}$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]] || die '源码路径超出工具目录。'
  [[ "$STATE_DIR" == "$DATA_BASE/state" && "$CADDY_DIR" == "$DATA_BASE/caddy" ]] || die '运行路径超出工具目录。'
}
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
up() {
  if [[ "$MODE" == standalone ]]; then compose --profile tls up -d --remove-orphans; elif [[ "$MODE" == tunnel ]]; then compose --profile tunnel up -d --remove-orphans; else compose up -d --remove-orphans; fi
}
wait_health() {
  local attempt
  for ((attempt=1; attempt<=30; attempt++)); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$LOCAL_PORT/healthz" >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
prerequisites() {
  [[ -r /etc/os-release ]] || die '无法识别 Linux 发行版。'
  # shellcheck source=/dev/null
  source /etc/os-release
  if command -v docker >/dev/null; then
    docker compose version >/dev/null || die '已有 Docker 缺少 Compose v2 插件。请补装，不会删除已有 Docker。'
    docker info >/dev/null || die 'Docker 服务未运行，请先启动 Docker。'
    if ! command -v curl >/dev/null || ! command -v tar >/dev/null || ! command -v ss >/dev/null; then
      die '请安装 curl、tar 和 iproute2/iproute。'
    fi
    return
  fi
  say "准备安装 Docker Engine 和 Compose，系统：$ID ${VERSION_ID:-}"
  case "$ID" in
    ubuntu|debian)
      command -v systemctl >/dev/null || die '自动安装需要 systemd。'
      apt-get update
      apt-get install -y ca-certificates curl tar iproute2
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
      [[ "$CODENAME" =~ ^[a-z]+$ ]] || die '无法识别发行版代号，请手动安装 Docker。'
      printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$ID" "$CODENAME" "$(dpkg --print-architecture)" >/etc/apt/sources.list.d/puffer-docker.sources
      apt-get update
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    centos|rocky|almalinux|rhel)
      if ! command -v dnf >/dev/null || ! command -v systemctl >/dev/null; then
        die '自动安装需要 dnf 和 systemd。'
      fi
      [[ ${VERSION_ID%%.*} -ge 9 ]] || die 'RPM 自动安装支持 9/10 系列；旧系统请自行安装 Docker。'
      dnf install -y ca-certificates curl tar iproute dnf-plugins-core
      curl -fsSL https://download.docker.com/linux/centos/docker-ce.repo -o /etc/yum.repos.d/puffer-docker.repo
      dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *) die '此发行版不自动更改系统软件源。请先安装 Docker Engine + Compose v2，再运行本菜单。' ;;
  esac
  systemctl enable --now docker
  docker info >/dev/null
  docker compose version
}
resolve_source() {
  local ref=${1:-main} sha archive stage
  [[ "$ref" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || die 'Git 引用格式无效。'
  if [[ "$ref" =~ ^[a-f0-9]{40}$ ]]; then sha=$ref; else
    sha=$(curl -fsSL --retry 2 "https://api.github.com/repos/$REPO/commits/$ref" | sed -n 's/^  "sha": "\([a-f0-9]\{40\}\)",$/\1/p' | head -n 1)
  fi
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || die '读取仓库版本失败，检查 GitHub 网络或限流。'
  RESOLVED_SHA=$sha
  RESOLVED_SOURCE=$APP_BASE/releases/$sha
  [[ -f "$RESOLVED_SOURCE/deploy/compose.yaml" ]] && return
  install -d -m 0755 "$APP_BASE/releases"
  stage=$(mktemp -d "$APP_BASE/releases/.download.XXXXXX")
  archive=$stage/source.tar.gz
  if ! curl -fsSL --retry 2 --connect-timeout 20 --max-time 300 "https://codeload.github.com/$REPO/tar.gz/$sha" -o "$archive"; then rm -rf -- "$stage"; die '下载源码失败，现有安装未改动。'; fi
  if ! tar -xzf "$archive" --strip-components=1 -C "$stage"; then rm -rf -- "$stage"; die '解压源码失败。'; fi
  rm -f -- "$archive"
  [[ -f "$stage/deploy/compose.yaml" && -f "$stage/server/index.mjs" ]] || die '仓库归档缺少河豚终端文件。'
  chmod -R u=rwX,go=rX "$stage"
  mv -- "$stage" "$RESOLVED_SOURCE"
}
write_config() {
  local temp
  install -d -m 0700 "$CONFIG_DIR" || return 1
  temp=$(mktemp "$CONFIG_DIR/.env.XXXXXX") || return 1
  prepare_maintenance || return 1
  deployment_settings
  printf 'DOMAIN=%s\nACME_EMAIL=%s\nMODE=%s\nLOCAL_PORT=%s\nSOURCE_DIR=%s\nSTATE_DIR=%s\nCADDY_DIR=%s\nTERMINAL_IMAGE=%s\nREVISION=%s\nBIND_ADDRESS=%s\nDIRECT_HTTP=%s\nPUBLIC_ORIGIN=%s\n' "$DOMAIN" "$ACME_EMAIL" "$MODE" "$LOCAL_PORT" "$SOURCE_DIR" "$STATE_DIR" "$CADDY_DIR" "$TERMINAL_IMAGE" "$REVISION" "$BIND_ADDRESS" "$DIRECT_HTTP" "$PUBLIC_ORIGIN" >"$temp" || return 1
  # 所有输入经校验且没有需要 shell 转义的字符，兼容 Compose --env-file。
  chmod 600 "$temp" || return 1
  mv -- "$temp" "$ENV_FILE" || return 1
  cp -- "$SOURCE_DIR/deploy/compose.yaml" "$COMPOSE_FILE" || return 1
  chmod 600 "$COMPOSE_FILE"
}
deployment_settings() {
  BIND_ADDRESS=127.0.0.1 DIRECT_HTTP=false PUBLIC_ORIGIN=https://$DOMAIN
  if [[ "$MODE" == direct ]]; then
    BIND_ADDRESS=0.0.0.0 DIRECT_HTTP=true PUBLIC_ORIGIN=
    [[ -z "$DOMAIN" ]] || PUBLIC_ORIGIN=http://$DOMAIN:$LOCAL_PORT
  fi
}
port_busy() { [[ -n $(ss -H -ltn "sport = :$1") ]]; }
free_port() {
  local candidate attempt
  for ((attempt=0; attempt<200; attempt++)); do
    candidate=$((20000 + RANDOM % 40000))
    if ! port_busy "$candidate"; then printf '%s' "$candidate"; return; fi
  done
  die '未找到空闲端口，请释放一个 20000–59999 TCP 端口后重试。'
}
settings_prompt() {
  local d e m p suggested
  read -r -p "绑定域名（可留空，输入 - 清除）[${DOMAIN:-}]：" d
  d=${d:-${DOMAIN:-}}
  [[ "$d" != - ]] || d=
  d=${d,,}
  if [[ -n "$d" ]]; then
    [[ ${#d} -le 253 && "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$ ]] || die '域名无效，不要包含协议、端口或路径。'
    say '1 自动 HTTPS（空闲 80/443）  2 已有网站反向代理'
    suggested=1
    if port_busy 80 || port_busy 443 || [[ -n $(ss -H -lun 'sport = :443') ]]; then
      suggested=2
      say '检测到已有网站占用 80/443，推荐共存模式 2。'
    fi
    read -r -p "选择模式 [$suggested]：" m
    case ${m:-$suggested} in 1) MODE=standalone ;; 2) MODE=reverse-proxy ;; *) die '请选择 1 或 2；不占用 80/443 的自动绑定请用 sudo hetun domain。';; esac
  else
    MODE=direct
    say '无域名模式：使用 http://服务器IP:端口 直接访问，不占用 80/443。'
  fi
  e=${ACME_EMAIL:-}
  if [[ "$MODE" == standalone ]]; then
    read -r -p "证书通知邮箱[$e]：" e
    e=${e:-${ACME_EMAIL:-}}
    [[ "$e" =~ ^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || die '邮箱格式无效。'
  fi
  suggested=${LOCAL_PORT:-$(free_port)}
  read -r -p "服务端口[$suggested]：" p
  p=${p:-$suggested}
  [[ "$p" =~ ^[0-9]{4,5}$ && "$p" -ge 1024 && "$p" -le 65535 ]] || die '端口必须为 1024–65535。'
  DOMAIN=$d ACME_EMAIL=$e LOCAL_PORT=$p
  deployment_settings
}
port_check() {
  local ports port
  ports=("$LOCAL_PORT")
  [[ "$MODE" == standalone ]] && ports+=(80 443)
  for port in "${ports[@]}"; do
    if [[ -n $(ss -H -ltn "sport = :$port") ]]; then die "端口 $port 已被占用。请使用共存模式或更换本机端口；不会关闭其他服务。"; fi
  done
  if [[ "$MODE" == standalone && -n $(ss -H -lun 'sport = :443') ]]; then die 'UDP 443 已被占用，请使用共存模式。'; fi
}
start_app() {
  load_config
  write_config
  compose build terminal
  up
  wait_health || die '服务启动失败，请查看 logs。'
  install_menu
  domain_helpers
  managed_domain_resume
  show_access
}
prepare_maintenance() {
  [[ ! -L /var/lib/puffer-terminal/maintenance ]] || return 1
  install -d -o root -g 1000 -m 1770 /var/lib/puffer-terminal/maintenance
}
install_maintenance() {
  prepare_maintenance
  install -m 0755 "$SOURCE_DIR/scripts/maintenance.sh" /usr/local/lib/puffer-terminal-maintenance
  install -m 0644 "$SOURCE_DIR/deploy/puffer-terminal-update.service" /etc/systemd/system/puffer-terminal-update.service
  install -m 0644 "$SOURCE_DIR/deploy/puffer-terminal-update.timer" /etc/systemd/system/puffer-terminal-update.timer
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
    systemctl daemon-reload
    systemctl enable --now puffer-terminal-update.timer
  else
    say '系统未运行 systemd；请通过 sudo hetun update 更新。'
  fi
}
remove_maintenance() {
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
    systemctl disable --now puffer-terminal-update.timer || true
    systemctl stop puffer-terminal-update.service || true
  fi
  rm -f -- /etc/systemd/system/puffer-terminal-update.service /etc/systemd/system/puffer-terminal-update.timer /usr/local/lib/puffer-terminal-maintenance
  if [[ -d /run/systemd/system ]]; then systemctl daemon-reload; fi
  rm -f -- /var/lib/puffer-terminal/maintenance/agent.json /var/lib/puffer-terminal/maintenance/request
}
install_menu() {
  local menu_file
  menu_file=$(mktemp /usr/local/bin/.puffer-terminal.XXXXXX)
  install -m 0755 "$SOURCE_DIR/scripts/linux-menu.sh" "$menu_file"
  mv -f "$menu_file" /usr/local/bin/puffer-terminal
  ln -sfn /usr/local/bin/puffer-terminal /usr/local/bin/hetun
  install_maintenance
}
show_access() {
  if [[ "$MODE" == direct ]]; then
    local address
    address=$(hostname -I 2>/dev/null | awk '{print $1}')
    address=${address:-服务器IP}
    say "临时访问：http://$address:$LOCAL_PORT"
    [[ -z "$DOMAIN" ]] || say "域名 $DOMAIN 尚未完成无端口 HTTPS 绑定，请执行 sudo hetun domain。"
    say "外网请使用服务器公网 IP，安全组放行 TCP $LOCAL_PORT。可稍后通过 hetun domain 绑定域名和 HTTPS。"
  else
    say "后台地址：https://$DOMAIN"
  fi
  if [[ "$MODE" == reverse-proxy ]]; then
    say "已有网站反向代理目标：http://127.0.0.1:$LOCAL_PORT（保留 Host，上传上限至少 128m）。"
  elif [[ "$MODE" == tunnel ]]; then
    say 'Cloudflare Tunnel 模式：无需占用本机 80/443，公网 HTTPS 验证结果见部署页面。'
  elif [[ "$MODE" == standalone ]]; then
    say '自动证书状态请查看证书日志。'
  fi
  say '管理菜单：sudo hetun；更新：sudo hetun update；初始账号：sudo hetun credentials'
}
check_update() {
  load_config
  local latest
  latest=$(curl -fsSL --max-time 15 "https://api.github.com/repos/$REPO/commits/main" | sed -n 's/^  "sha": "\([a-f0-9]\{40\}\)",$/\1/p' | head -n 1)
  [[ "$latest" =~ ^[a-f0-9]{40}$ ]] || die '暂时无法检查更新。'
  if [[ "$latest" == "$REVISION" ]]; then say '已是最新仓库版本。'; else say "发现更新：${REVISION:0:12} → ${latest:0:12}；执行 sudo hetun update。"; fi
}
install_app() {
  [[ ! -f "$ENV_FILE" ]] || die '已经安装，请使用 update 或 domain。'
  prerequisites
  local requested_domain password
  DOMAIN='' ACME_EMAIL=''
  read_domain
  requested_domain=$NEW_DOMAIN
  read -r -s -p '管理员密码（回车自动生成）：' password
  printf '\n'
  MODE=direct LOCAL_PORT=$(free_port)
  port_check
  resolve_source "${HETUN_REF:-main}"
  SOURCE_DIR=$RESOLVED_SOURCE REVISION=$RESOLVED_SHA
  STATE_DIR=$DATA_BASE/state CADDY_DIR=$DATA_BASE/caddy TERMINAL_IMAGE=puffer-terminal:$REVISION
  install -d -m 0700 "$STATE_DIR"
  chown 1000:1000 "$STATE_DIR"
  install -d -m 0700 "$CADDY_DIR/data" "$CADDY_DIR/config"
  write_config
  compose config -q
  install_menu
  compose build --pull terminal
  up
  wait_health || { compose logs --tail=60 terminal; die '终端未健康启动，配置和数据已保留。可执行 sudo puffer-terminal start 重试。'; }
  install_menu
  if [[ -n "$password" ]]; then
    compose stop terminal </dev/null
    if ! printf '%s' "$password" | compose run -T --rm --no-deps terminal node scripts/reset-admin.mjs --stdin; then
      unset password
      up </dev/null
      die '安装完成，密码设置失败。请执行 sudo hetun reset-password 重试。'
    fi
    unset password
    up </dev/null
    wait_health || die '密码已设置，但服务尚未健康，请查看日志。'
  else show_credentials; fi
  if [[ -n "$requested_domain" ]]; then domain_helpers; bind_auto_domain "$requested_domain"; else show_access; fi
}
backup_app() {
  load_config
  install -d -m 0700 "$BACKUP_DIR"
  local archive resume=0
  archive=$BACKUP_DIR/puffer-$(date -u +%Y%m%dT%H%M%S)-$$.tar.gz
  # 停止本项目服务使 JSON、密钥、文件和证书处于一致快照。
  if [[ -n $(compose ps -q --status running) ]]; then resume=1; compose --profile tls --profile tunnel stop; fi
  if ! tar --dereference --hard-dereference -czf "$archive" -C / etc/puffer-terminal var/lib/puffer-terminal; then
    [[ $resume == 1 ]] && up
    die '备份失败，未执行升级。'
  fi
  chmod 600 "$archive"
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$archive")") >"$archive.sha256"
  [[ $resume == 1 ]] && up
  LAST_BACKUP=$archive
  say "备份已保存：$archive（包括签名私钥，请妥善保管）"
}
update_app() {
  local update_lock
  exec {update_lock}>/run/lock/puffer-terminal-update.lock
  flock -n "$update_lock" || die '已有更新正在执行。'
  load_config
  local old_source=$SOURCE_DIR old_revision=$REVISION old_image=$TERMINAL_IMAGE old_config
  resolve_source "${HETUN_REF:-main}"
  [[ "$RESOLVED_SHA" != "$REVISION" ]] || { write_config; up; wait_health; install_menu; say '仓库版本没有变化，更新服务已修复。'; return; }
  backup_app
  old_config=$(mktemp -d "$CONFIG_DIR/.rollback.XXXXXX")
  cp "$ENV_FILE" "$COMPOSE_FILE" "$old_config/"
  SOURCE_DIR=$RESOLVED_SOURCE REVISION=$RESOLVED_SHA TERMINAL_IMAGE=puffer-terminal:$RESOLVED_SHA
  if write_config && compose config -q && compose build --pull terminal && up && wait_health; then
    install_menu
    rm -rf -- "$old_config"
    say "更新成功：$old_revision → $REVISION"
  else
    say '更新失败，恢复上一版本配置和容器。'
    cp "$old_config/terminal.env" "$ENV_FILE"
    cp "$old_config/compose.yaml" "$COMPOSE_FILE"
    SOURCE_DIR=$old_source REVISION=$old_revision TERMINAL_IMAGE=$old_image
    up
    wait_health || die "上一版本也未启动，请通过备份恢复：$LAST_BACKUP"
    rm -rf -- "$old_config"
    die '更新失败，已回退上一版本；备份已保留。'
  fi
}
restore_app() {
  load_config
  local archive staging line first answer prior_mode expected_hash _ignored
  read -r -p '输入本工具备份的绝对路径：' archive
  [[ "$archive" == /* && -f "$archive" && -f "$archive.sha256" ]] || die '备份或 SHA256 文件不存在。'
  read -r expected_hash _ignored <"$archive.sha256"
  [[ "$expected_hash" =~ ^[a-f0-9]{64}$ && "$(sha256sum "$archive" | cut -d ' ' -f1)" == "$expected_hash" ]] || die '备份完整性校验失败。'
  # 排除目录穿越和符号链接；只接受本工具的配置及运行数据。
  while IFS= read -r line; do
    [[ "$line" != /* && "$line" != *../* && ( "$line" == etc/puffer-terminal/* || "$line" == var/lib/puffer-terminal/* ) ]] || die '备份路径不符合本工具格式。'
  done < <(tar -tzf "$archive")
  first=$(tar -tvzf "$archive" | cut -c1 | sort -u | tr -d '\n')
  [[ "$first" =~ ^[-d]+$ ]] || die '备份含链接或特殊文件，拒绝恢复。'
  read -r -p '输入 RESTORE 确认覆盖当前授权、文件和密钥：' answer
  [[ "$answer" == RESTORE ]] || { say '已取消。'; return; }
  staging=$(mktemp -d /tmp/puffer-restore.XXXXXX)
  tar -xzf "$archive" -C "$staging" --no-same-owner
  [[ -f "$staging/etc/puffer-terminal/terminal.env" && -f "$staging/var/lib/puffer-terminal/state/data.json" && -f "$staging/var/lib/puffer-terminal/state/keys/private.pem" ]] || die '备份缺少关键数据。'
  backup_app
  prior_mode=$MODE
  compose --profile tls --profile tunnel down
  mv "$CONFIG_DIR" "$CONFIG_DIR.pre-restore.$(date +%s)"
  mv "$DATA_BASE" "$DATA_BASE.pre-restore.$(date +%s)"
  mv "$staging/etc/puffer-terminal" "$CONFIG_DIR"
  mv "$staging/var/lib/puffer-terminal" "$DATA_BASE"
  chmod 700 "$CONFIG_DIR" "$STATE_DIR"
  chmod 600 "$ENV_FILE" "$COMPOSE_FILE"
  chown -R 1000:1000 "$DATA_BASE/state"
  load_config
  resolve_source "$REVISION"
  SOURCE_DIR=$RESOLVED_SOURCE
  write_config
  compose build terminal
  up
  wait_health || die "备份已恢复但服务未启动。之前模式：$prior_mode，旧配置和数据保存在 *.pre-restore.*。"
  install_menu
  rm -rf -- "$staging"
  say '恢复成功，之前的配置与数据目录仍保留，可人工复核后删除。'
}
validate_domain() {
  [[ -z "$1" || ( ${#1} -le 253 && "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$ ) ]] || die '请输入域名，不要包含协议、端口或路径。'
}
read_domain() {
  read -r -p "域名（留空用 IP，输入 - 清除）[${DOMAIN:-}]：" NEW_DOMAIN
  NEW_DOMAIN=${NEW_DOMAIN:-${DOMAIN:-}}
  [[ "$NEW_DOMAIN" != - ]] || NEW_DOMAIN=
  NEW_DOMAIN=${NEW_DOMAIN,,}
  validate_domain "$NEW_DOMAIN"
}
restore_domain_config() {
  local previous=$CONFIG_DIR/.domain-rollback
  if [[ -d "$previous" ]]; then
    cp "$previous/terminal.env" "$ENV_FILE"
    cp "$previous/compose.yaml" "$COMPOSE_FILE"
    if [[ -f "$previous/tunnel-token" ]]; then cp "$previous/tunnel-token" "$STATE_DIR/deployment/tunnel-token"; chown 1000:1000 "$STATE_DIR/deployment/tunnel-token"; else rm -f -- "$STATE_DIR/deployment/tunnel-token"; fi
    load_config
    up </dev/null
    wait_health || die '原配置已恢复，但服务尚未健康，请查看日志。'
    rm -rf -- "$previous"
  fi
}
tunnel_rollback() {
  load_config
  local token
  read -r -s -p 'Cloudflare API 令牌：' token
  printf '\n'
  printf '%s' "$token" | compose run -T --rm --no-deps terminal node scripts/bind-cloudflare.mjs rollback
  unset token
  restore_domain_config
}
bind_tunnel() {
  local domain=$1 token previous=$CONFIG_DIR/.domain-rollback
  say '自动绑定 Cloudflare 域名：需要 Tunnel 编辑、Zone 读取、DNS 编辑权限。将替换此域名的 A/AAAA/CNAME 记录，失败会回滚。'
  read -r -s -p 'Cloudflare API 令牌（不保存）：' token
  printf '\n'
  [[ -n "$token" ]] || die '未输入令牌，当前部署保持可用。'
  [[ ! -d "$previous" ]] || die '有未完成的域名操作，请先执行 sudo hetun tunnel-rollback。'
  install -d -m 0700 "$previous"
  cp "$ENV_FILE" "$COMPOSE_FILE" "$previous/"
  [[ ! -f "$STATE_DIR/deployment/tunnel-token" ]] || cp "$STATE_DIR/deployment/tunnel-token" "$previous/"
  if ! printf '%s' "$token" | compose run -T --rm --no-deps terminal node scripts/bind-cloudflare.mjs prepare "$domain"; then
    unset token
    if [[ -f "$STATE_DIR/deployment/pending.json" ]]; then die '域名准备未完成，请执行 sudo hetun tunnel-rollback。'; fi
    restore_domain_config
    die '域名准备失败，原配置已恢复。'
  fi
  DOMAIN=$domain MODE=tunnel ACME_EMAIL=
  if write_config && up </dev/null && wait_health && compose exec -T terminal node scripts/bind-cloudflare.mjs verify "$domain"; then
    unset token
    rm -rf -- "$previous"
    install_menu
    show_access
    return
  fi
  say '公网 HTTPS 核验失败，正在回滚 DNS 和本地部署。'
  compose --profile tunnel stop tunnel </dev/null || true
  if ! printf '%s' "$token" | compose run -T --rm --no-deps terminal node scripts/bind-cloudflare.mjs rollback; then
    unset token
    restore_domain_config
    die '本地已回退；Cloudflare 回滚待重试：sudo hetun tunnel-rollback。'
  fi
  unset token
  restore_domain_config
  die '域名核验失败，已恢复原部署。'
}
domain_helpers() {
  # shellcheck source=scripts/domain-auto.sh
  source "$SOURCE_DIR/scripts/domain-auto.sh"
}
change_domain() {
  load_config
  read_domain
  domain_helpers
  backup_app
  if [[ -n "$NEW_DOMAIN" ]]; then bind_auto_domain "$NEW_DOMAIN"; else clear_auto_domain; fi
}
cloudflare_tunnel() {
  load_config
  read_domain
  [[ -n "$NEW_DOMAIN" ]] || die 'Tunnel 需要域名。'
  backup_app
  bind_tunnel "$NEW_DOMAIN"
}

advanced_domain() {
  load_config
  local old_config new_domain new_email new_mode new_port
  settings_prompt
  # load_config above reloads values persisted by the isolated domain transaction.
  # shellcheck disable=SC2031
  new_domain=$DOMAIN new_email=$ACME_EMAIL new_mode=$MODE new_port=$LOCAL_PORT
  backup_app
  old_config=$(mktemp -d "$CONFIG_DIR/.domain.XXXXXX")
  cp "$ENV_FILE" "$COMPOSE_FILE" "$old_config/"
  compose --profile tls --profile tunnel down
  DOMAIN=$new_domain ACME_EMAIL=$new_email MODE=$new_mode LOCAL_PORT=$new_port
  if (port_check); then
    write_config
    if up && wait_health; then install_menu; rm -rf -- "$old_config"; show_access; return; fi
  fi
  cp "$old_config/terminal.env" "$ENV_FILE"
  cp "$old_config/compose.yaml" "$COMPOSE_FILE"
  load_config
  up
  rm -rf -- "$old_config"
  die '域名切换失败，已恢复原配置。'
}
show_credentials() {
  load_config
  printf '\n管理员账号：admin\n'
  if [[ -s "$STATE_DIR/bootstrap-admin.txt" ]]; then
    cat "$STATE_DIR/bootstrap-admin.txt"
  else
    printf '初始密码已在首次改密后删除，无法读取当前密码。\n忘记密码请选择菜单 3 → 2，或执行 sudo hetun reset-password。\n'
  fi
}
reset_password() {
  load_config
  local answer password confirm
  printf '\n修改管理员密码\n输入你要设置的新密码；直接回车则生成随机密码。\n'
  read -r -s -p '新密码：' password || return 1
  printf '\n'
  if [[ -n "$password" ]]; then
    read -r -s -p '再次输入：' confirm || return 1
    printf '\n'
    [[ "$password" == "$confirm" ]] || die '两次密码不一致，未做修改。'
  fi
  read -r -p '确认修改并清除所有登录会话？输入 y 确认，其他取消：' answer || return 1
  [[ "$answer" == y || "$answer" == Y ]] || { say '已取消，密码未修改。'; return; }
  say '正在修改密码并重启服务，请稍候……'
  compose --profile tls --profile tunnel stop terminal </dev/null
  if printf '%s' "$password" | compose run -T --rm --no-deps terminal node scripts/reset-admin.mjs --stdin; then
    unset password confirm
    up </dev/null
    wait_health || die '密码已修改，但服务尚未恢复，请执行 sudo hetun logs 检查。'
    say '密码修改成功，旧登录会话已失效。'
    if [[ -s "$STATE_DIR/bootstrap-admin.txt" ]]; then show_credentials; else say '账号：admin；请使用刚刚输入的新密码登录。'; fi
  else
    unset password confirm
    up </dev/null
    die '密码修改失败，已尝试恢复服务，请查看上述错误。'
  fi
}
uninstall_app() {
  load_config
  local answer choice
  printf '\n  卸载河豚终端\n  1 卸载服务，保留数据与备份\n  2 完全卸载，删除终端数据与源码（保留备份）\n  0 返回\n'
  read -r -p '请选择：' choice
  case "$choice" in 1|2) ;; *) return;; esac
  read -r -p '输入 UNINSTALL 确认：' answer
  [[ "$answer" == UNINSTALL ]] || return
  if [[ "$choice" == 2 ]]; then
    read -r -p '再次输入 DELETE 确认删除终端数据（备份保留）：' answer
    [[ "$answer" == DELETE ]] || return
  fi
  local update_lock
  exec {update_lock}>/run/lock/puffer-terminal-update.lock
  flock -n "$update_lock" || die '正在更新，请完成后卸载。'
  backup_app
  domain_helpers
  managed_domain_suspend
  remove_maintenance
  compose --profile tls --profile tunnel down
  if [[ "$choice" == 2 ]]; then
    [[ "$APP_BASE" == /opt/puffer-terminal && "$CONFIG_DIR" == /etc/puffer-terminal && "$DATA_BASE" == /var/lib/puffer-terminal ]] || die '卸载路径校验失败。'
    rm -rf -- /opt/puffer-terminal /etc/puffer-terminal /var/lib/puffer-terminal
    rm -f -- /usr/local/bin/hetun /usr/local/bin/puffer-terminal
    say "已完全卸载河豚终端；备份保留：$BACKUP_DIR；Docker 与其他站点保留。"
  else
    say "服务已卸载，数据保留：$DATA_BASE；执行 sudo hetun start 恢复。"
  fi
}
menu_header() {
  local blue='' reset='' latest_backup health
  if [[ -t 1 && "${TERM:-dumb}" != dumb ]]; then blue=$'\033[1;34m'; reset=$'\033[0m'; fi
  printf '\n%s  ╔════════════════════════════════════════════════════╗\n  ║           河豚终端 · 管理中心                      ║\n  ╚════════════════════════════════════════════════════╝%s\n' "$blue" "$reset"
  printf '  菜单版本：%s    安装目录：%s\n' "$MENU_VERSION" "$APP_BASE"
  if [[ -f "$ENV_FILE" ]]; then
    load_config
    health=$(curl -fsS --max-time 2 "http://127.0.0.1:$LOCAL_PORT/healthz" 2>/dev/null) || health=''
    if [[ -n "$health" ]]; then printf '  运行状态：正常（本机健康检查通过）\n'; else printf '  运行状态：未启动或检查失败\n'; fi
    printf '  部署模式：%s    安装版本：%.12s\n' "$MODE" "$REVISION"
    if [[ "$MODE" == direct ]]; then
      printf '  访问地址：http://服务器公网IP:%s（临时直连）\n' "$LOCAL_PORT"
      [[ -z "$DOMAIN" ]] || printf '  域名状态：%s 尚未完成 HTTPS 绑定\n' "$DOMAIN"
    else
      printf '  终端地址：https://%s\n  域名状态：选择 12 检查公网 HTTPS 与终端身份\n' "$DOMAIN"
    fi
    printf '  更新状态：选择 9 联网检查，选择 10 备份后更新\n'
    latest_backup=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tar.gz' -printf '%f\n' 2>/dev/null | sort | tail -n 1) || latest_backup=''
    printf '  最近备份：%s\n' "${latest_backup:-尚无备份}"
  else printf '  运行状态：尚未安装，请选择 1\n'; fi
}
diagnose_domain() {
  load_config
  show_access
  domain_helpers
  ingress_diagnostics
  if [[ -z "$DOMAIN" || "$MODE" == direct ]]; then
    say '尚未绑定无端口 HTTPS 域名。执行 sudo hetun domain，输入域名完成自动绑定。'
    return 1
  fi
  compose exec -T terminal node scripts/diagnose-domain.mjs "$DOMAIN"
}

run_menu_action() {
  trap ':' INT
  if bash "${BASH_SOURCE[0]}" "$1"; then printf '\n操作结束。\n'; else printf '\n操作未完成，请查看上方提示。\n'; fi
  trap - INT
  read -r -p '按回车返回：' || return
}
account_menu() {
  local choice
  while true; do
    printf '\n  账号管理\n  1 查看初始账号  2 修改密码  0 返回\n'
    read -r -p '请选择：' choice || return
    case "$choice" in 1) run_menu_action credentials;; 2) run_menu_action reset-password;; 0) return;; *) say '请选择 1、2 或 0。';; esac
  done
}
advanced_menu() {
  local choice action
  while true; do
    printf '\n  备份与高级工具\n  1 创建备份    2 恢复备份\n  3 高级域名    4 证书日志\n  5 Tunnel 日志 6 域名回滚\n  7 Cloudflare Tunnel（需令牌）\n  0 返回\n'
    read -r -p '请选择：' choice || return
    case "$choice" in
      1) action=backup;; 2) action=restore;; 3) action=advanced-domain;; 4) action=certificates;;
      5) action=tunnel-logs;; 6) action=tunnel-rollback;; 7) action=cloudflare-tunnel;; 0) return;; *) say '编号无效。'; continue;;
    esac
    run_menu_action "$action"
  done
}
menu() {
  local choice action
  while true; do
    menu_header
    printf '\n   1. 安装与环境准备\n   2. 查看系统状态\n   3. 启动服务\n   4. 停止服务\n   5. 重启服务\n   6. 查看服务日志\n   7. 绑定 / 修改域名（自动 HTTPS）\n   8. 查看初始账号 / 修改密码\n   9. 检查 Git 更新\n  10. 在线更新（自动备份）\n  11. 备份 / 恢复与高级工具\n  12. 域名 HTTPS 诊断\n  13. 卸载管理\n   0. 退出\n\n'
    read -r -p '请选择：' choice || return
    case "$choice" in
      1) action=deploy;; 2) action=status;; 3) action=start;; 4) action=stop;; 5) action=restart;; 6) action=logs;;
      7) action=domain;; 8) account_menu; continue;; 9) action=check;; 10) action=update;;
      11) advanced_menu; continue;; 12) action=doctor;; 13) action=uninstall;; 0) return;;
      *) say '请选择 0–13。'; continue;;
    esac
    run_menu_action "$action"
  done
}

main() {
  require_root
  case ${1:-menu} in
    deploy) if [[ -f "$ENV_FILE" ]]; then update_app; else install_app; fi ;;
    install) install_app ;; menu) menu ;; status) load_config; compose --profile tls --profile tunnel ps; show_access ;;
    ingress) load_config; domain_helpers; ingress_diagnostics ;;
    doctor) diagnose_domain ;; check) check_update ;; restart) load_config; compose restart terminal; wait_health ;;
    update) update_app ;; backup) backup_app ;; restore) restore_app ;; domain) change_domain ;;
    renew-certificate) load_config; domain_helpers; renew_certificate ;;
    cloudflare-tunnel) cloudflare_tunnel ;; advanced-domain) advanced_domain ;; tunnel-rollback) tunnel_rollback ;;
    tunnel-logs) load_config; compose --profile tunnel logs --tail=100 tunnel ;;
    credentials) show_credentials ;; reset-password) reset_password ;;
    start) start_app ;; stop) load_config; compose --profile tls --profile tunnel stop ;;
    certificates) load_config; compose --profile tls logs --tail=100 proxy ;;
    logs) load_config; compose logs --tail=100 -f terminal ;;
    uninstall) uninstall_app ;; --help) echo 'puffer-terminal [menu|deploy|install|status|ingress|doctor|check|update|restart|backup|restore|domain|credentials|reset-password|start|stop|logs|uninstall|advanced-domain|cloudflare-tunnel|renew-certificate|tunnel-rollback|tunnel-logs]' ;;
    *) die '未知命令，使用 --help 查看。' ;;
  esac
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
