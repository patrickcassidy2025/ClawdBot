# Server Setup

How the ClawdBot host was provisioned. Reference for rebuilding the droplet from scratch.

## 1. Create the droplet

- Provider: DigitalOcean
- Image: Ubuntu 24.04 LTS
- Region: Amsterdam (AMS3)
- Plan: Basic shared CPU
- Auth: SSH key (preferred) or root password during initial setup

## 2. First connect

```bash
ssh root@<droplet_ip>
```

If you only have password auth and SSH rejects with `Permission denied (publickey)`, see
`docs/operations/troubleshooting.md` for the `PasswordAuthentication yes` fix.

## 3. Install base packages and Node.js 24

The `scripts/install.sh` helper does this end-to-end. Manually:

```bash
apt update && apt upgrade -y
apt install -y curl git unzip build-essential

curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

npm install -g pnpm

node -v   # v24.x
pnpm -v
```

`build-essential` is required so `pnpm install` can compile the `better-sqlite3`
native addon against the system toolchain.

## 4. Clone the repo

```bash
cd /opt
git clone https://github.com/patrickcassidy2025/ClawdBot.git clawdbot
cd /opt/clawdbot
pnpm install
```

If pnpm prints `Ignored build scripts: better-sqlite3`, run `pnpm approve-builds`
and approve `better-sqlite3` so the native module compiles.

## 5. Configure secrets

```bash
cp .env.example .env
nano .env
```

Fill in `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY`,
`GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and `TELEGRAM_NOTIFY_CHAT_ID`. See
`docs/setup/model-auth.md` for where each token comes from.

## 6. Create the systemd service

`/etc/systemd/system/clawdbot.service`:

```ini
[Unit]
Description=ClawdBot Telegram AI assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/clawdbot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/clawdbot/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable clawdbot
systemctl start clawdbot
systemctl status clawdbot
```

## 7. Open the webhook port (optional)

If using GitHub webhook notifications, allow inbound TCP 3001:

```bash
ufw allow 3001/tcp
```

## 8. Verify

```bash
journalctl -u clawdbot -f
```

You should see "Telegram polling started" and no errors. Send `/help` in Telegram to confirm.
