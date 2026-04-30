# Operations Runbook

Day-to-day operations for the ClawdBot droplet. All commands assume you're SSH'd into
the server as root and the repo lives at `/opt/clawdbot`.

## Service control

```bash
systemctl start clawdbot
systemctl stop clawdbot
systemctl restart clawdbot
systemctl status clawdbot
```

## View logs

Live tail:

```bash
journalctl -u clawdbot -f
```

Last 200 lines:

```bash
journalctl -u clawdbot -n 200 --no-pager
```

Errors only since boot:

```bash
journalctl -u clawdbot -p err -b
```

## Pull and deploy code changes

```bash
cd /opt/clawdbot
git pull origin main
pnpm install        # only if package.json or lockfile changed
systemctl restart clawdbot
```

Or run the helper:

```bash
cd /opt/clawdbot && ./scripts/update.sh
```

## Edit identity / operating rules

The bot reloads `workspace/identity.md` and `workspace/operating-rules.md` only at startup.

```bash
nano /opt/clawdbot/workspace/identity.md
systemctl restart clawdbot
```

## Run the healthcheck script

```bash
cd /opt/clawdbot && ./scripts/healthcheck.sh
```

Reports on `.env` presence, node/pnpm install, service activity, and whether the webhook
port is listening.

## Rotate or update a secret

1. Edit `/opt/clawdbot/.env` and replace the relevant value.
2. `systemctl restart clawdbot` — env vars are only read at startup.

## Confirm the bot is replying

In Telegram, send `/status`. It returns uptime, message count, and the loaded model.
If `/status` doesn't return within ~5s, check `journalctl -u clawdbot -f`.

## Daily briefing

Scheduled via `node-cron` inside the service to fire at 08:00 Asia/Dubai (04:00 UTC).
It posts to `TELEGRAM_NOTIFY_CHAT_ID`. Skipped silently if that var is unset.

To trigger manually for testing, send `/standup` in the notify chat.

## Backup

```bash
cd /opt/clawdbot && ./scripts/backup.sh
```

The bot's conversation memory lives in a `better-sqlite3` database file in the repo
root — back this up if you care about retaining history across reinstalls.

## Reboot the droplet

```bash
reboot
```

The systemd unit is `enable`d, so ClawdBot starts automatically on boot.
