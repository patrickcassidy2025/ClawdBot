# Telegram Setup

How the ClawdBot Telegram bot was created and configured.

## 1. Create the bot with BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a display name (e.g. `ClawdBot`).
4. Choose a username ending in `bot` (e.g. `clawdbot_bot`).
5. BotFather replies with an HTTP API token of the form `123456789:ABC-DEF...`.

## 2. Store the token

Copy the token into `.env` at the project root:

```
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...
```

`.env` is gitignored — never commit it.

## 3. Configure the bot's command menu

Still in BotFather:

1. Send `/mybots` and select the bot.
2. Choose **Edit Bot → Edit Commands**.
3. Paste the command list:

```
help - Show available commands
clear - Clear conversation memory
status - Show bot status
search - Web search via Tavily
review - Review a GitHub PR
metrics - Delivery dashboard summary
project - Daily summary of the GitHub project board
standup - Generate a daily standup update
ask - Natural-language GitHub org query
```

This populates the `/` command autocomplete in Telegram clients.

## 4. Get your chat ID for notifications

Daily briefings and GitHub webhook alerts post to a single chat ID:

1. Start a chat with the bot and send any message.
2. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
3. Find `"chat":{"id":<number>}` in the response.
4. Set in `.env`:

```
TELEGRAM_NOTIFY_CHAT_ID=<number>
```

## 5. Verify

After `systemctl start clawdbot`, send `/help` in Telegram. The bot should respond with the command list.
