#!/usr/bin/env bash
set -euo pipefail

echo "==> Pulling latest repo changes"
git pull

echo "==> Re-installing dependencies if required"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install || true
fi

echo "==> Restarting service"
sudo systemctl restart clawdbot

echo "==> Done"
sudo systemctl status clawdbot --no-pager || true