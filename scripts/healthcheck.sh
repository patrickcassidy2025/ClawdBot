#!/usr/bin/env bash
set -euo pipefail

echo "==> Clawdbot healthcheck"

echo
echo "[1] Basic files"
test -f .env && echo "OK: .env present" || echo "WARN: .env missing"
test -f config/openclaw.jsonc && echo "OK: config/openclaw.jsonc present" || echo "WARN: config/openclaw.jsonc missing"

echo
echo "[2] Tools"
command -v node >/dev/null 2>&1 && echo "OK: node installed" || echo "WARN: node missing"
command -v pnpm >/dev/null 2>&1 && echo "OK: pnpm installed" || echo "WARN: pnpm missing"

echo
echo "[3] Service status"
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet clawdbot && echo "OK: clawdbot service active" || echo "WARN: clawdbot service not active"
else
  echo "WARN: systemctl not available"
fi

echo
echo "[4] Port check"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep ":8080" >/dev/null 2>&1 && echo "OK: port 8080 listening" || echo "WARN: port 8080 not listening"
fi

echo
echo "Healthcheck complete"