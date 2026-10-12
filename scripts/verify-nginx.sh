#!/usr/bin/env bash
# Real Nginx listener acceptance, only on disposable GitHub CI hosts.
set -Eeuo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo '仅允许 CI 临时主机执行。' >&2; exit 1; }
cd "$(dirname "${0}")/.."
# shellcheck source=scripts/domain-auto.sh
source scripts/domain-auto.sh
sandbox=$(mktemp -d)
container=puffer-nginx-acceptance-$$
upstream_pid=''
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  [[ -z "$upstream_pid" ]] || kill "$upstream_pid" 2>/dev/null || true
  rm -rf -- "$sandbox"
}
trap cleanup EXIT
DOMAIN=sq.example.test DATA_BASE=$sandbox/data LOCAL_PORT=34567
mkdir -p "$sandbox/sites" "$sandbox/webroot/.well-known/acme-challenge" "$DATA_BASE/acme/letsencrypt/live/hetun-$DOMAIN"
certdir=$DATA_BASE/acme/letsencrypt/live/hetun-$DOMAIN
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj "/CN=$DOMAIN" -keyout "$certdir/privkey.pem" -out "$certdir/fullchain.pem" >/dev/null 2>&1
printf 'challenge-proof' >"$sandbox/webroot/.well-known/acme-challenge/proof"
cat >"$sandbox/nginx.conf" <<CONF
user root;
pid /tmp/nginx.pid;
events {}
http { include $sandbox/sites/*.conf; }
CONF
printf 'server { listen 80; server_name other.example.test; location / { return 200 "other-site"; } }
' >"$sandbox/sites/other.conf"
cp "$sandbox/sites/other.conf" "$sandbox/other-before"
nginx_write_site "$sandbox/sites/hetun.conf" false
node -e 'require("node:http").createServer((req,res)=>res.end(JSON.stringify({host:req.headers.host,proto:req.headers["x-forwarded-proto"],path:req.url}))).listen(34567,"127.0.0.1")' &
upstream_pid=$!
docker run -d --name "$container" --network host -v "$sandbox:$sandbox:ro" -v "$sandbox/webroot:/var/www/puffer-terminal-acme:ro" -v "$sandbox/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:stable-alpine >/dev/null
for attempt in {1..30}; do
  if curl --noproxy '*' -fsS --resolve other.example.test:80:127.0.0.1 http://other.example.test/ >"$sandbox/other-response"; then break; fi
  sleep 1
done
[[ $(cat "$sandbox/other-response") == other-site ]]
[[ $(curl --noproxy '*' -fsS --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/.well-known/acme-challenge/proof") == challenge-proof ]]
nginx_write_site "$sandbox/sites/hetun.conf" true
docker exec "$container" nginx -t
docker exec "$container" nginx -s reload
# Reload is asynchronous: wait for the newly installed TLS listener.
for attempt in {1..30}; do
  if curl --noproxy '*' --cacert "$certdir/fullchain.pem" -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health?test=1" >"$sandbox/upstream-response"; then break; fi
  sleep 1
done
node -e 'const data=JSON.parse(require("node:fs").readFileSync(process.argv[1]));if(data.host!=="sq.example.test"||data.proto!=="https"||data.path!=="/health?test=1")process.exit(1)' "$sandbox/upstream-response"
[[ $(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/") == 301 ]]
[[ $(curl --noproxy '*' -fsS --resolve other.example.test:80:127.0.0.1 http://other.example.test/) == other-site ]]
# Removing this site's file restores the remaining host unchanged.
rm -f -- "$sandbox/sites/hetun.conf"
docker exec "$container" nginx -t
docker exec "$container" nginx -s reload
cmp "$sandbox/sites/other.conf" "$sandbox/other-before"
[[ $(curl --noproxy '*' -fsS --resolve other.example.test:80:127.0.0.1 http://other.example.test/) == other-site ]]
echo '真实 Nginx / HTTP挑战 / HTTPS代理 / 转发头 / 重载 / 其他站点保护验收通过'
