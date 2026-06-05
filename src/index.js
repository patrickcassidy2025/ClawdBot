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
    '/project — daily summary of the GitHub project board',
    '/yesterday — summary of project board activity from yesterday (UTC)',
    '/standup — yesterday/today/blockers standup update',
    '/retrospective — sprint retrospective for the current stage',
    '/new — new tickets created during the current stage, grouped by Type and Area',
    '/ask <question> — natural-language Q&A over recent GitHub activity',
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
      const [summaryRes, deploymentsRes] = await Promise.all([
        fetch(`${DASHBOARD_URL}/api/summary`),
        fetch(`${DASHBOARD_URL}/api/deployments`),
      ]);

      if (!summaryRes.ok) {
        const body = (await summaryRes.text()).trim();
        await bot.sendMessage(chatId, `Dashboard summary failed: ${summaryRes.status} ${summaryRes.statusText}\n${body}`);
        return;
      }

      const summary = await summaryRes.json();
      const prs = summary.prs ?? {};
      const issues = summary.issues ?? {};

      let latest = null;
      if (deploymentsRes.ok) {
        const deployments = await deploymentsRes.json();
        const list = Array.isArray(deployments) ? deployments : (deployments?.deployments ?? []);
        latest = list[0] ?? null;
      } else {
        console.error(`Deployments fetch failed: ${deploymentsRes.status} ${deploymentsRes.statusText}`);
      }

      const fmt = (v) => (v === undefined || v === null ? 'n/a' : v);
      const fmtHours = (v) =>
        typeof v === 'number' ? `${v.toFixed(1)}h` : (v == null ? 'n/a' : String(v));
      const fmtDate = (iso) => {
        if (!iso) return 'n/a';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return String(iso);
        return d.toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
          timeZone: 'UTC', timeZoneName: 'short',
        });
      };

      const lines = [
        'Dashboard summary',
        '',
        `Current version: ${fmt(latest?.deployment_id)}`,
        `Deployed: ${fmtDate(latest?.created_at)}`,
        `Deployed by: ${fmt(latest?.creator)}`,
        '',
        'Pull requests:',
        `  • Total: ${fmt(prs.total_prs)}`,
        `  • Open: ${fmt(prs.open_prs)}`,
        `  • Merged: ${fmt(prs.merged_prs)}`,
        `  • Avg cycle time: ${fmtHours(prs.avg_cycle_time_hours)}`,
        '',
        'Issues:',
        `  • Total: ${fmt(issues.total_issues)}`,
        `  • Open: ${fmt(issues.open_issues)}`,
        `  • Closed: ${fmt(issues.closed_issues)}`,
        `  • Avg resolution: ${fmtHours(issues.avg_resolution_hours)}`,
      ];
      await bot.sendMessage(chatId, lines.join('\n'));
    } catch (err) {
      console.error('Metrics status error:', err);
      await bot.sendMessage(chatId, `Dashboard unreachable: ${err.message}`);
    }
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const question =
      'When counting tickets, bugs, features or issues use the `issues` table. ' +
      'The issues table has columns: repo, number, title, state, author, created_at, closed_at, labels. ' +
      'Do not use project_items for issue counts. ' +
      `Question: ${arg}`;
    const res = await fetch(`${DASHBOARD_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ question }),
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

const PROJECT_ITEMS_QUERY = `
  query($org: String!, $number: Int!, $after: String) {
    organization(login: $org) {
      projectV2(number: $number) {
        title
        url
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            type
            createdAt
            updatedAt
            content {
              __typename
              ... on Issue {
                title number url state closedAt
                issueType { name }
                assignees(first: 10) { nodes { login } }
              }
              ... on PullRequest {
                title number url state closedAt
                assignees(first: 10) { nodes { login } }
              }
              ... on DraftIssue {
                title
                assignees(first: 10) { nodes { login } }
              }
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  title
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function githubGraphQL(query, variables) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'ClawdBot',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const detail = json.errors ? JSON.stringify(json.errors) : `${res.status} ${res.statusText}`;
    throw new Error(`GraphQL error: ${detail}`);
  }
  return json.data;
}

async function fetchProjectItems(org, number) {
  const items = [];
  const fieldNamesSeen = new Set();
  let after = null;
  let projectMeta = null;
  while (true) {
    const data = await githubGraphQL(PROJECT_ITEMS_QUERY, { org, number, after });
    const project = data.organization?.projectV2;
    if (!project) throw new Error(`Project ${org}/#${number} not found or not accessible`);
    if (!projectMeta) projectMeta = { title: project.title, url: project.url };
    for (const node of project.items.nodes) {
      const content = node.content;
      if (!content) continue;
      for (const v of node.fieldValues.nodes) {
        if (v.field?.name) fieldNamesSeen.add(v.field.name);
      }
      const statusNode = node.fieldValues.nodes.find(
        v => v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && v.field?.name === 'Status'
      );
      const priorityNode = node.fieldValues.nodes.find(
        v => /^priority$/i.test(v.field?.name || '') &&
          (v.__typename === 'ProjectV2ItemFieldSingleSelectValue' ||
            v.__typename === 'ProjectV2ItemFieldTextValue')
      );
      const priority = priorityNode?.name ?? priorityNode?.text ?? null;
      const iterationNode = node.fieldValues.nodes.find(
        v => v.__typename === 'ProjectV2ItemFieldIterationValue' && v.title
      );
      const fields = {};
      for (const v of node.fieldValues.nodes) {
        const name = v.field?.name;
        if (!name) continue;
        const value = v.__typename === 'ProjectV2ItemFieldSingleSelectValue'
          ? v.name
          : v.__typename === 'ProjectV2ItemFieldTextValue'
            ? v.text
            : null;
        if (value == null) continue;
        fields[name.toLowerCase()] = value;
      }
      items.push({
        title: content.title,
        type: content.__typename,
        number: content.number ?? null,
        url: content.url ?? null,
        state: content.state ?? null,
        assignees: content.assignees?.nodes?.map(a => a.login) || [],
        status: statusNode?.name || 'No status',
        priority,
        updatedAt: node.updatedAt ?? null,
        createdAt: node.createdAt ?? null,
        iterationTitle: iterationNode?.title ?? null,
        closedAt: content.closedAt ?? null,
        issueType: content.issueType?.name ?? null,
        fields,
      });
    }
    if (!project.items.pageInfo.hasNextPage) break;
    after = project.items.pageInfo.endCursor;
  }
  const priorityValues = [...new Set(items.map(it => it.priority).filter(Boolean))];
  console.log(
    `[fetchProjectItems] ${org}/#${number}: ${items.length} items; ` +
      `field names seen: [${[...fieldNamesSeen].join(', ') || 'none'}]; ` +
      `priority values: [${priorityValues.join(', ') || 'none'}]`
  );
  return { items, ...projectMeta };
}

const COMPLETED_STATUSES = new Set(['done', "won't do", 'cancelled', 'closed']);

function isBlocker(item) {
  const status = (item.status || '').toLowerCase();
  if (COMPLETED_STATUSES.has(status)) return false;
  const priority = (item.priority || '').toLowerCase();
  return priority === 'blocker';
}

// Corrected stage calendar. Stages are explicit (non-uniform length):
// Stage 09 is 3 weeks; every other stage is 2 weeks, continuing 2-weekly
// from Stage 10 onwards.
const STAGES = [
  { number: 8,  start: '2026-04-26', end: '2026-05-09' },
  { number: 9,  start: '2026-05-10', end: '2026-05-31' },
  { number: 10, start: '2026-06-01', end: '2026-06-14' },
  { number: 11, start: '2026-06-15', end: '2026-06-28' },
  { number: 12, start: '2026-06-29', end: '2026-07-12' },
  { number: 13, start: '2026-07-13', end: '2026-07-26' },
  { number: 14, start: '2026-07-27', end: '2026-08-09' },
  { number: 15, start: '2026-08-10', end: '2026-08-23' },
  { number: 16, start: '2026-08-24', end: '2026-09-06' },
];

// Start of day (00:00:00.000 UTC) for a 'YYYY-MM-DD' string.
function stageStartUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// End of day (23:59:59.999 UTC) for a 'YYYY-MM-DD' string, so that the full
// final day is included by downstream `< stage.endUtc` comparisons.
function stageEndUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999);
}

function fmtStageDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function buildStage(s) {
  const startUtc = stageStartUtc(s.start);
  const endUtc = stageEndUtc(s.end);
  const startLabel = fmtStageDate(startUtc);
  const endLabel = fmtStageDate(endUtc);
  return {
    number: s.number,
    label: `Stage ${String(s.number).padStart(2, '0')}`,
    startUtc,
    endUtc,
    startLabel,
    endLabel,
    rangeLabel: `${startLabel} – ${endLabel}`,
  };
}

function getCurrentStage(now = new Date()) {
  const t = now.getTime();

  // 1. Stage whose [start, end] window (inclusive) contains `now`.
  const current = STAGES.find(s => t >= stageStartUtc(s.start) && t <= stageEndUtc(s.end));
  if (current) return buildStage(current);

  // 2. Outside all defined stages: return the most recently completed stage.
  const completed = STAGES.filter(s => stageEndUtc(s.end) < t);
  if (completed.length) return buildStage(completed[completed.length - 1]);

  // Before the calendar begins — fall back to the first defined stage.
  return buildStage(STAGES[0]);
}

function isInCurrentStage(item, stage) {
  if (item.iterationTitle) {
    const match = item.iterationTitle.match(/(\d+)/);
    if (!match) return false;
    return parseInt(match[1], 10) === stage.number;
  }
  if (item.createdAt) {
    const ct = new Date(item.createdAt).getTime();
    if (Number.isFinite(ct) && ct >= stage.startUtc && ct < stage.endUtc) {
      return true;
    }
  }
  return false;
}

function wasCompletedThisStage(item, stage) {
  if ((item.status || '').toLowerCase() !== 'done') return false;
  if (item.closedAt) {
    const t = new Date(item.closedAt).getTime();
    return Number.isFinite(t) && t >= stage.startUtc && t < stage.endUtc;
  }
  return isInCurrentStage(item, stage);
}

const TYPE_BUCKETS = ['Bug', 'Feature', 'Story', 'Task'];
const TYPE_FIELD_KEYS = ['type', 'issue type', 'kind'];

function getItemType(item) {
  let raw = null;
  for (const key of TYPE_FIELD_KEYS) {
    if (item.fields && item.fields[key]) { raw = item.fields[key]; break; }
  }
  if (!raw) raw = item.issueType;
  if (!raw) return 'No Type';
  const norm = String(raw).trim().toLowerCase();
  const match = TYPE_BUCKETS.find(b => b.toLowerCase() === norm);
  return match ?? 'No Type';
}

const AREA_FIELD_KEYS = [
  'be fe', 'fe be', 'be-fe', 'fe-be',
  'be/fe', 'fe/be', 'be / fe', 'fe / be',
  'backend/frontend', 'frontend/backend',
  'stack', 'component', 'area', 'domain', 'tech',
];

function getItemArea(item) {
  let raw = null;
  for (const key of AREA_FIELD_KEYS) {
    if (item.fields && item.fields[key]) { raw = item.fields[key]; break; }
  }
  if (!raw) return 'No Be Fe';
  const norm = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (norm === 'fe' || norm === 'frontend') return 'FE';
  if (norm === 'be' || norm === 'backend') return 'BE';
  if (norm === 'fe/be' || norm === 'be/fe' ||
      norm === 'frontend/backend' || norm === 'backend/frontend' ||
      norm === 'both' || norm === 'fe&be' || norm === 'be&fe') return 'FE/BE';
  return 'No Be Fe';
}

const MD_SUFFIX_REGEX = /\s+in\s+md\s*$/i;

function detectMdMode(text) {
  return MD_SUFFIX_REGEX.test(text || '');
}

function sendOpts() {
  return {};
}

function extractRepo(url) {
  if (!url) return null;
  const m = url.match(/github\.com\/[^/]+\/([^/]+)/);
  return m ? m[1] : null;
}

function ticketRef(item) {
  if (!item.number) return '';
  if (item.url) {
    const repo = extractRepo(item.url);
    const label = repo ? `${repo}#${item.number}` : `#${item.number}`;
    return `${label} (${item.url})`;
  }
  return `#${item.number}`;
}

function buildUrlMap(items) {
  const map = new Map();
  for (const it of items) {
    if (it.number && it.url) map.set(it.number, it.url);
  }
  return map;
}

function linkifyTicketRefs(text, urlMap) {
  if (!text || !urlMap.size) return text;
  return text.replace(/(?<![A-Za-z0-9_(])#(\d+)/g, (match, num, offset) => {
    const url = urlMap.get(Number(num));
    if (!url) return match;
    const after = text.slice(offset + match.length);
    if (after.startsWith(' (http') || after.startsWith('(http')) return match;
    const repo = extractRepo(url);
    const label = repo ? `${repo}#${num}` : `#${num}`;
    return `${label} (${url})`;
  });
}

const TICKET_FORMAT_INSTRUCTION = `TICKET FORMATTING: When you reference any ticket, render it as plain text in the form "<repo>#<number> (<url>)" — for example "<repo>#<number> (https://github.com/<org>/<repo>/issues/<number>)". The data sections below already give each ticket in that exact form — copy them verbatim, never invent, shorten, or rewrap. Only reference tickets that appear in the data below.`;

function mdFormattingInstructions() {
  return [
    ``,
    `FORMATTING (plain text — the message is sent without any parse_mode, so markdown syntax will display literally and break readability):`,
    `- Do NOT use markdown syntax: no *asterisks*, no _underscores_, no \`backticks\`, no [text](url) link syntax, no #/##/### headings.`,
    `- Use "- " (hyphen space) for bullets, and "Label:" or ALL CAPS for section labels.`,
    `- Every ticket reference must appear verbatim as "<repo>#<number> (<url>)" from the data sections. Never leave a bare #NUMBER in the prose. Telegram will auto-linkify the URL.`,
  ];
}

bot.onText(/^\/project(?:@\w+)?(\s+in\s+md)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;
  const md = !!(match && match[1]);

  const org = process.env.GITHUB_PROJECT_ORG;
  const number = Number(process.env.GITHUB_PROJECT_NUMBER);
  if (!org || !Number.isInteger(number)) {
    await bot.sendMessage(chatId, 'Project board not configured: set GITHUB_PROJECT_ORG and GITHUB_PROJECT_NUMBER.');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const { items, title, url } = await fetchProjectItems(org, number);

    if (!items.length) {
      await bot.sendMessage(chatId, `Project "${title}" has no items.`);
      return;
    }

    const stage = getCurrentStage();
    const stageItems = items.filter(it => {
      const status = (it.status || '').toLowerCase();
      if (status === "won't do") return false;
      return isInCurrentStage(it, stage);
    });

    const byStatus = stageItems.reduce((acc, it) => {
      (acc[it.status] = acc[it.status] || []).push(it);
      return acc;
    }, {});

    const counts = Object.entries(byStatus)
      .map(([status, list]) => `${status}: ${list.length}`)
      .join(', ');

    const formatItem = (it) => {
      const r = ticketRef(it);
      const ref = r ? `${r} ` : '';
      const who = it.assignees.length ? ` — @${it.assignees.join(', @')}` : '';
      const pri = it.priority ? ` [priority: ${it.priority}]` : '';
      return `  - ${ref}${it.title}${who}${pri}`;
    };

    const detail = Object.entries(byStatus)
      .map(([status, list]) => {
        const lines = list.map(formatItem).join('\n');
        return `${status} (${list.length}):\n${lines}`;
      }).join('\n\n');

    const blockers = stageItems.filter(isBlocker);
    const blockersSection = blockers.length
      ? blockers.map(formatItem).join('\n')
      : '(none)';

    const completedThisStage = items.filter(it => {
      const status = (it.status || '').toLowerCase();
      if (status === "won't do") return false;
      return wasCompletedThisStage(it, stage);
    });
    const completedSection = completedThisStage.length
      ? completedThisStage.map(formatItem).join('\n')
      : '(none)';

    const prompt = [
      `Today's date is ${new Date().toLocaleDateString('en-GB', {day: 'numeric', month: 'long', year: 'numeric'})}.`,
      `Current sprint: ${stage.label} (${stage.rangeLabel}).`,
      `Write a concise daily summary for the GitHub project "${title}" (${url}).`,
      `IMPORTANT SCOPE: Every number, count, and item below is scoped to ${stage.label} only. Do not mention or invent any historical totals, all-time Done counts, or items from previous stages. If a value isn't in the data below, do not report it.`,
      `There are TWO distinct numbers — use them precisely and do not conflate:`,
      `  • "By status" counts (Done, In Progress, etc.) are iteration membership — items tagged to ${stage.label}.`,
      `  • "Completed this stage" is the velocity signal — items closed during the stage window (may include items originally tagged to earlier stages but closed in this window).`,
      `So Done in the byStatus breakdown will usually be SMALLER than Completed this stage, and that is correct.`,
      `Cover: items by status for this stage, what's in progress (with owners), any blocked items that need attention, and a separate "Completed this stage (${stage.label})" callout that reports its own count and titles as a velocity signal.`,
      `An item counts as a blocker only if its priority is "Blocker" and its status is not Done/Won't do/Cancelled/Closed. Use the explicit Blockers list below as the source of truth — don't infer additional ones.`,
      `Reference the stage number and date range when discussing completions.`,
      `Keep it readable in Telegram — short paragraphs or grouped bullets, no markdown headings.`,
      TICKET_FORMAT_INSTRUCTION,
      ...mdFormattingInstructions(md),
      ``,
      `Stage-scoped counts by status (iteration membership) (${stage.label}, ${stage.rangeLabel}): ${counts || '(no items in this stage)'}`,
      `Total items tagged to this stage: ${stageItems.length}`,
      ``,
      `Blockers this stage (${blockers.length}):`,
      blockersSection,
      ``,
      `Completed this stage — closed during ${stage.label}, ${stage.rangeLabel} (${completedThisStage.length}):`,
      completedSection,
      ``,
      `Items tagged to this stage grouped by status:`,
      detail || '(none)',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const rawReply = response.content.map(b => b.text ?? '').join('').trim();
    const reply = linkifyTicketRefs(rawReply, buildUrlMap(items));

    insertMessage.run(chatId, 'user', `[Project summary requested: ${org}/#${number}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk, sendOpts(md));
    }
  } catch (err) {
    console.error('Project handler error:', err);
    await bot.sendMessage(chatId, `Couldn't fetch project board: ${err.message}`);
  }
});

bot.onText(/^\/standup(?:@\w+)?(\s+in\s+md)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;
  const md = !!(match && match[1]);

  const org = process.env.GITHUB_PROJECT_ORG;
  const number = Number(process.env.GITHUB_PROJECT_NUMBER);
  const projectFetch = (org && Number.isInteger(number))
    ? fetchProjectItems(org, number).catch(err => { console.error('Project fetch failed:', err); return null; })
    : Promise.resolve(null);

  try {
    await bot.sendChatAction(chatId, 'typing');

    const [prsByRepo, project] = await Promise.all([
      fetchOpenPRs().catch(err => { console.error('PR fetch failed:', err); return []; }),
      projectFetch,
    ]);

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const allOpenPRs = prsByRepo.flatMap(({ repo, prs }) => prs.map(p => ({ repo, ...p })));
    const recentPRs = allOpenPRs.filter(
      p => p.updated_at && new Date(p.updated_at).getTime() >= cutoff
    );

    const stage = getCurrentStage();
    const isUntouchedThisStage = (it) => {
      const status = (it.status || '').toLowerCase();
      if (status === 'done' || status === "won't do" || status === 'cancelled') return false;
      if (!it.updatedAt || !it.createdAt) return false;
      const updT = new Date(it.updatedAt).getTime();
      const crT = new Date(it.createdAt).getTime();
      if (!Number.isFinite(updT) || !Number.isFinite(crT)) return false;
      return updT < stage.startUtc && crT < stage.startUtc;
    };

    const inProgress = project
      ? project.items.filter(it => it.status === 'In Progress' && isInCurrentStage(it, stage))
      : [];
    const inReview = project
      ? project.items.filter(it => it.status === 'In Review' && isInCurrentStage(it, stage))
      : [];
    const blocked = project
      ? project.items.filter(it => isBlocker(it) && isInCurrentStage(it, stage))
      : [];
    const completedThisStage = project
      ? project.items.filter(it => wasCompletedThisStage(it, stage))
      : [];
    const untouched = project ? project.items.filter(isUntouchedThisStage) : [];

    const formatPR = (p) => {
      const ref = p.url
        ? `[${p.repo}#${p.number} ↗](${p.url})`
        : `${p.repo}#${p.number}`;
      return `  - ${ref}${p.draft ? ' (draft)' : ''} ${p.title}`;
    };
    const formatItem = (it) => {
      const r = ticketRef(it);
      const ref = r ? `${r} ` : '';
      const who = it.assignees.length ? ` (@${it.assignees.join(', @')})` : '';
      const pri = it.priority ? ` [priority: ${it.priority}]` : '';
      return `  - ${ref}${it.title}${who}${pri}`;
    };

    const b = '';
    const prompt = [
      `Write a daily standup update for Patrick that can be pasted directly into Slack or Teams.`,
      `Current sprint: ${stage.label} (${stage.rangeLabel}).`,
      `IMPORTANT: Only reference project board items active in ${stage.label}. Do not mention historical board items, total board counts, or anything outside this stage's date range.`,
      `Use exactly these four sections, in this order, with the labels shown (write labels as plain text followed by a colon):`,
      `${b}Yesterday${b} — derive from PRs updated in the last 24 hours.`,
      `${b}Today${b} — derive from In Progress and In Review project board items active in ${stage.label}, plus open PRs.`,
      `${b}Blockers${b} — list blocked project board items active in ${stage.label}, or write "None" if there are none.`,
      `${b}Completed this stage (${stage.label})${b} — list titles completed in the current stage as a velocity signal, or write "None" if empty. Mention the stage date range once.`,
      `Tight bullets only. No preamble, no sign-off, no emoji, professional tone.`,
      TICKET_FORMAT_INSTRUCTION,
      ...mdFormattingInstructions(md),
      ``,
      `Stage-scoped counts (${stage.label}):`,
      `  Completed this stage (closed during stage window): ${completedThisStage.length}`,
      `  In Progress (tagged to this iteration): ${inProgress.length}`,
      `  In Review (tagged to this iteration): ${inReview.length}`,
      `  Blockers this stage: ${blocked.length}`,
      `  Untouched (existed before stage, not updated since): ${untouched.length}`,
      ``,
      `=== PRs updated in the last 24 hours ===`,
      recentPRs.length ? recentPRs.map(formatPR).join('\n') : '(none)',
      ``,
      `=== All open PRs (context) ===`,
      allOpenPRs.length ? allOpenPRs.map(formatPR).join('\n') : '(none)',
      ``,
      `=== Project board: In Progress this stage ===`,
      inProgress.length ? inProgress.map(formatItem).join('\n') : '(none)',
      ``,
      `=== Project board: In Review this stage ===`,
      inReview.length ? inReview.map(formatItem).join('\n') : '(none)',
      ``,
      `=== Project board: Blocked this stage ===`,
      blocked.length ? blocked.map(formatItem).join('\n') : '(none)',
      ``,
      `=== Project board: Completed this stage (${stage.label}, ${stage.rangeLabel}) ===`,
      completedThisStage.length ? completedThisStage.map(formatItem).join('\n') : '(none)',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const rawReply = response.content.map(b => b.text ?? '').join('').trim();
    const ticketUrlMap = project ? buildUrlMap(project.items) : new Map();
    for (const p of allOpenPRs) {
      if (p.number && p.url) ticketUrlMap.set(p.number, p.url);
    }
    const reply = linkifyTicketRefs(rawReply, ticketUrlMap);

    insertMessage.run(chatId, 'user', '[Standup requested]', Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk, sendOpts(md));
    }
  } catch (err) {
    console.error('Standup handler error:', err);
    await bot.sendMessage(chatId, `Couldn't generate standup: ${err.message}`);
  }
});

bot.onText(/^\/retrospective(?:@\w+)?(\s+in\s+md)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;
  const md = !!(match && match[1]);

  const org = process.env.GITHUB_PROJECT_ORG;
  const number = Number(process.env.GITHUB_PROJECT_NUMBER);
  if (!org || !Number.isInteger(number)) {
    await bot.sendMessage(chatId, 'Project board not configured: set GITHUB_PROJECT_ORG and GITHUB_PROJECT_NUMBER.');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const { items, title, url } = await fetchProjectItems(org, number);

    if (!items.length) {
      await bot.sendMessage(chatId, `Project "${title}" has no items.`);
      return;
    }

    const stage = getCurrentStage();
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const daysSince = (iso) => {
      if (!iso) return null;
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return null;
      return Math.floor((now - t) / DAY_MS);
    };

    const completed = items.filter(it => wasCompletedThisStage(it, stage));
    const blockers = items.filter(isBlocker);

    const untouched = items.filter(it => {
      const status = (it.status || '').toLowerCase();
      if (status === 'done' || status === "won't do" || status === 'cancelled') return false;
      if (!it.updatedAt || !it.createdAt) return false;
      const updT = new Date(it.updatedAt).getTime();
      const crT = new Date(it.createdAt).getTime();
      if (!Number.isFinite(updT) || !Number.isFinite(crT)) return false;
      return updT < stage.startUtc && crT < stage.startUtc;
    });
    const untouchedSorted = [...untouched].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const untouchedDisplay = untouchedSorted.slice(0, 20);

    const completedDisplay = completed.slice(0, 30);
    const blockersDisplay = blockers.slice(0, 30);

    const inProgressThisStage = items.filter(it => it.status === 'In Progress' && isInCurrentStage(it, stage));
    const inReviewThisStage = items.filter(it => it.status === 'In Review' && isInCurrentStage(it, stage));
    const blockersThisStage = items.filter(it => isBlocker(it) && isInCurrentStage(it, stage));
    const activeSet = new Set([
      ...inProgressThisStage,
      ...inReviewThisStage,
      ...blockersThisStage,
      ...untouched,
    ]);
    const activeThisStage = activeSet.size;
    const stageTotal = completed.length + activeThisStage;
    const stageCompletionRate = stageTotal > 0
      ? `${Math.round((completed.length / stageTotal) * 100)}% (${completed.length}/${stageTotal})`
      : 'n/a';

    const formatItem = (it) => {
      const r = ticketRef(it);
      const ref = r ? `${r} ` : '';
      const who = it.assignees.length ? ` — @${it.assignees.join(', @')}` : '';
      const pri = it.priority ? ` [priority: ${it.priority}]` : '';
      return `  - ${ref}${it.title}${who}${pri}`;
    };

    const formatBlocker = (it) => {
      const r = ticketRef(it);
      const ref = r ? `${r} ` : '';
      const who = it.assignees.length ? ` — @${it.assignees.join(', @')}` : ' — (unassigned)';
      const pri = it.priority ? ` [priority: ${it.priority}]` : ' [priority: unset]';
      const d = daysSince(it.updatedAt);
      const age = d === null ? '' : ` (in current status for ${d} day${d === 1 ? '' : 's'})`;
      return `  - ${ref}${it.title}${who}${pri}${age}`;
    };

    const formatStale = (it) => {
      const r = ticketRef(it);
      const ref = r ? `${r} ` : '';
      const last = it.updatedAt ? new Date(it.updatedAt).toISOString().slice(0, 10) : 'unknown';
      const created = it.createdAt ? new Date(it.createdAt).toISOString().slice(0, 10) : 'unknown';
      const status = it.status || 'No status';
      return `  - ${ref}${it.title} (status: ${status}, created: ${created}, last updated: ${last})`;
    };

    const fmtUtcDate = (ms) => new Date(ms).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
    const stageStartLabel = fmtUtcDate(stage.startUtc);
    const stageEndLabel = fmtUtcDate(stage.endUtc - 1);
    const stageHeader = `${stage.label} (${stage.rangeLabel})`;
    const b = '';
    const prompt = [
      `Write a sprint retrospective for the GitHub project "${title}" (${url}).`,
      `Today's date is ${new Date().toLocaleDateString('en-GB', {day: 'numeric', month: 'long', year: 'numeric'})}.`,
      `Current sprint: ${stageHeader}.`,
      ``,
      `IMPORTANT SCOPE: This retrospective is ONLY about ${stageHeader}.`,
      `Do not reference, speculate about, or analyse historical items outside this stage's date range`,
      `except where they appear explicitly in the data sections below. Treat the board's long-term backlog`,
      `as out of scope — focus on what happened in ${stage.label} and what is currently active.`,
      `Use the exact stage window dates supplied in each section heading below — do not infer or guess dates.`,
      ``,
      `Write this as a narrative retrospective — not just bullet points — suitable for sharing with a team lead or stakeholder.`,
      `Use exactly these five sections in order, with the labels shown (write labels as plain text followed by a colon):`,
      ``,
      `${b}Stage summary${b} — name ${stageHeader}, items completed this stage, items active this stage, and the stage completion rate. Do NOT cite total board items or total Done across all stages — use only the stage-scoped numbers provided.`,
      `${b}What we completed${b} — narrative of key themes from items completed during ${stageHeader}. Group by component or theme where the titles suggest one. Highlight what shipped, not just a list.`,
      `${b}Blockers and concerns${b} — for each blocker active in ${stageHeader}, mention title, assignee, priority, and how long it has been in its current status. Comment on what the blocker pattern suggests.`,
      `${b}Untouched items${b} — stale items that existed before ${stageStartLabel} and haven't been touched since the stage began. List titles and dates and note whether they look forgotten.`,
      `${b}Velocity trend${b} — for ${stageHeader}, note items completed this stage and the stage completion rate. Brief comment on what the rate suggests, no historical speculation and no all-time totals.`,
      ``,
      `Tone: honest, direct, professional. Plain text suitable for Telegram — short paragraphs, no markdown of any kind.`,
      TICKET_FORMAT_INSTRUCTION,
      ...mdFormattingInstructions(md),
      ``,
      `=== Stage summary (${stageHeader}) ===`,
      `Stage: ${stage.label} (number ${stage.number})`,
      `Stage window: ${stageStartLabel} – ${stageEndLabel}`,
      `Items completed during ${stage.label}: ${completed.length}`,
      `Items active in ${stage.label} (In Progress + In Review + Blockers + untouched, deduplicated): ${activeThisStage}`,
      `Stage completion rate (completed / (completed + active)): ${stageCompletionRate}`,
      ``,
      `=== Completed during ${stageHeader} (${completed.length}${completed.length > completedDisplay.length ? `, showing first ${completedDisplay.length}` : ''}) ===`,
      completedDisplay.length ? completedDisplay.map(formatItem).join('\n') : '(none)',
      ``,
      `=== Blockers and concerns during ${stageHeader} (${blockers.length}${blockers.length > blockersDisplay.length ? `, showing first ${blockersDisplay.length}` : ''}) ===`,
      blockersDisplay.length ? blockersDisplay.map(formatBlocker).join('\n') : '(none)',
      ``,
      `=== Not updated since stage start (${stageStartLabel}) — created before stage start, status not Done/Won't do/Cancelled (${untouched.length} total${untouched.length > untouchedDisplay.length ? `, showing 20 most recently created` : ''}) ===`,
      untouchedDisplay.length ? untouchedDisplay.map(formatStale).join('\n') : '(none)',
      ``,
      `=== ${stage.label} velocity (${stage.rangeLabel}) ===`,
      `Items completed in ${stage.label}: ${completed.length}`,
      `Items active in ${stage.label}: ${activeThisStage}`,
      `Stage completion rate: ${stageCompletionRate}`,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const rawReply = response.content.map(b => b.text ?? '').join('').trim();
    const reply = linkifyTicketRefs(rawReply, buildUrlMap(items));

    insertMessage.run(chatId, 'user', `[Retrospective requested: ${stage.label}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk, sendOpts(md));
    }
  } catch (err) {
    console.error('Retrospective handler error:', err);
    await bot.sendMessage(chatId, `Couldn't generate retrospective: ${err.message}`);
  }
});

bot.onText(/^\/new(?:@\w+)?(\s+in\s+md)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;
  const md = !!(match && match[1]);

  const org = process.env.GITHUB_PROJECT_ORG;
  const number = Number(process.env.GITHUB_PROJECT_NUMBER);
  if (!org || !Number.isInteger(number)) {
    await bot.sendMessage(chatId, 'Project board not configured: set GITHUB_PROJECT_ORG and GITHUB_PROJECT_NUMBER.');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const { items } = await fetchProjectItems(org, number);
    const stage = getCurrentStage();

    const newItems = items.filter(it => {
      if ((it.status || '').toLowerCase() === "won't do") return false;
      if (!it.createdAt) return false;
      const t = new Date(it.createdAt).getTime();
      return Number.isFinite(t) && t >= stage.startUtc && t < stage.endUtc;
    });

    const b = '';
    const headerLine = `${b}New tickets — ${stage.label} (${stage.rangeLabel})${b}`;

    if (!newItems.length) {
      const empty = `${headerLine}\nTotal: 0`;
      insertMessage.run(chatId, 'user', `[New tickets requested: ${stage.label}]`, Date.now());
      insertMessage.run(chatId, 'assistant', empty, Date.now());
      await bot.sendMessage(chatId, empty, sendOpts(md));
      return;
    }

    const TYPE_ORDER = ['Bug', 'Feature', 'Story', 'Task', 'No Type'];
    const AREA_ORDER = ['FE', 'BE', 'FE/BE', 'No Be Fe'];

    const byType = Object.fromEntries(TYPE_ORDER.map(t => [t, []]));
    const areaCounts = Object.fromEntries(AREA_ORDER.map(a => [a, 0]));
    for (const it of newItems) {
      const tBucket = getItemType(it);
      const aBucket = getItemArea(it);
      byType[tBucket].push({ item: it, area: aBucket });
      areaCounts[aBucket] += 1;
    }

    const formatItem = ({ item, area }) => {
      const r = ticketRef(item);
      const ref = r ? `${r} ` : '';
      const who = item.assignees.length ? ` — @${item.assignees.join(', @')}` : '';
      return `  - [${area}] ${ref}${item.title}${who}`;
    };

    const lines = [
      headerLine,
      `Total: ${newItems.length}`,
      ``,
      `${b}By Type${b}: ` + TYPE_ORDER.map(t => `${t} ${byType[t].length}`).join(' · '),
      `${b}By Area${b}: ` + AREA_ORDER.map(a => `${a} ${areaCounts[a]}`).join(' · '),
      ``,
    ];
    for (const t of TYPE_ORDER) {
      if (!byType[t].length) continue;
      lines.push(`${b}${t} (${byType[t].length})${b}:`);
      for (const entry of byType[t]) lines.push(formatItem(entry));
      lines.push('');
    }

    const reply = lines.join('\n').trimEnd();
    insertMessage.run(chatId, 'user', `[New tickets requested: ${stage.label}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk, sendOpts(md));
    }
  } catch (err) {
    console.error('New tickets handler error:', err);
    await bot.sendMessage(chatId, `Couldn't fetch new tickets: ${err.message}`);
  }
});

bot.onText(/^\/yesterday(?:@\w+)?(\s+in\s+md)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;
  const md = !!(match && match[1]);

  const org = process.env.GITHUB_PROJECT_ORG;
  const number = Number(process.env.GITHUB_PROJECT_NUMBER);
  if (!org || !Number.isInteger(number)) {
    await bot.sendMessage(chatId, 'Project board not configured: set GITHUB_PROJECT_ORG and GITHUB_PROJECT_NUMBER.');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const { items, title, url } = await fetchProjectItems(org, number);

    if (!items.length) {
      await bot.sendMessage(chatId, `Project "${title}" has no items.`);
      return;
    }

    const now = new Date();
    const yesterdayStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0));
    const yesterdayEnd = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59));
    const ys = yesterdayStart.getTime();
    const ye = yesterdayEnd.getTime();
    const yLabel = yesterdayStart.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });

    const inYesterday = (iso) => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return Number.isFinite(t) && t >= ys && t <= ye;
    };
    const isExcluded = (it) => {
      const status = (it.status || '').toLowerCase();
      return status === "won't do" || status === 'cancelled';
    };

    const isBlockerPriority = (it) => (it.priority || '').toLowerCase() === 'blocker';

    const esc = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim() || '—';
    const who = (it) => it.assignees.length ? it.assignees.map(a => `@${a}`).join(', ') : 'unassigned';
    const num = (it) => it.number ? `#${it.number}` : '#—';
    const dateOf = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : '—';

    const stage = getCurrentStage();
    const stageStartLabel = new Date(stage.startUtc).toISOString().slice(0, 10);

    // Section 1: Closed this stage (uses the shared completed-in-stage logic).
    const closedThisStage = items.filter(it => !isExcluded(it) && wasCompletedThisStage(it, stage));

    const TYPE_ORDER = ['Bug', 'Feature', 'Task', 'Story', 'No Type'];
    const typeCounts = Object.fromEntries(TYPE_ORDER.map(t => [t, 0]));
    for (const it of closedThisStage) {
      const t = getItemType(it);
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    // Show Story only when present, so the line reads Bug/Feature/Task/No Type otherwise.
    const typeLine = TYPE_ORDER
      .filter(t => t !== 'Story' || typeCounts['Story'] > 0)
      .map(t => `${t}: ${typeCounts[t]}`).join(', ');

    // Closed-ticket data passed for theme analysis only — not to be listed.
    const closedThemeData = closedThisStage.slice(0, 60)
      .map(it => `- ${esc(it.title)} [${getItemType(it)}]`);

    // Section 2: In Progress with no activity this stage (updatedAt before stage start).
    const SECTION_CAP = 30;
    const inProgressStaleStage = items
      .filter(it => {
        if (isExcluded(it)) return false;
        if ((it.status || '').toLowerCase() !== 'in progress') return false;
        if (!it.updatedAt) return false;
        const t = new Date(it.updatedAt).getTime();
        return Number.isFinite(t) && t < stage.startUtc;
      })
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    const section2Lines = inProgressStaleStage.slice(0, SECTION_CAP).map(it =>
      `${num(it)} — ${esc(it.title)} (${who(it)}) [${it.priority || 'No priority'}] — Last updated: ${dateOf(it.updatedAt)}`);

    // Section 3: Created yesterday, regardless of current status.
    const createdYesterday = items.filter(it => !isExcluded(it) && inYesterday(it.createdAt));
    const section3Lines = createdYesterday.slice(0, SECTION_CAP).map(it =>
      `${num(it)} — ${esc(it.title)} (${who(it)}) [${it.priority || 'No priority'}] [${it.status || 'No status'}]`);

    // Summary line counts — daily pulse (yesterday-scoped) plus In Progress untouched this stage.
    const touchedCount = items.filter(it => !isExcluded(it) && inYesterday(it.updatedAt)).length;
    const closedYesterdayCount = items.filter(it =>
      !isExcluded(it) && (it.status || '').toLowerCase() === 'done' && inYesterday(it.updatedAt)).length;
    const blockersRaised = items.filter(it =>
      !isExcluded(it) && isBlockerPriority(it) && (inYesterday(it.updatedAt) || inYesterday(it.createdAt))).length;

    const summaryLine = `${yLabel} — Touched: ${touchedCount} | Created: ${createdYesterday.length} | Closed: ${closedYesterdayCount} | Blockers raised: ${blockersRaised} | In Progress untouched this stage: ${inProgressStaleStage.length}`;

    const prompt = [
      `Generate a compact, factual daily activity report for the GitHub project "${title}".`,
      `Current stage: ${stage.label} (started ${stageStartLabel}).`,
      ``,
      `STRICT RULES:`,
      `- Factual only. No pleasantries or subjective praise. Never write phrases like "highly productive", "great progress", or "the team did well".`,
      `- No URLs and no ticket links anywhere. Use the bare "#NUMBER" form only.`,
      `- Do NOT use markdown tables. Use plain structured text with " — " (space-hyphen-space) as the field separator, exactly as shown in the data lines below.`,
      `- Reproduce every data line in Sections 2 and 3 verbatim — do not add, drop, reorder, reword, or summarise, and add NO narrative in those sections.`,
      `- Commentary/insight is allowed ONLY in Section 1's closing sentence(s), and only where directly supported by the data (e.g. "8 of 12 closed were Medium priority" or "work concentrated on two assignees").`,
      `- Output the summary line first, then the three sections in order with the exact section headers shown, and nothing else.`,
      ``,
      `=== LINE 1 — SUMMARY (output exactly, as the first line) ===`,
      summaryLine,
      ``,
      `=== SECTION 1 — print the header "Closed this stage" then, each on its own line: ===`,
      `Total closed this stage: ${closedThisStage.length}`,
      `By type: ${typeLine}`,
      `Then add ONE or TWO sentences of factual insight (dominant themes, concentration of work, notable patterns — e.g. "8 of 12 closed were bugs") drawn ONLY from the closed-ticket data below. Do NOT list the tickets individually.`,
      `Closed-ticket data for theme analysis only (do NOT reproduce as a list):`,
      closedThisStage.length ? closedThemeData.join('\n') : '(none closed this stage)',
      ``,
      `=== SECTION 2 — print the header "In Progress: no activity this stage" then output these lines verbatim (if "None", output just: None) ===`,
      section2Lines.length ? section2Lines.join('\n') : 'None',
      ``,
      `=== SECTION 3 — print the header "Created yesterday" then output these lines verbatim (if "None", output just: None) ===`,
      section3Lines.length ? section3Lines.join('\n') : 'None',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    // No linkify — this report intentionally contains no URLs or ticket links.
    const reply = response.content.map(b => b.text ?? '').join('').trim();

    insertMessage.run(chatId, 'user', `[Yesterday activity requested: ${yLabel}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk, sendOpts(md));
    }
  } catch (err) {
    console.error('Yesterday handler error:', err);
    await bot.sendMessage(chatId, `Couldn't generate yesterday's activity summary: ${err.message}`);
  }
});

bot.onText(/^\/ask(?:@\w+)?\s+([\s\S]+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;

  const question = match[1].trim();
  if (!question) {
    await bot.sendMessage(chatId, 'Usage: /ask <question>');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sinceIso = new Date(sinceMs).toISOString();

    const [commitsByRepo, mergedByRepo, openByRepo] = await Promise.all([
      fetchRecentCommits(sinceIso).catch(err => { console.error('Commits fetch failed:', err); return []; }),
      fetchRecentlyMergedPRs(sinceMs).catch(err => { console.error('Merged PR fetch failed:', err); return []; }),
      fetchOpenPRs().catch(err => { console.error('Open PR fetch failed:', err); return []; }),
    ]);

    const commitsSection = commitsByRepo.length
      ? commitsByRepo.map(({ repo, commits, error }) => {
          if (error) return `${repo}: (error: ${error})`;
          if (!commits.length) return `${repo}: (no commits)`;
          const lines = commits
            .map(c => `  - ${c.sha} ${c.message} — @${c.author} (${c.date})`)
            .join('\n');
          return `${repo}:\n${lines}`;
        }).join('\n\n')
      : '(no repos configured)';

    const mergedSection = mergedByRepo.length
      ? mergedByRepo.map(({ repo, prs, error }) => {
          if (error) return `${repo}: (error: ${error})`;
          if (!prs.length) return `${repo}: (no merged PRs)`;
          const lines = prs
            .map(p => `  - #${p.number} ${p.title} — @${p.user} (merged ${p.merged_at})`)
            .join('\n');
          return `${repo}:\n${lines}`;
        }).join('\n\n')
      : '(no repos configured)';

    const openSection = openByRepo.length
      ? openByRepo.map(({ repo, prs, error }) => {
          if (error) return `${repo}: (error: ${error})`;
          if (!prs.length) return `${repo}: (no open PRs)`;
          const lines = prs
            .map(p => `  - #${p.number}${p.draft ? ' (draft)' : ''} ${p.title} — @${p.user}`)
            .join('\n');
          return `${repo}:\n${lines}`;
        }).join('\n\n')
      : '(no repos configured)';

    const prompt = [
      `Answer Patrick's question about the Presight-AI GitHub org using only the activity data below.`,
      `Be concise, factual, and natural — write like a colleague summarising the week. Short paragraphs or grouped bullets, no markdown headings.`,
      `If the data doesn't contain enough information to answer, say so honestly rather than guessing.`,
      ``,
      `Question: ${question}`,
      ``,
      `=== Commits in the last 7 days ===`,
      commitsSection,
      ``,
      `=== PRs merged in the last 7 days ===`,
      mergedSection,
      ``,
      `=== Currently open PRs ===`,
      openSection,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const reply = response.content.map(b => b.text ?? '').join('').trim();

    insertMessage.run(chatId, 'user', `[Ask: ${question}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('Ask handler error:', err);
    await bot.sendMessage(chatId, `Couldn't answer that: ${err.message}`);
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
          updated_at: p.updated_at,
        })),
      };
    } catch (err) {
      console.error(`PR fetch failed for ${repo}:`, err);
      return { repo, prs: [], error: err.message };
    }
  }));
}

