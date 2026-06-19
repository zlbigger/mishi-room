#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-mishi.zlbigger.com}"
PORT="${2:-4173}"
APP_NAME="mishi-room"
APP_DIR="/www/wwwroot/${DOMAIN}"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "Node.js is required but was not found on this server."
  exit 1
fi

cd "$APP_DIR"

if command -v pm2 >/dev/null 2>&1; then
  pm2 startOrReload ecosystem.config.cjs --env production
  pm2 save || true
else
  cat > /etc/systemd/system/${APP_NAME}.service <<SERVICE
[Unit]
Description=Mishi Room Node service
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=${NODE_BIN} server.mjs
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
SERVICE

  systemctl daemon-reload
  systemctl enable ${APP_NAME}.service >/dev/null 2>&1 || true
  systemctl restart ${APP_NAME}.service
fi

configure_nginx() {
  local conf_dir=""

  if [ -d /www/server/panel/vhost/nginx ]; then
    conf_dir="/www/server/panel/vhost/nginx"
  elif [ -d /etc/nginx/conf.d ]; then
    conf_dir="/etc/nginx/conf.d"
  fi

  if [ -z "$conf_dir" ]; then
    echo "Nginx config directory not found; skipped proxy config."
    return 0
  fi

  local cert_dir="/www/server/panel/vhost/cert/${DOMAIN}"
  local ssl_block=""
  local ssl_listen=""

  if [ -f "${cert_dir}/fullchain.pem" ] && [ -f "${cert_dir}/privkey.pem" ]; then
    ssl_listen="    listen 443 ssl;
    listen [::]:443 ssl;"
    ssl_block="
    ssl_certificate    ${cert_dir}/fullchain.pem;
    ssl_certificate_key    ${cert_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;"
  fi

  cat > "${conf_dir}/${DOMAIN}.conf" <<NGINX
server {
    listen 80;
${ssl_listen}
    server_name ${DOMAIN};
${ssl_block}

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
    }
}
NGINX

  if command -v nginx >/dev/null 2>&1; then
    nginx -t
    nginx -s reload || systemctl reload nginx || service nginx reload
  else
    echo "Nginx binary not found; wrote config but skipped reload."
  fi
}

configure_nginx

echo "Mishi Room deployed to ${APP_DIR} on port ${PORT}."
