import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import TelegramBot from 'node-telegram-bot-api';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import http from 'http';
import crypto from 'crypto';
import { tavily } from '@tavily/core';
import { readFileSync, mkdirSync, createReadStream, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const tavilyClient = process.env.TAVILY_API_KEY
  ? tavily({ apiKey: process.env.TAVILY_API_KEY })
  : null;

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';

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
    '/review <github-pr-url> — review a GitHub pull request',
    '/search <query> — web search with sourced summary',
    '/metrics <question> — ask the delivery-intelligence dashboard',
    '/metrics status — check if the dashboard is running',
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

const GITHUB_PR_URL_RE = /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/;

function chunkMessage(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function githubFetch(urlPath, { accept = 'application/vnd.github+json' } = {}) {
  const headers = {
    'Accept': accept,
    'User-Agent': 'ClawdBot',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${urlPath}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${urlPath} -> ${res.status} ${res.statusText}`);
  return res;
}

bot.onText(/^\/review(?:@\w+)?\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;

  const url = match[1];
  const parsed = url.match(GITHUB_PR_URL_RE);
  if (!parsed) {
    await bot.sendMessage(chatId, 'Please provide a valid GitHub PR URL, e.g. https://github.com/owner/repo/pull/123');
    return;
  }
  const [, owner, repo, number] = parsed;

  try {
    await bot.sendChatAction(chatId, 'typing');

    const prRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`);
    const pr = await prRes.json();
    const diffRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`, {
      accept: 'application/vnd.github.v3.diff',
    });
    let diff = await diffRes.text();
    const MAX_DIFF = 120_000;
    const truncated = diff.length > MAX_DIFF;
    if (truncated) diff = diff.slice(0, MAX_DIFF) + '\n\n[diff truncated]';

    const prompt = [
      `Review this pull request.`,
      ``,
      `Title: ${pr.title}`,
      `Author: ${pr.user?.login}`,
      `Description: ${pr.body || '(none)'}`,
      ``,
      `Provide a structured review with these sections:`,
      `1. Summary of changes`,
      `2. Potential issues`,
      `3. Security concerns`,
      `4. Suggestions`,
      ``,
      `Diff:`,
      '```diff',
      diff,
      '```',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const reply = response.content[0].text;

    insertMessage.run(chatId, 'user', `[PR review requested: ${url}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    const header = `Review of ${owner}/${repo}#${number}: ${pr.title}\n\n`;
    for (const chunk of chunkMessage(header + reply)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('PR review error:', err);
    await bot.sendMessage(chatId, `Couldn't review that PR: ${err.message}`);
  }
});

bot.onText(/^\/search(?:@\w+)?\s+([\s\S]+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;

  if (!tavilyClient) {
    await bot.sendMessage(chatId, 'Web search is unavailable: TAVILY_API_KEY is not set.');
    return;
  }

  const query = match[1].trim();
  if (!query) {
    await bot.sendMessage(chatId, 'Usage: /search <query>');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const search = await tavilyClient.search(query, {
      maxResults: 5,
      includeAnswer: true,
    });
    const results = search.results || [];
    if (!results.length) {
      await bot.sendMessage(chatId, `No web results found for: ${query}`);
      return;
    }

    const sources = results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 800)}`)
      .join('\n\n');

    const prompt = [
      `Use the web search results below to answer the question concisely and accurately.`,
      ``,
      `Question: ${query}`,
      ``,
      `Search results:`,
      sources,
      ``,
      `Write a clear answer in 2-5 short paragraphs. Cite sources inline using [1], [2], etc.`,
      `After the answer, list the sources by number with title and URL.`,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const reply = response.content.map(b => b.text ?? '').join('').trim();

    insertMessage.run(chatId, 'user', `[Web search: ${query}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('Search handler error:', err);
    await bot.sendMessage(chatId, `Search failed: ${err.message}`);
  }
});

async function consumeSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let collected = '';

  const handleEvent = (event) => {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const text =
          json.choices?.[0]?.delta?.content ??
          json.delta?.text ??
          json.content ??
          json.text ??
          json.message ??
          '';
        if (typeof text === 'string') collected += text;
      } catch {
        collected += data;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      handleEvent(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) handleEvent(buffer);
  return collected;
}

bot.onText(/^\/metrics(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;

  const arg = match[1]?.trim();
  if (!arg) {
    await bot.sendMessage(chatId, 'Usage: /metrics <question>  or  /metrics status');
    return;
  }

  if (arg.toLowerCase() === 'status') {
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/health`);
      const body = (await res.text()).trim();
      if (!res.ok) {
        await bot.sendMessage(chatId, `Dashboard health check failed: ${res.status} ${res.statusText}\n${body}`);
        return;
      }
      await bot.sendMessage(chatId, `Dashboard is up (${res.status}).\n${body || 'ok'}`);
    } catch (err) {
      console.error('Metrics status error:', err);
      await bot.sendMessage(chatId, `Dashboard unreachable: ${err.message}`);
    }
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const res = await fetch(`${DASHBOARD_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ question: arg }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      await bot.sendMessage(chatId, `Dashboard error: ${res.status} ${res.statusText}\n${errBody.slice(0, 500)}`);
      return;
    }

    const answer = (await consumeSSE(res)).trim();
    if (!answer) {
      await bot.sendMessage(chatId, 'Dashboard returned an empty response.');
      return;
    }

    insertMessage.run(chatId, 'user', `[Metrics question: ${arg}]`, Date.now());
    insertMessage.run(chatId, 'assistant', answer, Date.now());

    for (const chunk of chunkMessage(answer)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('Metrics handler error:', err);
    await bot.sendMessage(chatId, `Couldn't reach the dashboard: ${err.message}`);
  }
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

function verifyGithubSignature(rawBody, header) {
  if (!header || !process.env.GITHUB_WEBHOOK_SECRET) return false;
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const expected = Buffer.from(`sha256=${hmac.digest('hex')}`);
  const received = Buffer.from(header);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function formatPullRequestEvent(payload) {
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  const actor = pr?.user?.login;
  if (payload.action === 'opened') {
    return `🟢 PR opened in ${repo} by ${actor}\n#${pr.number} ${pr.title}\n${pr.html_url}`;
  }
  if (payload.action === 'closed') {
    if (pr.merged) return `🟣 PR merged in ${repo}\n#${pr.number} ${pr.title}\n${pr.html_url}`;
    return `🔴 PR closed (unmerged) in ${repo}\n#${pr.number} ${pr.title}\n${pr.html_url}`;
  }
  return null;
}

function formatWorkflowRunEvent(payload) {
  const run = payload.workflow_run;
  if (payload.action !== 'completed' || run?.conclusion !== 'failure') return null;
  const repo = payload.repository?.full_name;
  return `❌ Workflow failed in ${repo}\n${run.name} on ${run.head_branch} (${run.head_sha?.slice(0, 7)})\n${run.html_url}`;
}

async function handleWebhookEvent(event, payload) {
  const notifyId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!notifyId) return;
  let text = null;
  if (event === 'pull_request') text = formatPullRequestEvent(payload);
  else if (event === 'workflow_run') text = formatWorkflowRunEvent(payload);
  if (text) await bot.sendMessage(notifyId, text);
}

if (process.env.GITHUB_WEBHOOK_SECRET && process.env.TELEGRAM_NOTIFY_CHAT_ID) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404); res.end('not found'); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);

    if (!verifyGithubSignature(raw, req.headers['x-hub-signature-256'])) {
      res.writeHead(401); res.end('invalid signature'); return;
    }

    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { res.writeHead(400); res.end('invalid json'); return; }

    res.writeHead(200); res.end('ok');

    try { await handleWebhookEvent(req.headers['x-github-event'], payload); }
    catch (err) { console.error('Webhook handler error:', err); }
  });
  server.listen(3001, () => console.log('GitHub webhook server listening on :3001'));
} else {
  console.log('GitHub webhook server disabled (set GITHUB_WEBHOOK_SECRET and TELEGRAM_NOTIFY_CHAT_ID to enable).');
}

