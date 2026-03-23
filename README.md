# ClawdBot

Clawdbot is my self-hosted personal AI assistant built on OpenClaw.

It runs on an Ubuntu VPS, connects to Telegram, and uses Claude as the initial model provider. This repository contains the deployment setup, configuration examples, workspace structure, and operational documentation needed to run it reliably and securely.

## Initial scope

- Ubuntu VPS deployment
- Telegram bot channel
- Claude model path
- systemd-managed always-on service
- secure secret handling
- workspace-based assistant identity

## Repository structure

- `config/` sample configuration and service definition
- `scripts/` install, update, healthcheck, backup
- `workspace/` assistant identity and operating context
- `docs/` setup and operations documentation

## Quick start

1. Clone the repo
2. Copy `.env.example` to `.env`
3. Populate secrets
4. Copy `config/openclaw.example.jsonc` to `config/openclaw.jsonc`
5. Run install steps from `docs/setup/server-setup.md`
6. Enable the systemd service
7. Test Telegram messaging

## Security rules

- Never commit `.env`
- Never commit tokens or keys
- Use official OpenClaw sources only
- Restrict server access to SSH key-based login

## Docs

- `docs/setup/server-setup.md`
- `docs/setup/telegram-setup.md`
- `docs/setup/model-auth.md`
- `docs/operations/runbook.md`
- `docs/operations/troubleshooting.md`