async function fetchRecentCommits(sinceIso) {
  const repos = getConfiguredRepos();
  if (!repos.length) return [];
  return Promise.all(repos.map(async (repo) => {
    try {
      const res = await githubFetch(
        `/repos/${repo}/commits?since=${encodeURIComponent(sinceIso)}&per_page=50`
      );
      const commits = await res.json();
      return {
        repo,
        commits: commits.map(c => ({
          sha: c.sha?.slice(0, 7),
          message: (c.commit?.message || '').split('\n')[0],
          author: c.author?.login || c.commit?.author?.name || 'unknown',
          date: c.commit?.author?.date,
          url: c.html_url,
        })),
      };
    } catch (err) {
      console.error(`Commits fetch failed for ${repo}:`, err);
      return { repo, commits: [], error: err.message };
    }
  }));
}

async function fetchRecentlyMergedPRs(sinceMs) {
  const repos = getConfiguredRepos();
  if (!repos.length) return [];
  return Promise.all(repos.map(async (repo) => {
    try {
      const res = await githubFetch(
        `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=20`
      );
      const prs = await res.json();
      const merged = prs
        .filter(p => p.merged_at && new Date(p.merged_at).getTime() >= sinceMs)
        .map(p => ({
          number: p.number,
          title: p.title,
          user: p.user?.login,
          url: p.html_url,
          merged_at: p.merged_at,
        }));
      return { repo, prs: merged };
    } catch (err) {
      console.error(`Merged PR fetch failed for ${repo}:`, err);
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

async function fetchProjectForBriefing() {
  const org = process.env.GITHUB_PROJECT_ORG;
  const number = Number(process.env.GITHUB_PROJECT_NUMBER);
  if (!org || !Number.isInteger(number)) return null;
  return fetchProjectItems(org, number);
}

async function sendDailyBriefing() {
  const notifyId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!notifyId) return;
  const md = process.env.BRIEFING_MD === '1';

  try {
    const [prsByRepo, project] = await Promise.all([
      fetchOpenPRs().catch(err => { console.error('PR fetch failed:', err); return []; }),
      fetchProjectForBriefing().catch(err => { console.error('Project fetch failed:', err); return null; }),
    ]);

    const totalPRs = prsByRepo.reduce((n, r) => n + r.prs.length, 0);
    const prSummary = prsByRepo.length
      ? prsByRepo.map(({ repo, prs, error }) => {
          if (error) return `${repo}: (error fetching PRs: ${error})`;
          if (!prs.length) return `${repo}: (no open PRs)`;
          const lines = prs
            .map(p => {
              const ref = p.url
                ? `[${repo}#${p.number} ↗](${p.url})`
                : `${repo}#${p.number}`;
              return `  - ${ref}${p.draft ? ' (draft)' : ''} ${p.title} — @${p.user}`;
            })
            .join('\n');
          return `${repo}:\n${lines}`;
        }).join('\n\n')
      : '(no repos configured)';

    const stage = getCurrentStage();
    const isUntouchedThisStage = (it) => {
      const status = (it.status || '').toLowerCase();
      if (status === 'done' || status === "won't do" || status === 'cancelled') return false;
      if (!it.updatedAt || !it.createdAt) return false;
      const updT = new Date(it.updatedAt).getTime();
      const crT = new Date(it.createdAt).getTime();
      if (!Number.isFinite(updT) || !Number.isFinite(crT)) return false;
      return updT < stage.startUtc && crT < stage.startUtc;
    };

    let projectSection = '(project board not configured)';
    if (project && project.items.length) {
      const formatItem = (it) => {
        const r = ticketRef(it);
        const ref = r ? `${r} ` : '';
        const who = it.assignees.length ? ` — @${it.assignees.join(', @')}` : '';
        const pri = it.priority ? ` [priority: ${it.priority}]` : '';
        return `  - ${ref}${it.title}${who}${pri}`;
      };
      const renderList = (list) => list.length ? list.map(formatItem).join('\n') : '  (none)';

      const inProgressItems = project.items.filter(it => it.status === 'In Progress' && isInCurrentStage(it, stage));
      const inReviewItems = project.items.filter(it => it.status === 'In Review' && isInCurrentStage(it, stage));
      const blockedItems = project.items.filter(it => isBlocker(it) && isInCurrentStage(it, stage));
      const completedItems = project.items.filter(it => wasCompletedThisStage(it, stage));
      const untouchedItems = project.items.filter(isUntouchedThisStage);

      projectSection = [
        `${project.title} — ${stage.label} (${stage.rangeLabel})`,
        `Stage-scoped counts:`,
        `  Completed this stage (closed during stage window): ${completedItems.length}`,
        `  In Progress (tagged to this iteration): ${inProgressItems.length}`,
        `  In Review (tagged to this iteration): ${inReviewItems.length}`,
        `  Blockers this stage: ${blockedItems.length}`,
        `  Untouched (existed before stage, not updated since): ${untouchedItems.length}`,
        ``,
        `In Progress this stage:`,
        renderList(inProgressItems),
        `In Review this stage:`,
        renderList(inReviewItems),
        `Blocked this stage:`,
        renderList(blockedItems),
        `Completed this stage:`,
        renderList(completedItems),
      ].join('\n');
    } else if (project) {
      projectSection = `${project.title} — no items`;
    }

    const prompt = [
      `Write a friendly morning briefing for Patrick. Keep it warm but concise (10-16 short lines).`,
      `Current sprint: ${stage.label} (${stage.rangeLabel}).`,
      `IMPORTANT: Only reference project board items active in ${stage.label}. Do not mention historical board items, total board counts, or anything outside this stage's date range.`,
      `Cover, in this order:`,
      `1. Greeting`,
      `2. Open PRs across all repos — group by repo, call out anything notable`,
      `3. Project board status this stage — use the stage-scoped counts only. Mention what's in progress, what's in review, and anything blocked that needs attention. An item counts as a blocker only if its priority is "Blocker" and its status is not Done/Won't do/Cancelled/Closed.`,
      `4. Velocity for the current stage: report a "Completed this stage (${stage.label})" line with the count and titles, and reference the stage date range once.`,
      `5. End with a small motivational nudge`,
      `No markdown headings. Plain text suitable for Telegram.`,
      TICKET_FORMAT_INSTRUCTION,
      ...mdFormattingInstructions(md),
      ``,
      `Open PRs across ${prsByRepo.length} repo(s), ${totalPRs} total:`,
      prSummary,
      ``,
      `Project board (${stage.label} only):`,
      projectSection,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 900,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const rawReply = response.content[0].text;
    const ticketUrlMap = project ? buildUrlMap(project.items) : new Map();
    for (const { prs } of prsByRepo) {
      for (const p of prs) {
        if (p.number && p.url) ticketUrlMap.set(p.number, p.url);
      }
    }
    const reply = linkifyTicketRefs(rawReply, ticketUrlMap);

    await bot.sendMessage(notifyId, reply, sendOpts(md));
  } catch (err) {
    console.error('Daily briefing failed:', err);
  }
}

if (process.env.TELEGRAM_NOTIFY_CHAT_ID) {
  cron.schedule('0 4 * * *', sendDailyBriefing, { timezone: 'Etc/UTC' });
  console.log('Daily briefing scheduled for 04:00 UTC (08:00 Asia/Dubai)');
} else {
  console.log('Daily briefing disabled (set TELEGRAM_NOTIFY_CHAT_ID to enable).');
}

console.log('ClawdBot is running...');