function getConfiguredRepos() {
  const list = (process.env.GITHUB_REPOS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (list.length) return list;
  return process.env.GITHUB_REPO ? [process.env.GITHUB_REPO] : [];
}

async function fetchOpenPRs() {
  const repos = getConfiguredRepos();
  if (!repos.length) return [];
  return Promise.all(repos.map(async (repo) => {
    try {
      const res = await githubFetch(`/repos/${repo}/pulls?state=open&per_page=20`);
      const prs = await res.json();
      return {
        repo,
        prs: prs.map(p => ({
          number: p.number,
          title: p.title,
          user: p.user?.login,
          url: p.html_url,
          draft: p.draft,
        })),
      };
    } catch (err) {
      console.error(`PR fetch failed for ${repo}:`, err);
      return { repo, prs: [], error: err.message };
    }
  }));
}

async function fetchWeather() {
  const location = process.env.WEATHER_LOCATION || '';
  const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=4`, {
    headers: { 'User-Agent': 'curl/8.0' },
  });
  if (!res.ok) throw new Error(`wttr.in -> ${res.status}`);
  return (await res.text()).trim();
}

async function sendDailyBriefing() {
  const notifyId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!notifyId) return;

  try {
    const [prsByRepo, weather] = await Promise.all([
      fetchOpenPRs().catch(err => { console.error('PR fetch failed:', err); return []; }),
      fetchWeather().catch(err => { console.error('Weather fetch failed:', err); return 'unavailable'; }),
    ]);

    const totalPRs = prsByRepo.reduce((n, r) => n + r.prs.length, 0);
    const prSummary = prsByRepo.length
      ? prsByRepo.map(({ repo, prs, error }) => {
          if (error) return `${repo}: (error fetching PRs: ${error})`;
          if (!prs.length) return `${repo}: (no open PRs)`;
          const lines = prs
            .map(p => `  - #${p.number}${p.draft ? ' (draft)' : ''} ${p.title} — @${p.user}`)
            .join('\n');
          return `${repo}:\n${lines}`;
        }).join('\n\n')
      : '(no repos configured)';

    const prompt = [
      `Write a friendly morning briefing for Patrick. Keep it warm but concise (5-10 short lines).`,
      `Start with a greeting and include the weather. Then summarise the open PRs across all repos — group by repo and call out anything notable. End with a small motivational nudge.`,
      ``,
      `Weather: ${weather}`,
      ``,
      `Open PRs across ${prsByRepo.length} repo(s), ${totalPRs} total:`,
      prSummary,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    await bot.sendMessage(notifyId, response.content[0].text);
  } catch (err) {
    console.error('Daily briefing failed:', err);
  }
}

if (process.env.TELEGRAM_NOTIFY_CHAT_ID) {
  cron.schedule('0 8 * * *', sendDailyBriefing, { timezone: 'Etc/UTC' });
  console.log('Daily briefing scheduled for 08:00 UTC');
} else {
  console.log('Daily briefing disabled (set TELEGRAM_NOTIFY_CHAT_ID to enable).');
}

console.log('ClawdBot is running...');
