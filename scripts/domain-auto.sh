#!/usr/bin/env bash
# Loaded by linux-menu.sh after load_config. Only this domain's vhost is managed.
# Nginx variables stay literal; ACME_EMAIL is consumed by the caller's write_config.
# shellcheck disable=SC2016,SC2034
nginx_detect() {
  local candidate
  for candidate in "$(command -v nginx || true)" /www/server/nginx/sbin/nginx /usr/sbin/nginx /usr/local/nginx/sbin/nginx; do
    if [[ -n "$candidate" && -x "$candidate" ]] && "$candidate" -T >"$domain_tx/nginx.dump" 2>"$domain_tx/nginx.log"; then
      NGINX_BIN=$candidate
      return 0
    fi
  done
  say '80/443 已被占用，但未找到可管理的本机 Nginx/宝塔。现有服务保持可用。' >&2
  return 1
}
domain_snapshot_file() {
  local target=$1 index=${#domain_paths[@]}
  [[ "$target" == /* && ! -L "$target" ]] || { say '站点配置是符号链接，已停止自动处理，避免覆盖链接目标。' >&2; return 1; }
  domain_paths+=("$target")
  if [[ -f "$target" ]]; then cp -p -- "$target" "$domain_tx/file-$index"; else : >"$domain_tx/absent-$index"; fi
}
nginx_apply() {
  "$NGINX_BIN" -t && "$NGINX_BIN" -s reload
}
nginx_write_site() {
  local target=$1 tls=${2:-false} certname=hetun-$DOMAIN
  {
    printf '# Managed by hetun; original saved under /etc/puffer-terminal/domain.\nserver {\n    listen 80;\n    server_name %s;\n' "$DOMAIN"
    printf '    location ^~ /.well-known/acme-challenge/ { root /var/www/puffer-terminal-acme; default_type text/plain; }\n'
    if [[ "$tls" == true ]]; then
      printf '    location / { return 301 https://%s$request_uri; }\n}\nserver {\n    listen 443 ssl;\n    server_name %s;\n' "$DOMAIN" "$DOMAIN"
      printf '    ssl_certificate %s/acme/letsencrypt/live/%s/fullchain.pem;\n    ssl_certificate_key %s/acme/letsencrypt/live/%s/privkey.pem;\n' "$DATA_BASE" "$certname" "$DATA_BASE" "$certname"
      printf '    ssl_protocols TLSv1.2 TLSv1.3;\n    client_max_body_size 128m;\n    location / {\n        proxy_pass http://127.0.0.1:%s;\n' "$LOCAL_PORT"
      printf '        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_read_timeout 300s;\n    }\n'
    else printf '    location / { return 503; }\n'; fi
    printf '}\n'
  } >"$target" || return 1
  chmod 644 "$target"
}
domain_prepare_webroot() {
  install -d -m 0755 /var/www/puffer-terminal-acme/.well-known/acme-challenge
}
certbot_run() {
  install -d -m 0700 "$DATA_BASE/acme/letsencrypt" "$DATA_BASE/acme/work" "$DATA_BASE/acme/log"
  docker run --rm \
    -v "$DATA_BASE/acme/letsencrypt:/etc/letsencrypt:Z" \
    -v "$DATA_BASE/acme/work:/var/lib/letsencrypt:Z" \
    -v "$DATA_BASE/acme/log:/var/log/letsencrypt:Z" \
    -v /var/www/puffer-terminal-acme:/var/www/acme:ro,z \
    certbot/certbot:latest "$@" </dev/null
}
domain_verify() {
  local attempt
  # Never accept a bare 200: HTTPS must present this installation's signing key.
  for ((attempt=1; attempt<=12; attempt++)); do
    if compose exec -T terminal node scripts/diagnose-domain.mjs "$DOMAIN" >"$domain_tx/verify.log" 2>&1; then
      cat "$domain_tx/verify.log"
      return 0
    fi
    sleep 5
  done
  cat "$domain_tx/verify.log" >&2
  say '公网 HTTPS 未通过验证，正在恢复原配置。请确认 CF 解析、源站 80/443 和安全组可达。' >&2
  return 1
}
domain_renew_install() {
  cat >/etc/systemd/system/puffer-terminal-certificate.service <<'UNIT'
[Unit]
Description=Puffer terminal managed Nginx certificate renewal
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/hetun renew-certificate
UNIT
  cat >/etc/systemd/system/puffer-terminal-certificate.timer <<'UNIT'
[Unit]
Description=Puffer terminal certificate renewal timer
[Timer]
OnCalendar=*-*-* 03,15:15:00
RandomizedDelaySec=1800
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
    systemctl daemon-reload
    systemctl enable --now puffer-terminal-certificate.timer
  else
    printf '15 3,15 * * * root /usr/local/bin/hetun renew-certificate >>/var/log/puffer-terminal-certificate.log 2>&1\n' >/etc/cron.d/puffer-terminal-certificate
    chmod 644 /etc/cron.d/puffer-terminal-certificate
  fi
}
domain_renew_remove() {
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
    systemctl disable --now puffer-terminal-certificate.timer || true
    systemctl stop puffer-terminal-certificate.service || true
  fi
  rm -f -- /etc/systemd/system/puffer-terminal-certificate.service /etc/systemd/system/puffer-terminal-certificate.timer /etc/cron.d/puffer-terminal-certificate
  if [[ -d /run/systemd/system ]]; then systemctl daemon-reload; fi
}
managed_domain_read() {
  MANAGED_CONF='' MANAGED_DOMAIN='' NGINX_BIN=''
  if [[ -f "$CONFIG_DIR/domain/active" ]]; then
    IFS= read -r MANAGED_CONF <"$CONFIG_DIR/domain/active"
    MANAGED_DOMAIN=$(sed -n '2p' "$CONFIG_DIR/domain/active")
    NGINX_BIN=$(sed -n '3p' "$CONFIG_DIR/domain/active")
    [[ "$MANAGED_CONF" =~ ^/(etc/nginx/(conf.d|sites-enabled)|www/server/panel/vhost/nginx|usr/local/nginx/conf/vhost)/[a-zA-Z0-9_.-]+\.conf$ && "$NGINX_BIN" =~ ^/[a-zA-Z0-9_./-]+$ ]] || return 1
  fi
}
managed_domain_restore_site() {
  local path=$1
  # Refuse to overwrite a site someone edited after binding.
  [[ ! -f "$path" ]] || cmp -s "$path" "$CONFIG_DIR/domain/installed.conf" || { say '受管理站点被手动修改，已停止操作以保留修改。' >&2; return 1; }
  if [[ -f "$CONFIG_DIR/domain/original.conf" ]]; then cp -p "$CONFIG_DIR/domain/original.conf" "$path"; else rm -f -- "$path"; fi
}
managed_domain_remove() {
  managed_domain_read || return 1
  [[ -n "$MANAGED_CONF" ]] || return 0
  managed_domain_restore_site "$MANAGED_CONF" || return 1
  nginx_apply || return 1
  rm -f -- "$CONFIG_DIR/domain/active" "$CONFIG_DIR/domain/original.conf" "$CONFIG_DIR/domain/installed.conf"
  domain_renew_remove
}
renew_certificate() (
  load_config
  local renewal_lock
  exec {renewal_lock}>"$CONFIG_DIR/domain-operation.lock"
  flock -n "$renewal_lock" || return 0
  managed_domain_read || return 1
  [[ -n "$MANAGED_CONF" ]] || return 0
  [[ -x "$NGINX_BIN" ]] || return 1
  certbot_run renew --non-interactive --quiet --cert-name "hetun-$MANAGED_DOMAIN" || return 1
  nginx_apply
)
domain_auto_rollback() {
  local index
  trap - EXIT INT TERM
  say '绑定未完成，恢复原网站与终端配置。' >&2
  for ((index=0;index<${#domain_paths[@]};index++)); do
    if [[ -f "$domain_tx/absent-$index" ]]; then rm -f -- "${domain_paths[index]}"; else cp -p "$domain_tx/file-$index" "${domain_paths[index]}"; fi
  done
  if [[ -n "${NGINX_BIN:-}" ]]; then nginx_apply || say 'Nginx 恢复检查失败，请查看 sudo hetun doctor。' >&2; fi
  compose --profile tls --profile tunnel stop proxy tunnel </dev/null >/dev/null 2>&1 || true
  cp "$domain_tx/terminal.env" "$ENV_FILE"
  cp "$domain_tx/compose.yaml" "$COMPOSE_FILE"
  rm -rf -- "$CONFIG_DIR/domain"
  [[ ! -d "$domain_tx/domain" ]] || cp -a "$domain_tx/domain" "$CONFIG_DIR/domain"
  load_config
  if [[ -f "$CONFIG_DIR/domain/active" ]]; then domain_renew_install || true; else domain_renew_remove; fi
  if ! { up </dev/null && wait_health; }; then say '原服务恢复失败，请查看 sudo hetun logs。' >&2; fi
  rm -rf -- "$domain_tx"
}
bind_auto_domain() (
  load_config
  requested=$1
  domain_lock='' domain_tx='' target='' old_conf='' old_bin='' route=''
  domain_paths=()
  validate_domain "$requested" || return 1
  [[ -n "$requested" ]] || return 1
  exec {domain_lock}>"$CONFIG_DIR/domain-operation.lock"
  flock -n "$domain_lock" || { say '已有域名操作或证书续期正在执行，请稍后重试。'; return 1; }
  domain_tx=$(mktemp -d "$CONFIG_DIR/.auto-domain.XXXXXX") || return 1
  cp "$ENV_FILE" "$COMPOSE_FILE" "$domain_tx/" || { rm -rf -- "$domain_tx"; return 1; }
  if [[ -d "$CONFIG_DIR/domain" ]]; then cp -a "$CONFIG_DIR/domain" "$domain_tx/domain" || { rm -rf -- "$domain_tx"; return 1; }; fi
  managed_domain_read || { rm -rf -- "$domain_tx"; return 1; }
  old_conf=$MANAGED_CONF old_bin=$NGINX_BIN
  trap 'domain_auto_rollback' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ "$MODE" == standalone ]] || { ! port_busy 80 && ! port_busy 443 && [[ -z $(ss -H -lun 'sport = :443') ]]; }; then
    route=standalone
  else
    nginx_detect || return 1
    # A running terminal container supplies Node; no host Node installation needed.
    target=$(compose exec -T terminal node scripts/nginx-domain-plan.mjs "$requested" <"$domain_tx/nginx.dump") || return 1
    domain_snapshot_file "$target" || return 1
    if [[ "$target" == "$old_conf" ]]; then
      [[ ! -f "$target" ]] || cmp -s "$target" "$CONFIG_DIR/domain/installed.conf" || { say '受管理站点已被手动修改，停止自动覆盖。'; return 1; }
    fi
    route=reverse-proxy
  fi
  say "正在绑定 $requested，自动接入与申请 HTTPS 证书……"
  DOMAIN=$requested MODE=$route ACME_EMAIL=''
  # Keep the existing application port. No need to alter other sites' listeners.
  write_config && up </dev/null && wait_health || return 1
  if [[ "$route" == reverse-proxy ]]; then
    domain_prepare_webroot || return 1
    nginx_write_site "$target" false || return 1
    nginx_apply || return 1
    certbot_run certonly --non-interactive --agree-tos --register-unsafely-without-email \
      --webroot -w /var/www/acme --cert-name "hetun-$DOMAIN" -d "$DOMAIN" || return 1
    nginx_write_site "$target" true || return 1
    nginx_apply || return 1
  fi
  domain_verify || return 1
  # A previous managed hostname is restored only after the new one is verified.
  if [[ -n "$old_conf" && "$old_conf" != "$target" ]]; then
    domain_snapshot_file "$old_conf" || return 1
    NGINX_BIN=$old_bin
    managed_domain_restore_site "$old_conf" && nginx_apply || return 1
  fi
  if [[ "$route" == reverse-proxy ]]; then
    install -d -m 0700 "$CONFIG_DIR/domain"
    if [[ "$target" != "$old_conf" ]]; then
      rm -f -- "$CONFIG_DIR/domain/original.conf"
      [[ ! -f "$domain_tx/file-0" ]] || cp -p "$domain_tx/file-0" "$CONFIG_DIR/domain/original.conf"
    fi
    # Detect again to preserve the current Nginx executable after old-host cleanup.
    nginx_detect || return 1
    printf '%s\n%s\n%s\n' "$target" "$DOMAIN" "$NGINX_BIN" >"$CONFIG_DIR/domain/active"
    cp "$target" "$CONFIG_DIR/domain/installed.conf" || return 1
    domain_renew_install || return 1
  else
    rm -f -- "$CONFIG_DIR/domain/active" "$CONFIG_DIR/domain/original.conf" "$CONFIG_DIR/domain/installed.conf"
    domain_renew_remove
  fi
  install_menu || return 1
  trap - EXIT INT TERM
  rm -rf -- "$domain_tx"
  say "绑定成功：https://$DOMAIN"
)
managed_domain_suspend() {
  local suspend_lock
  exec {suspend_lock}>"$CONFIG_DIR/domain-operation.lock"
  flock -n "$suspend_lock" || { say '证书或域名操作正在执行，稍后重试。'; return 1; }
  managed_domain_read || return 1
  [[ -n "$MANAGED_CONF" ]] || return 0
  managed_domain_restore_site "$MANAGED_CONF" || return 1
  if ! nginx_apply; then
    cp "$CONFIG_DIR/domain/installed.conf" "$MANAGED_CONF"
    nginx_apply || true
    return 1
  fi
  domain_renew_remove
}
managed_domain_resume() {
  managed_domain_read || return 1
  [[ -n "$MANAGED_CONF" ]] || return 0
  if [[ -f "$MANAGED_CONF" ]] && ! cmp -s "$MANAGED_CONF" "$CONFIG_DIR/domain/installed.conf"; then
    if [[ ! -f "$CONFIG_DIR/domain/original.conf" ]] || ! cmp -s "$MANAGED_CONF" "$CONFIG_DIR/domain/original.conf"; then
      say '站点被手动修改，终端已启动，但自动恢复域名已停止。'; return 1;
    fi
  fi
  cp "$CONFIG_DIR/domain/installed.conf" "$MANAGED_CONF"
  nginx_apply || return 1
  domain_renew_install
}
clear_auto_domain() (
  load_config
  clear_lock='' domain_tx=''
  domain_paths=()
  exec {clear_lock}>"$CONFIG_DIR/domain-operation.lock"
  flock -n "$clear_lock" || return 1
  domain_tx=$(mktemp -d "$CONFIG_DIR/.auto-domain.XXXXXX")
  cp "$ENV_FILE" "$COMPOSE_FILE" "$domain_tx/"
  [[ ! -d "$CONFIG_DIR/domain" ]] || cp -a "$CONFIG_DIR/domain" "$domain_tx/domain"
  managed_domain_read || { rm -rf -- "$domain_tx"; return 1; }
  trap 'domain_auto_rollback' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ -n "$MANAGED_CONF" ]]; then
    domain_snapshot_file "$MANAGED_CONF" || return 1
    managed_domain_remove || return 1
  fi
  DOMAIN='' MODE=direct ACME_EMAIL=''
  write_config && up </dev/null && wait_health || return 1
  trap - EXIT INT TERM
  rm -rf -- "$domain_tx"
  show_access
)
