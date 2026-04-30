# Model & API Authentication

Where each API key in `.env` comes from and what it powers.

| Variable | Provider | Powers |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | Claude replies, all `/` commands that summarise |
| `OPENAI_API_KEY` | OpenAI | Whisper voice-message transcription |
| `TAVILY_API_KEY` | Tavily | `/search` web search |
| `GITHUB_TOKEN` | GitHub | `/review`, `/project`, `/standup`, `/ask`, daily briefing PRs |
| `GITHUB_WEBHOOK_SECRET` | self-generated | Verifies inbound GitHub webhook signatures |

## Anthropic

1. Sign in at <https://console.anthropic.com>.
2. **Settings → API Keys → Create Key**.
3. Copy the `sk-ant-...` value into `.env` as `ANTHROPIC_API_KEY`.
4. The bot uses `claude-opus-4-5`. Make sure the workspace has access to that model and has billing enabled.

## OpenAI (Whisper only)

Used solely for transcribing Telegram voice notes via `whisper-1`.

1. Sign in at <https://platform.openai.com>.
2. **API keys → Create new secret key**.
3. Copy the `sk-...` value into `.env` as `OPENAI_API_KEY`.
4. Add a small amount of credit to the OpenAI account — Whisper is pay-per-minute.

## Tavily

Used by the `/search` command.

1. Sign up at <https://tavily.com>.
2. Copy the API key from the dashboard into `.env` as `TAVILY_API_KEY`.
3. The free tier is sufficient for personal use.

If `TAVILY_API_KEY` is unset, `/search` returns a "not configured" message instead
of failing.

## GitHub Personal Access Token

Used by `/review`, `/project`, `/standup`, `/ask`, and the daily briefing.

1. Go to <https://github.com/settings/tokens>.
2. **Generate new token (classic)**. Use a fine-grained token only if every target repo is owned
   by you — for organisation repos (e.g. `Presight-AI/*`), classic is simpler.
3. Scopes:
   - `repo` (full) — read PRs and issues, including private repos
   - `read:org` — required for `/project` against org Projects v2 boards
   - `read:project` — Projects v2 read access
4. Copy the `ghp_...` value into `.env` as `GITHUB_TOKEN`.
5. Set `GITHUB_REPOS` to a comma-separated list (e.g.
   `patrickcassidy2025/ClawdBot,Presight-AI/vantage-backend`).
6. For the project board, set `GITHUB_PROJECT_ORG` and `GITHUB_PROJECT_NUMBER`.

## GitHub webhook secret

Used to authenticate inbound webhook deliveries on the `/webhook` endpoint (port 3001).

1. Generate a random secret:
   ```bash
   openssl rand -hex 32
   ```
2. Save it as `GITHUB_WEBHOOK_SECRET` in `.env`.
3. In each repo's **Settings → Webhooks**, add the same secret and point the payload URL at
   `http://<droplet_ip>:3001/webhook` with content type `application/json`.

## Rotation

To rotate any key: regenerate it in the provider's console, replace the value in
`/opt/clawdbot/.env` on the server, then `systemctl restart clawdbot`.
