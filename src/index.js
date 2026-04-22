import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import TelegramBot from 'node-telegram-bot-api';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const startTime = Date.now();

let systemPrompt = 'You are ClawdBot, a helpful AI assistant.';
try {
  const identity = readFileSync('./workspace/identity.md', 'utf8');
  const rules = readFileSync('./workspace/operating-rules.md', 'utf8');
  systemPrompt = `${identity}\n\n${rules}`;
} catch {}

mkdirSync('./data', { recursive: true });
const db = new Database('./data/conversations.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id);
`);

const insertMessage = db.prepare(
  'INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)'
);
const selectRecent = db.prepare(
  'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?'
);
const deleteByChat = db.prepare('DELETE FROM messages WHERE chat_id = ?');

const HISTORY_LIMIT = 20;

function loadHistory(chatId) {
  const rows = selectRecent.all(chatId, HISTORY_LIMIT);
  return rows.reverse().map(({ role, content }) => ({ role, content }));
}

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

function allow(chatId) {
  const now = Date.now();
  const recent = (rateBuckets.get(chatId) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(chatId, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(chatId, recent);
  return true;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
  const helpText = [
    'Available commands:',
    '/help — show this help message',
    '/clear — reset your conversation history',
    '/status — show uptime and memory usage',
  ].join('\n');
  await bot.sendMessage(msg.chat.id, helpText);
});

bot.onText(/^\/clear(?:@\w+)?$/, async (msg) => {
  deleteByChat.run(msg.chat.id);
  await bot.sendMessage(msg.chat.id, 'Conversation history cleared.');
});

bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
  const mem = process.memoryUsage();
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  const status = [
    `Uptime: ${formatUptime(Date.now() - startTime)}`,
    `RSS: ${mb(mem.rss)} MB`,
    `Heap: ${mb(mem.heapUsed)} / ${mb(mem.heapTotal)} MB`,
  ].join('\n');
  await bot.sendMessage(msg.chat.id, status);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;
  if (text.startsWith('/')) return;

  if (!allow(chatId)) {
    await bot.sendMessage(
      chatId,
      `Whoa, slow down! You can send up to ${RATE_LIMIT} messages per minute. Try again in a bit.`
    );
    return;
  }

  insertMessage.run(chatId, 'user', text, Date.now());
  const history = loadHistory(chatId);

  try {
    await bot.sendChatAction(chatId, 'typing');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content[0].text;
    insertMessage.run(chatId, 'assistant', reply, Date.now());
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, 'Something went wrong. Please try again.');
  }
});

console.log('ClawdBot is running...');
