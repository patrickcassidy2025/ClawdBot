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
    '/project — daily summary of the Presight-AI GitHub project board',
    '/standup — generate a yesterday/today/blockers standup update',
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
            content {
              __typename
              ... on Issue {
                title number url state
                assignees(first: 10) { nodes { login } }
              }
              ... on PullRequest {
                title number url state
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
      items.push({
        title: content.title,
        type: content.__typename,
        number: content.number ?? null,
        url: content.url ?? null,
        state: content.state ?? null,
        assignees: content.assignees?.nodes?.map(a => a.login) || [],
        status: statusNode?.name || 'No status',
        priority,
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

bot.onText(/^\/project(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;

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

    const byStatus = items.reduce((acc, it) => {
      (acc[it.status] = acc[it.status] || []).push(it);
      return acc;
    }, {});

    const counts = Object.entries(byStatus)
      .map(([status, list]) => `${status}: ${list.length}`)
      .join(', ');

    const formatItem = (it) => {
      const ref = it.number ? `#${it.number} ` : '';
      const who = it.assignees.length ? ` — @${it.assignees.join(', @')}` : '';
      const pri = it.priority ? ` [priority: ${it.priority}]` : '';
      return `  - ${ref}${it.title}${who}${pri}`;
    };

    const detail = Object.entries(byStatus)
      .map(([status, list]) => {
        const lines = list.map(formatItem).join('\n');
        return `${status} (${list.length}):\n${lines}`;
      }).join('\n\n');

    const blockers = items.filter(isBlocker);
    const blockersSection = blockers.length
      ? blockers.map(formatItem).join('\n')
      : '(none)';

    const prompt = [
      `Today's date is ${new Date().toLocaleDateString('en-GB', {day: 'numeric', month: 'long', year: 'numeric'})}.`,
      `Write a concise daily summary for the GitHub project "${title}" (${url}).`,
      `Cover: total items by status, what's in progress (with owners), any blocked items that need attention, and notable completions.`,
      `An item counts as a blocker only if its priority is "Blocker" and its status is not Done/Won't do/Cancelled/Closed. Use the explicit Blockers list below as the source of truth — don't infer additional ones.`,
      `Keep it readable in Telegram — short paragraphs or grouped bullets, no markdown headings.`,
      ``,
      `Counts: ${counts}`,
      `Total items: ${items.length}`,
      ``,
      `Blockers (${blockers.length}):`,
      blockersSection,
      ``,
      `Items grouped by status:`,
      detail,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const reply = response.content.map(b => b.text ?? '').join('').trim();

    insertMessage.run(chatId, 'user', `[Project summary requested: ${org}/#${number}]`, Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('Project handler error:', err);
    await bot.sendMessage(chatId, `Couldn't fetch project board: ${err.message}`);
  }
});

bot.onText(/^\/standup(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  if (await rateLimited(chatId)) return;

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

    const inProgress = project ? project.items.filter(it => it.status === 'In Progress') : [];
    const blocked = project ? project.items.filter(isBlocker) : [];

    const formatPR = (p) =>
      `  - ${p.repo}#${p.number}${p.draft ? ' (draft)' : ''} ${p.title}`;
    const formatItem = (it) => {
      const ref = it.number ? `#${it.number} ` : '';
      const who = it.assignees.length ? ` (@${it.assignees.join(', @')})` : '';
      const pri = it.priority ? ` [priority: ${it.priority}]` : '';
      return `  - ${ref}${it.title}${who}${pri}`;
    };

    const prompt = [
      `Write a daily standup update for Patrick that can be pasted directly into Slack or Teams.`,
      `Use exactly these three sections, in this order, with the bold labels shown:`,
      `**Yesterday** — derive from PRs updated in the last 24 hours.`,
      `**Today** — derive from in-progress project board items and open PRs.`,
      `**Blockers** — list blocked project board items, or write "None" if there are none.`,
      `Tight bullets only. No preamble, no sign-off, no emoji, professional tone.`,
      ``,
      `=== PRs updated in the last 24 hours ===`,
      recentPRs.length ? recentPRs.map(formatPR).join('\n') : '(none)',
      ``,
      `=== All open PRs (context) ===`,
      allOpenPRs.length ? allOpenPRs.map(formatPR).join('\n') : '(none)',
      ``,
      `=== Project board: In Progress ===`,
      inProgress.length ? inProgress.map(formatItem).join('\n') : '(none)',
      ``,
      `=== Project board: Blocked ===`,
      blocked.length ? blocked.map(formatItem).join('\n') : '(none)',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const reply = response.content.map(b => b.text ?? '').join('').trim();

    insertMessage.run(chatId, 'user', '[Standup requested]', Date.now());
    insertMessage.run(chatId, 'assistant', reply, Date.now());

    for (const chunk of chunkMessage(reply)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('Standup handler error:', err);
    await bot.sendMessage(chatId, `Couldn't generate standup: ${err.message}`);
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
            .map(p => `  - #${p.number}${p.draft ? ' (draft)' : ''} ${p.title} — @${p.user}`)
            .join('\n');
          return `${repo}:\n${lines}`;
        }).join('\n\n')
      : '(no repos configured)';

    let projectSection = '(project board not configured)';
    if (project && project.items.length) {
      const byStatus = project.items.reduce((acc, it) => {
        (acc[it.status] = acc[it.status] || []).push(it);
        return acc;
      }, {});
      const counts = Object.entries(byStatus)
        .map(([status, list]) => `${status}: ${list.length}`)
        .join(', ');
      const formatItem = (it) => {
        const ref = it.number ? `#${it.number} ` : '';
        const who = it.assignees.length ? ` — @${it.assignees.join(', @')}` : '';
        const pri = it.priority ? ` [priority: ${it.priority}]` : '';
        return `  - ${ref}${it.title}${who}${pri}`;
      };
      const inProgress = (byStatus['In Progress'] || []).map(formatItem).join('\n') || '  (none)';
      const blocked = project.items.filter(isBlocker).map(formatItem).join('\n') || '  (none)';
      projectSection = [
        `${project.title} — ${project.items.length} items (${counts})`,
        `In Progress:`,
        inProgress,
        `Blocked:`,
        blocked,
      ].join('\n');
    } else if (project) {
      projectSection = `${project.title} — no items`;
    }

    const prompt = [
      `Write a friendly morning briefing for Patrick. Keep it warm but concise (8-14 short lines).`,
      `Cover, in this order:`,
      `1. Greeting`,
      `2. Open PRs across all repos — group by repo, call out anything notable`,
      `3. Project board status — totals by status, what's in progress, anything blocked that needs attention. An item counts as a blocker only if its priority is "Blocker" and its status is not Done/Won't do/Cancelled/Closed.`,
      `4. End with a small motivational nudge`,
      `No markdown headings. Plain text suitable for Telegram.`,
      ``,
      `Open PRs across ${prsByRepo.length} repo(s), ${totalPRs} total:`,
      prSummary,
      ``,
      `Project board:`,
      projectSection,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 900,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    await bot.sendMessage(notifyId, response.content[0].text);
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
