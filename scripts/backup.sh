#!/usr/bin/env bash
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="backup/clawdbot-backup-${STAMP}.tar.gz"

mkdir -p backup

tar -czf "$DEST" \
  config \
  docs \
  scripts \
  workspace \
  README.md \
  .env.example \
  .gitignore \
  package.json

echo "Backup created: $DEST"