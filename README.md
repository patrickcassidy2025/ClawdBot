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

## Bot commands

- `/help` — show the list of available commands
- `/clear` — reset your conversation history
- `/status` — show uptime and memory usage
- `/review <github-pr-url>` — review a GitHub pull request
- `/search <query>` — web search with a sourced summary
- `/metrics <question>` — ask the delivery-intelligence dashboard
- `/metrics status` — check if the dashboard is running
- `/project` — daily summary of the GitHub project board
- `/yesterday` — summary of project board activity from the previous calendar day (UTC), covering items created and updated yesterday, grouped by status, with completions highlighted
- `/standup` — yesterday/today/blockers standup update
- `/retrospective` — sprint retrospective for the current stage
- `/new` — new tickets created during the current stage, grouped by Type and Area
- `/ask <question>` — natural-language Q&A over recent GitHub activity

Project-board commands (`/project`, `/yesterday`, `/standup`, `/retrospective`, `/new`) accept an `in MD` suffix to return markdown-formatted output. You can also send PDFs (summarised), photos (described), and voice messages (transcribed).

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
