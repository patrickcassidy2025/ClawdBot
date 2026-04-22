# CLAUDE.md — ClawdBot

This file provides context for Claude Code and AI assistants working in this repository.

---

## What this project is

ClawdBot is a self-hosted Telegram AI assistant powered by the Anthropic Claude API. It runs as a systemd service on a DigitalOcean Ubuntu 24.04 droplet and responds to Telegram messages with Claude-generated replies.

This is a personal project owned and maintained by Patrick Cassidy. It is not a production SaaS product.

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js v24 (ESM modules) |
| Package manager | pnpm |
| AI model | claude-opus-4-5 via Anthropic SDK |
| Telegram channel | node-telegram-bot-api (polling mode) |
| Process manager | systemd |
| Server | DigitalOcean Droplet, Ubuntu 24.04 LTS, Amsterdam |
| Memory (current) | In-process Map (resets on restart) |
| Memory (planned) | SQLite via sql.js |

---

## Repository structure

```
ClawdBot/
├── src/
│   └── index.js          # Main bot runtime — entry point
├── config/
│   └── openclaw.jsonc    # Legacy config placeholder (not active)
├── workspace/
│   ├── identity.md       # Bot personality and persona definition
│   └── operating-rules.md # Rules governing bot behaviour
├── scripts/              # Deployment and maintenance scripts
├── docs/
│   └── setup/            # Setup documentation
├── secrets/              # Secret templates (never commit real secrets)
├── .env                  # Live secrets — never commit (gitignored)
├── package.json          # Dependencies and start script
├── pnpm-lock.yaml        # Lockfile
└── CLAUDE.md             # This file
```

---

## Entry point

```
src/index.js
```

The bot starts with `node src/index.js` or via systemd (`systemctl start clawdbot`).

It does the following on startup:
1. Loads environment variables from `.env` via dotenv
2. Reads `workspace/identity.md` and `workspace/operating-rules.md` to build the system prompt
3. Starts Telegram polling
4. Listens for messages and sends each conversation history to Claude

---

## Environment variables

All secrets live in `.env` at the project root. This file is gitignored and must never be committed.

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `ANTHROPIC_API_KEY` | Key from console.anthropic.com |
| `BOT_NAME` | Display name (default: ClawdBot) |

---

## Running the bot

**Manual (testing):**
```bash
node src/index.js
```

**Via systemd (production):**
```bash
systemctl start clawdbot
systemctl stop clawdbot
systemctl restart clawdbot
systemctl status clawdbot
```

**View live logs:**
```bash
journalctl -u clawdbot -f
```

---

## Deployment location

```
/opt/clawdbot
```

The systemd service file is at `/etc/systemd/system/clawdbot.service`.

After any code change on the server, restart the service:
```bash
systemctl restart clawdbot
```

---

## Git workflow

The repo lives at: `https://github.com/patrickcassidy2025/ClawdBot`

When making changes on the server:
```bash
git add .
git commit -m "description of change"
git push origin main
```

When pulling updates from GitHub to the server:
```bash
cd /opt/clawdbot
git pull origin main
pnpm install        # if dependencies changed
systemctl restart clawdbot
```

---

## Current limitations (planned to fix)

| Limitation | Planned solution | Roadmap phase |
|---|---|---|
| No persistent memory | SQLite conversation store | Phase 1 |
| No bot commands | /help, /clear, /status handlers | Phase 1 |
| No rate limiting | Per-user throttle | Phase 1 |
| No file handling | PDF download + Claude document API | Phase 2 |
| No image input | Claude vision API | Phase 2 |
| No voice input | Whisper API transcription | Phase 2 |
| No GitHub integration | Webhook listener + PR review | Phase 3 |
| No proactive messages | node-cron scheduled jobs | Phase 3 |
| No live data / web search | Search API integration | Phase 4 |
| No dashboard integration | delivery-intelligence query bridge | Phase 4 |

---

## Bot identity

The bot's persona is defined in `workspace/identity.md`. Operating rules (what the bot will and won't do) are in `workspace/operating-rules.md`. Both files are loaded at startup and injected as the system prompt.

To change the bot's personality or rules, edit those files and restart the service — no code changes required.

---

## Notes for Claude Code

- This project uses **ESM modules** (`"type": "module"` in package.json). Use `import`/`export` syntax, not `require()`.
- The `.env` file is **never** to be modified, read aloud, committed, or included in any output.
- The `secrets/` directory contains templates only — do not treat any file there as containing real credentials.
- When suggesting dependency changes, use `pnpm add` not `npm install`.
- The bot runs as root on the server. Be cautious with any file system operations suggested in scripts.
- Always suggest a `systemctl restart clawdbot` after code changes that affect `src/index.js`.