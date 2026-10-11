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
MENU_VERSION=0.1.0
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
  [[ "$SOURCE_DIR" =~ ^/opt/puffer-terminal/releases/[a-f0-9]{40}$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]] || die '源码路径超出工具目录。'
  [[ "$STATE_DIR" == "$DATA_BASE/state" && "$CADDY_DIR" == "$DATA_BASE/caddy" ]] || die '运行路径超出工具目录。'
}
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
up() {
  if [[ "$MODE" == standalone ]]; then compose --profile tls up -d --remove-orphans; else compose up -d --remove-orphans; fi
}
wait_health() {
  local i
  for i in {1..30}; do
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
    command -v curl >/dev/null && command -v tar >/dev/null && command -v ss >/dev/null || die '请安装 curl、tar 和 iproute2/iproute。'
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
      command -v dnf >/dev/null && command -v systemctl >/dev/null || die '自动安装需要 dnf 和 systemd。'
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
  install -d -m 0700 "$CONFIG_DIR"
  temp=$(mktemp "$CONFIG_DIR/.env.XXXXXX")
  printf 'DOMAIN=%s\nACME_EMAIL=%s\nMODE=%s\nLOCAL_PORT=%s\nSOURCE_DIR=%s\nSTATE_DIR=%s\nCADDY_DIR=%s\nTERMINAL_IMAGE=%s\nREVISION=%s\n' "$DOMAIN" "$ACME_EMAIL" "$MODE" "$LOCAL_PORT" "$SOURCE_DIR" "$STATE_DIR" "$CADDY_DIR" "$TERMINAL_IMAGE" "$REVISION" >"$temp"
  # 所有输入经校验且没有需要 shell 转义的字符，兼容 Compose --env-file。
  chmod 600 "$temp"
  mv -- "$temp" "$ENV_FILE"
  cp -- "$SOURCE_DIR/deploy/compose.yaml" "$COMPOSE_FILE"
  chmod 600 "$COMPOSE_FILE"
}
settings_prompt() {
  local d e m p
  read -r -p "绑定域名（例如 terminal.example.com）[${DOMAIN:-}]：" d
  d=${d:-${DOMAIN:-}}
  d=${d,,}
  [[ ${#d} -le 253 && "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$ ]] || die '域名无效，不要包含协议、端口或路径。'
  read -r -p "证书通知邮箱[${ACME_EMAIL:-}]：" e
  e=${e:-${ACME_EMAIL:-}}
  [[ "$e" =~ ^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || die '邮箱格式无效。'
  say '1 独立模式：本工具占用 80/443，自动申请并续期证书。'
  say '2 共存模式：宝塔/Nginx/已有代理负责域名和证书，只使用本机端口。'
  read -r -p '选择模式 [1]：' m
  case ${m:-1} in 1) MODE=standalone ;; 2) MODE=reverse-proxy ;; *) die '请选择 1 或 2。';; esac
  read -r -p "本机服务端口[${LOCAL_PORT:-8792}]：" p
  p=${p:-${LOCAL_PORT:-8792}}
  [[ "$p" =~ ^[0-9]{4,5}$ && "$p" -ge 1024 && "$p" -le 65535 ]] || die '端口必须为 1024–65535。'
  DOMAIN=$d ACME_EMAIL=$e LOCAL_PORT=$p
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
  compose build terminal
  up
  wait_health || die '服务启动失败，请查看 logs。'
  show_access
}
install_menu() {
  install -m 0755 "$SOURCE_DIR/scripts/linux-menu.sh" /usr/local/bin/puffer-terminal
}
show_access() {
  say "后台地址：https://$DOMAIN"
  say "本机健康检查：http://127.0.0.1:$LOCAL_PORT/healthz"
  if [[ "$MODE" == reverse-proxy ]]; then
    say "请在已有 HTTPS 站点设置反向代理：http://127.0.0.1:$LOCAL_PORT（保留 Host 请求头，上传上限至少 128m）。"
  else
    say '自动 HTTPS 需要域名 A/AAAA 指向本机，公网 80/443 可访问。证书结果请查看菜单中的证书日志。'
  fi
  say '初始密码：sudo puffer-terminal credentials；登录后必须修改。'
}
install_app() {
  [[ ! -f "$ENV_FILE" ]] || die '已经安装，请使用 update 或 domain。'
  prerequisites
  settings_prompt
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
  show_access
}
backup_app() {
  load_config
  install -d -m 0700 "$BACKUP_DIR"
  local archive resume=0
  archive=$BACKUP_DIR/puffer-$(date -u +%Y%m%dT%H%M%S)-$$.tar.gz
  # 停止本项目服务使 JSON、密钥、文件和证书处于一致快照。
  if [[ -n $(compose ps -q --status running) ]]; then resume=1; compose --profile tls stop; fi
  if ! tar -czf "$archive" -C / etc/puffer-terminal var/lib/puffer-terminal; then
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
  load_config
  local old_source=$SOURCE_DIR old_revision=$REVISION old_image=$TERMINAL_IMAGE old_config
  resolve_source "${HETUN_REF:-main}"
  [[ "$RESOLVED_SHA" != "$REVISION" ]] || { say '仓库版本没有变化。'; return; }
  backup_app
  old_config=$(mktemp -d "$CONFIG_DIR/.rollback.XXXXXX")
  cp "$ENV_FILE" "$COMPOSE_FILE" "$old_config/"
  SOURCE_DIR=$RESOLVED_SOURCE REVISION=$RESOLVED_SHA TERMINAL_IMAGE=puffer-terminal:$RESOLVED_SHA
  write_config
  if compose config -q && compose build --pull terminal && up && wait_health; then
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
  compose --profile tls down
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
change_domain() {
  load_config
  local old_config new_domain new_email new_mode new_port
  settings_prompt
  new_domain=$DOMAIN new_email=$ACME_EMAIL new_mode=$MODE new_port=$LOCAL_PORT
  backup_app
  old_config=$(mktemp -d "$CONFIG_DIR/.domain.XXXXXX")
  cp "$ENV_FILE" "$COMPOSE_FILE" "$old_config/"
  compose --profile tls down
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
reset_password() {
  load_config
  local answer
  read -r -p '输入 RESET 确认重置管理员密码并清除登录会话：' answer
  [[ "$answer" == RESET ]] || return
  compose --profile tls stop terminal
  if compose run --rm --no-deps terminal node scripts/reset-admin.mjs; then up; say '已重置。执行 puffer-terminal credentials 查看初始密码。'; else up; die '重置失败。'; fi
}
uninstall_app() {
  load_config
  local answer
  read -r -p '输入 UNINSTALL 确认卸载河豚终端容器（保留数据与源码，不删除 Docker）：' answer
  [[ "$answer" == UNINSTALL ]] || return
  backup_app
  compose --profile tls down
  say "容器已卸载，数据保留：$DATA_BASE；源码：$APP_BASE；再次运行 puffer-terminal start 恢复。"
}
menu() {
  while true; do
    printf '\n河豚终端 Linux 管理菜单 v%s\n' "$MENU_VERSION"
    printf ' 1 安装与环境准备     2 状态与地址\n 3 服务日志           4 更新终端\n 5 备份               6 恢复备份\n 7 修改域名/部署模式   8 查看初始账号\n 9 重置管理员密码    10 启动\n11 停止              12 证书日志\n13 卸载（保留数据）    0 退出\n'
    read -r -p '请选择：' choice || return
    case "$choice" in
      1) install_app ;; 2) load_config; compose --profile tls ps; show_access ;;
      3) load_config; compose logs --tail=100 -f terminal ;; 4) update_app ;;
      5) backup_app ;; 6) restore_app ;; 7) change_domain ;; 8) load_config; cat "$STATE_DIR/bootstrap-admin.txt" 2>/dev/null || say '初始密码已删除，请使用已设置的密码。' ;;
      9) reset_password ;; 10) start_app ;; 11) load_config; compose --profile tls stop ;;
      12) load_config; compose --profile tls logs --tail=100 proxy ;; 13) uninstall_app ;; 0) return ;; *) say '选项无效。' ;;
    esac
  done
}
main() {
  require_root
  case ${1:-menu} in
    install) install_app ;; menu) menu ;; status) load_config; compose --profile tls ps; show_access ;;
    update) update_app ;; backup) backup_app ;; restore) restore_app ;; domain) change_domain ;;
    credentials) load_config; cat "$STATE_DIR/bootstrap-admin.txt" ;; reset-password) reset_password ;;
    start) start_app ;; stop) load_config; compose --profile tls stop ;;
    logs) load_config; compose logs --tail=100 -f terminal ;;
    uninstall) uninstall_app ;; --help) echo 'puffer-terminal [menu|install|status|update|backup|restore|domain|credentials|reset-password|start|stop|logs|uninstall]' ;;
    *) die '未知命令，使用 --help 查看。' ;;
  esac
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
