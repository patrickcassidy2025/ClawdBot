# Troubleshooting

Common issues hit during ClawdBot setup and operation, and how to fix them.

## SSH: `Permission denied (publickey)`

Symptom: cannot SSH into the fresh droplet because the key isn't recognised, even
though DigitalOcean shows the password.

Fix on the droplet console (web shell):

```bash
nano /etc/ssh/sshd_config
```

Set:

```
PasswordAuthentication yes
PermitRootLogin yes
```

Then:

```bash
systemctl restart ssh
```

Re-enable key-only auth (`PasswordAuthentication no`) once your SSH key is installed
in `~/.ssh/authorized_keys`.

## `pnpm install` fails on `better-sqlite3`

Symptom: `gyp ERR! stack Error: not found: make` or compiler errors when installing.

Cause: `better-sqlite3` is a native module and needs a C++ toolchain.

Fix:

```bash
apt install -y build-essential python3
pnpm install
```

## `pnpm install` says `Ignored build scripts: better-sqlite3`

By default pnpm refuses to run install scripts for packages it hasn't approved.
Approve and rebuild:

```bash
cd /opt/clawdbot
pnpm approve-builds
# Select better-sqlite3 (and any other native deps) and confirm
pnpm rebuild better-sqlite3
```

## GitHub webhook returns 401

Symptom: GitHub **Recent Deliveries** shows `401 Unauthorized` from the bot.

Cause: `GITHUB_WEBHOOK_SECRET` in `.env` doesn't match the secret configured in the
repo's webhook settings, so the HMAC signature check rejects the payload.

Fix:

1. In `.env`, confirm `GITHUB_WEBHOOK_SECRET` is set and not the placeholder value.
2. In **Repo → Settings → Webhooks → edit**, re-enter the same secret.
3. `systemctl restart clawdbot`.
4. Click **Redeliver** on the failed delivery to verify.

## `EADDRINUSE` on port 3001

Symptom: bot fails to start with `Error: listen EADDRINUSE: address already in use :::3001`.

Cause: another instance of ClawdBot is still running, usually because you started
it manually with `node src/index.js` while the systemd unit was also active.

Fix:

```bash
systemctl stop clawdbot
ss -ltnp | grep 3001          # find the PID still bound
kill <pid>                    # if anything still shows
systemctl start clawdbot
```

## Telegram polling: `409 Conflict: terminated by other getUpdates request`

Cause: two processes are polling Telegram with the same bot token (e.g. a local dev
copy and the server). Only one polling client may be connected per token.

Fix: stop one of them. For local development against the real bot, stop the systemd
service first: `systemctl stop clawdbot`.

## Bot starts but never responds in Telegram

Checklist:

1. `journalctl -u clawdbot -f` — look for stack traces.
2. `TELEGRAM_BOT_TOKEN` correct in `.env`?
3. The bot has been started in a chat (`/start` once, from your account)?
4. `systemctl restart clawdbot` after any `.env` change.

## `/project` or `/standup` returns "Project board not configured"

Set both `GITHUB_PROJECT_ORG` and `GITHUB_PROJECT_NUMBER` in `.env` and restart. The
PAT must include `read:project` and `read:org` scopes.

## `/search` says it's not configured

`TAVILY_API_KEY` is missing from `.env`. Add it and restart.

## Whisper voice transcription fails

- Confirm `OPENAI_API_KEY` is set and the OpenAI account has billing enabled.
- Voice notes longer than ~25 MB will be rejected by the Whisper API — Telegram voice
  messages are typically well under this, but forwarded audio files may not be.

## "Module did not self-register" after Node version change

Symptom: after upgrading Node, `better-sqlite3` throws on require.

Fix:

```bash
cd /opt/clawdbot
pnpm rebuild better-sqlite3
systemctl restart clawdbot
```
