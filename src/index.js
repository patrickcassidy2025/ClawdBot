import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import TelegramBot from 'node-telegram-bot-api';
import { readFileSync } from 'fs';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Load your existing identity and rules
let systemPrompt = 'You are ClawdBot, a helpful AI assistant.';
try {
  const identity = readFileSync('./workspace/identity.md', 'utf8');
  const rules = readFileSync('./workspace/operating-rules.md', 'utf8');
  systemPrompt = `${identity}\n\n${rules}`;
} catch {}

const conversations = new Map();

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);
  history.push({ role: 'user', content: text });

  if (history.length > 20) history.splice(0, history.length - 20);

  try {
    await bot.sendChatAction(chatId, 'typing');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content[0].text;
    history.push({ role: 'assistant', content: reply });
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, 'Something went wrong. Please try again.');
  }
});

console.log('ClawdBot is running...');
