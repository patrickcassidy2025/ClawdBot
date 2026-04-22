import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import TelegramBot from 'node-telegram-bot-api';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, createReadStream, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

async function rateLimited(chatId) {
  if (allow(chatId)) return false;
  await bot.sendMessage(
    chatId,
    `Whoa, slow down! You can send up to ${RATE_LIMIT} messages per minute. Try again in a bit.`
  );
  return true;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

async function downloadTelegramFile(fileId) {
  const link = await bot.getFileLink(fileId);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(new URL(link).pathname) || '';
  const filePath = path.join(tmpdir(), `clawdbot-${fileId}${ext}`);
  await fsp.writeFile(filePath, buffer);
  return { filePath, buffer };
}

async function askClaudeWithContent(chatId, userContent, historyNote) {
  const history = loadHistory(chatId);
  history.push({ role: 'user', content: userContent });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2048,
    system: systemPrompt,
    messages: history,
  });

  const reply = response.content.map(b => b.text ?? '').join('').trim();
  insertMessage.run(chatId, 'user', historyNote, Date.now());
  insertMessage.run(chatId, 'assistant', reply, Date.now());
  return reply;
}

bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
  const helpText = [
    'Available commands:',
    '/help — show this help message',
    '/clear — reset your conversation history',
    '/status — show uptime and memory usage',
    '',
    'You can also send me:',
    '• PDF documents — I\'ll summarise them',
    '• Photos — I\'ll describe and analyse them',
    '• Voice messages — I\'ll transcribe and respond',
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

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;
  if (!doc) return;
  if (doc.mime_type !== 'application/pdf') {
    await bot.sendMessage(chatId, 'I can only summarise PDF documents right now.');
    return;
  }
  if (await rateLimited(chatId)) return;

  const filename = doc.file_name || 'document.pdf';
  let filePath;
  try {
    await bot.sendChatAction(chatId, 'typing');
    const dl = await downloadTelegramFile(doc.file_id);
    filePath = dl.filePath;
    const base64 = dl.buffer.toString('base64');

    const instruction = msg.caption?.trim()
      ? msg.caption.trim()
      : 'Provide a structured summary of this PDF. Include: overview, key points (bulleted), notable figures or data, and suggested follow-up questions.';

    const reply = await askClaudeWithContent(
      chatId,
      [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: instruction },
      ],
      `[Sent PDF: ${filename}${msg.caption ? ` — caption: ${msg.caption}` : ''}]`
    );
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error('PDF handler error:', err);
    await bot.sendMessage(chatId, 'I couldn\'t process that PDF. Please try again.');
  } finally {
    if (filePath) await fsp.unlink(filePath).catch(() => {});
  }
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const photos = msg.photo;
  if (!photos?.length) return;
  if (await rateLimited(chatId)) return;

  const largest = photos[photos.length - 1];
  let filePath;
  try {
    await bot.sendChatAction(chatId, 'typing');
    const dl = await downloadTelegramFile(largest.file_id);
    filePath = dl.filePath;
    const base64 = dl.buffer.toString('base64');

    const instruction = msg.caption?.trim()
      ? msg.caption.trim()
      : 'Describe this image and provide any useful analysis — objects, text, context, and anything noteworthy.';

    const reply = await askClaudeWithContent(
      chatId,
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: instruction },
      ],
      `[Sent image${msg.caption ? ` — caption: ${msg.caption}` : ''}]`
    );
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error('Photo handler error:', err);
    await bot.sendMessage(chatId, 'I couldn\'t process that image. Please try again.');
  } finally {
    if (filePath) await fsp.unlink(filePath).catch(() => {});
  }
});

async function handleVoiceOrAudio(msg, fileId) {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;

  let filePath;
  try {
    await bot.sendChatAction(chatId, 'typing');
    const dl = await downloadTelegramFile(fileId);
    filePath = dl.filePath;

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: 'whisper-1',
    });
    const transcript = transcription.text?.trim();
    if (!transcript) {
      await bot.sendMessage(chatId, 'I couldn\'t hear anything in that audio.');
      return;
    }

    const reply = await askClaudeWithContent(
      chatId,
      transcript,
      `[Voice message transcript] ${transcript}`
    );
    await bot.sendMessage(chatId, `🎙 "${transcript}"\n\n${reply}`);
  } catch (err) {
    console.error('Audio handler error:', err);
    await bot.sendMessage(chatId, 'I couldn\'t transcribe that audio. Please try again.');
  } finally {
    if (filePath) await fsp.unlink(filePath).catch(() => {});
  }
}

bot.on('voice', (msg) => {
  if (msg.voice?.file_id) handleVoiceOrAudio(msg, msg.voice.file_id);
});

bot.on('audio', (msg) => {
  if (msg.audio?.file_id) handleVoiceOrAudio(msg, msg.audio.file_id);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;
  if (text.startsWith('/')) return;

  if (await rateLimited(chatId)) return;

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
