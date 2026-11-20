#!/usr/bin/env bash
# Pull the newest code from GitHub (main) and restart the site.  Usage: sudo bash /opt/petduel/deploy/update.sh
set -euo pipefail
cd /opt/petduel
git fetch origin main
git reset --hard origin/main
npm install --omit=dev --no-audit --no-fund
chown -R petduel:petduel /opt/petduel
systemctl restart petduel
sleep 2
curl -fsS http://127.0.0.1:3000/health >/dev/null && echo "Pet Duel updated and running." || { echo "Site did not answer, check: sudo journalctl -u petduel -n 50"; exit 1; }
