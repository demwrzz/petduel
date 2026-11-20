#!/usr/bin/env bash
# Pet Duel - one time server setup for an Ubuntu VM (Oracle Cloud Always Free, or any Ubuntu 22.04 / 24.04 server).
# Usage (on the server):
#   curl -fsSL https://raw.githubusercontent.com/demwrzz/petduel/main/deploy/oracle-setup.sh -o setup.sh
#   sudo bash setup.sh petduel.win
# Running it again is safe: it updates the code and restarts the site.
set -euo pipefail

DOMAIN="${1:-petduel.win}"
APP_DIR=/opt/petduel
ENV_FILE=/etc/petduel.env
REPO=https://github.com/demwrzz/petduel.git

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0 $DOMAIN"; exit 1; fi

echo "==> Installing packages"
apt-get update -y
apt-get install -y git nginx curl ca-certificates iptables-persistent certbot python3-certbot-nginx

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Getting the code"
id petduel >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin petduel
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin main && git -C "$APP_DIR" reset --hard origin/main
else
  git clone --branch main "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
chown -R petduel:petduel "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Creating $ENV_FILE (fill it in!)"
  cat > "$ENV_FILE" <<ENV
PORT=3000
MONGODB_URI=
ADMIN_USERS=
ADMIN_IDS=
SITE_URL=https://$DOMAIN
DISCORD_CF_WEBHOOK=
DISCORD_GW_WEBHOOK=
DISCORD_JP_WEBHOOK=
DISCORD_WD_WEBHOOK=
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET=
ENV
fi
chmod 600 "$ENV_FILE"

echo "==> Service (starts on boot, restarts if it crashes)"
cat > /etc/systemd/system/petduel.service <<UNIT
[Unit]
Description=Pet Duel
After=network-online.target
Wants=network-online.target

[Service]
User=petduel
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable petduel >/dev/null
systemctl restart petduel

echo "==> Nginx (web server in front of the site, with websockets for chat and games)"
cat > /etc/nginx/sites-available/petduel <<NGINX
# real visitor IP: Cloudflare sends it in CF-Connecting-IP
map \$http_cf_connecting_ip \$petduel_client_ip {
  ""      \$remote_addr;
  default \$http_cf_connecting_ip;
}

server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN www.$DOMAIN;
  client_max_body_size 2m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$petduel_client_ip;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/petduel /etc/nginx/sites-enabled/petduel
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Opening ports 80 and 443 (Oracle Ubuntu images block them by default)"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport "$port" -j ACCEPT
done
netfilter-persistent save >/dev/null

echo
echo "Done. Next steps:"
echo "  1. sudo nano $ENV_FILE        (paste your values from Render, save with Ctrl+O, Enter, Ctrl+X)"
echo "  2. sudo systemctl restart petduel"
echo "  3. curl http://127.0.0.1:3000/health   (should answer)"
echo "  4. Point $DOMAIN to this server in Cloudflare, then: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo "Logs: sudo journalctl -u petduel -f"
