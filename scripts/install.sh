#!/usr/bin/env bash
set -euo pipefail

echo "==> Updating apt packages"
sudo apt update && sudo apt upgrade -y

echo "==> Installing base packages"
sudo apt install -y curl git unzip build-essential

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt install -y nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "==> Installing pnpm"
  npm install -g pnpm
fi

echo "==> Node version"
node -v

echo "==> pnpm version"
pnpm -v

echo "==> Creating runtime directories"
mkdir -p logs secrets workspace/notes backup

echo "==> Install script complete"
echo "Next:"
echo "1. cp .env.example .env"
echo "2. cp config/openclaw.example.jsonc config/openclaw.jsonc"
echo "3. Populate secrets"
echo "4. Install/build OpenClaw in this repo"
echo "5. Configure systemd service"