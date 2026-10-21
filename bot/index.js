/**
 * Agent Bot v2.0 — Telegram bot powered by Claude Code CLI
 * Міні-Марічка: AI-помічниця учениці курсу «Система з AI».
 * Based on the MIT-licensed Agent Factory bot template (see LICENSE).
 *
 * Features: text + voice + photos + documents + media groups → Claude Code → response
 *           sessions, DNA files, persistent keyboard, folder structure awareness
 *           stream mode, crash recovery, circuit breaker, confirmation buttons,
 *           thinking phrases rotation, URL pre-fetch, human-friendly errors,
 *           state persistence, feature flags, semantic memory, scheduler,
 *           model selection, bootstrap, auto-continue, text batching
 */

import { Bot, InlineKeyboard, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { spawn, execFile, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync, copyFileSync, statSync, createWriteStream, appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import https from "node:https";
import http from "node:http";

// Claude reauth (v4.7, портовано з agent-factory)
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthUrl,
  exchangeCodeForToken,
  OAUTH_SCOPES,
} from "./lib/claude-oauth.js";
import { safeEnvWrite, safeEnvRemove } from "./lib/env-write.js";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const WORKSPACE = join(AGENT_HOME, "workspace");
const PROJECTS = join(AGENT_HOME, "projects");
const DATA_DIR = join(AGENT_HOME, ".agent");
const MEDIA_DIR = join(WORKSPACE, ".media");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const OWNER_FILE = join(DATA_DIR, "owner.json");
const SYSTEM_PROMPT_PATH = join(WORKSPACE, "CLAUDE.md");
const CRASH_CONTEXT_FILE = join(DATA_DIR, ".crash_context.md");
const STATE_FILE = join(DATA_DIR, "state.json");
const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");
const MAX_SYSTEM_PROMPT_CHARS = 30000;
const STREAM_THROTTLE_MS = 1500;
const DEFAULT_TZ = process.env.DEFAULT_TZ || "Europe/Kyiv";
const BOT_VERSION = (() => {
  try { return readFileSync(join(import.meta.dirname, "VERSION"), "utf8").trim(); }
  catch { return "2.0.0"; }
})();

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

// Ensure directories exist
for (const dir of [DATA_DIR, join(WORKSPACE, "memory"), join(WORKSPACE, "knowledge"), PROJECTS, MEDIA_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── STATE PERSISTENCE ──────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // Migration: v1 state.json may lack bootstrapDone — check DNA files
    if (s.bootstrapDone === undefined) {
      const hasExistingFiles = existsSync(join(WORKSPACE, "SOUL.md")) ||
                               existsSync(join(WORKSPACE, "MEMORY.md"));
      s.bootstrapDone = hasExistingFiles;
      writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    }
    return s;
  } catch {
    // No state.json — check if this is an existing user (has DNA files)
    const hasExistingFiles = existsSync(join(WORKSPACE, "SOUL.md")) ||
                             existsSync(join(WORKSPACE, "MEMORY.md"));
    return {
      model: "sonnet",
      mode: "normal",
      timezone: DEFAULT_TZ,
      bootstrapDone: hasExistingFiles, // skip bootstrap for existing users
      dailySpendLimit: 50,
      costHistory: {},
      featureFlags: {},
    };
  }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

let state = loadState();

function isFeatureEnabled(flag) {
  return state.featureFlags?.[flag] === true;
}

// ─── SEMANTIC MEMORY (optional — dynamic import) ────────────────────────────

let _semanticMemory = null;

async function initSemanticMemory() {
  try {
    const { initDb, saveNow } = await import("./lib/db.js");
    const { startWatcher, reindexAll } = await import("./lib/memory-indexer.js");
    await initDb();
    startWatcher();
    reindexAll().catch((e) => console.warn("[semantic-memory] reindexAll error:", e.message));
    _semanticMemory = { initDb, saveNow };
    console.log("[semantic-memory] Initialized");
  } catch (e) {
    console.warn("[semantic-memory] Not available:", e.message);
    _semanticMemory = null;
  }
}

// ─── SCHEDULER ──────────────────────────────────────────────────────────────

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8"));
  } catch {
    return [];
  }
}

let _schedulerTimer = null;

function startScheduler() {
  if (_schedulerTimer) return;
  _schedulerTimer = setInterval(async () => {
    const schedules = loadSchedules();
    if (schedules.length === 0) return;

    const now = new Date();
    const tz = state.timezone || DEFAULT_TZ;
    const localStr = now.toLocaleString("en-US", { timeZone: tz });
    const local = new Date(localStr);
    const hour = local.getHours();
    const minute = local.getMinutes();
    const dow = local.getDay() === 0 ? 7 : local.getDay(); // 1=Mon..7=Sun

    for (const sched of schedules) {
      if (!sched.enabled) continue;

      let shouldFire = false;

      if (sched.type === "daily" && sched.hour === hour && (sched.minute || 0) === minute) {
        shouldFire = true;
      } else if (sched.type === "weekly" && sched.hour === hour && (sched.minute || 0) === minute && sched.weekdays?.includes(dow)) {
        shouldFire = true;
      } else if (sched.type === "once" && sched.at) {
        const fireAt = new Date(sched.at);
        if (now >= fireAt && now - fireAt < 90000) shouldFire = true; // within 90s window
      }

      if (!shouldFire) continue;

      // Dedup: skip if already fired this minute
      const fireKey = `${sched.id}_${hour}_${minute}`;
      if (sched._lastFire === fireKey) continue;
      sched._lastFire = fireKey;

      console.log(`[scheduler] Firing: ${sched.name} (${sched.type})`);

      try {
        if (sched.payload === "reminder" && sched.text) {
          if (_ownerId) {
            await bot.api.sendMessage(_ownerId, sched.text);
          }
        } else if (sched.payload === "task" && sched.prompt) {
          if (_ownerId) {
            const result = await callClaude(sched.prompt, null);
            await sendToOwner(result.text);
          }
        }
      } catch (e) {
        console.error(`[scheduler] Error in ${sched.name}:`, e.message);
      }

      // Delete once-type after firing
      if (sched.deleteAfterRun) {
        const all = loadSchedules();
        const filtered = all.filter((s) => s.id !== sched.id);
        writeFileSync(SCHEDULES_FILE, JSON.stringify(filtered, null, 2));
      }
    }
  }, 60000); // check every minute
  console.log("[scheduler] Started");
}

async function sendToOwner(text) {
  if (!_ownerId) return;
  const html = mdToTgHtml(text);
  const chunks = sendChunked(html);
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(_ownerId, chunk, { parse_mode: "HTML" });
    } catch {
      await bot.api.sendMessage(_ownerId, chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

// ─── OWNER CHECK (auto-lock to first user) ──────────────────────────────────

// Priority: OWNER_ID env var > owner.json file > auto-lock on first /start
let _ownerId = process.env.OWNER_ID || null;

function loadOwner() {
  if (_ownerId) return; // env var takes priority
  try {
    const data = JSON.parse(readFileSync(OWNER_FILE, "utf8"));
    _ownerId = String(data.id);
    console.log(`[owner] loaded from file: ${_ownerId} (${data.name || "unknown"})`);
  } catch {}
}

function saveOwner(ctx) {
  const data = {
    id: String(ctx.from.id),
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
    username: ctx.from.username || null,
    lockedAt: new Date().toISOString(),
  };
  _ownerId = data.id;
  writeFileSync(OWNER_FILE, JSON.stringify(data, null, 2));
  console.log(`[owner] auto-locked to: ${data.id} (${data.name})`);
}

loadOwner();

function isOwner(ctx) {
  if (!_ownerId) return false; // No owner yet — only /start can set it
  return String(ctx.from?.id) === String(_ownerId);
}

// ─── SPEND TRACKING ─────────────────────────────────────────────────────────

function recordSpend(cost) {
  if (!cost) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!state.costHistory) state.costHistory = {};
  state.costHistory[today] = (state.costHistory[today] || 0) + cost;
  saveState(state);
}

function getTodaySpend() {
  const today = new Date().toISOString().slice(0, 10);
  return state.costHistory?.[today] || 0;
}

function checkSpendLimit() {
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 50;
  if (spent >= limit) return "blocked";
  if (spent >= limit * 0.8) return "warning";
  return "ok";
}

// ─── SESSIONS ────────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(SESSIONS_FILE, "utf8"))));
  } catch {
    return new Map();
  }
}

function saveSessions() {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    console.error("[sessions] save error:", e.message);
  }
}

const sessions = loadSessions();

// ─── CIRCUIT BREAKER (rate limiting protection) ─────────────────────────────

let _rateLimitUntil = 0;

function setGlobalRateLimit(retryAfterSec) {
  _rateLimitUntil = Date.now() + (retryAfterSec || 5) * 1000;
  console.warn(`[rate-limit] breaker ON for ${retryAfterSec}s`);
}

function isGloballyRateLimited() {
  return Date.now() < _rateLimitUntil;
}

// ─── SYSTEM PROMPT (with mtime caching) ─────────────────────────────────────

function botName() {
  return state.botName || "Міні-Марічка";
}

function architectureContext() {
  const rid = state.ownerRid === "готовий" ? "чоловічому" : "жіночому";
  return `
## Хто ти

Ти ${botName()}, особиста AI-помічниця ${state.ownerName || "власниці"}. Говориш про себе в жіночому роді. До власниці звертайся на «ти», в ${rid} роді. Завжди спілкуйся українською, навіть якщо у файлах трапляється інша мова.
Коли пропонуєш план і чекаєш підтвердження, починай план зі слова «План:» і закінчуй запитанням «Робимо?».

## Де що лежить на сервері

/home/agent/
|-- .claude/agents/      <- помічники: Лея, Марко, Мія
|-- .claude/skills/      <- навички
|-- workspace/           <- робоча папка
|   |-- CLAUDE.md        <- правила роботи (оновлюються з шаблону, не правиш)
|   |-- pravyla.md       <- правила власниці («роби завжди так»), правиш ти
|   |-- SOUL.md, MEMORY.md, GOALS.md, memory/
|   |-- kontekst/        <- копія сторінок «Контекст» з Notion (щоночі і перед роботою команди)
|   |-- karuseli/        <- каруселі Марка
|   +-- .media/          <- фото й файли з Telegram
|-- bin/                 <- скрипти (kontekst.sh, karusel.py, onovyty.sh)
+-- .agent/              <- службова папка бота (не чіпай)
`;
}

const MAX_MEMORY_CHARS = 15000;
const MAX_DIARY_CHARS = 2000;

// Cache for system prompt file
let _sysPromptCache = { mtime: 0, content: "" };

function _safeRead(path) {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch { return ""; }
}

function _cachedRead(path) {
  try {
    const stat = statSync(path);
    const mtime = stat.mtimeMs;
    if (mtime === _sysPromptCache.mtime) return _sysPromptCache.content;
    const content = readFileSync(path, "utf8");
    _sysPromptCache = { mtime, content };
    return content;
  } catch { return ""; }
}

function buildSystemPrompt() {
  const parts = [];

  // 1. CLAUDE.md is auto-loaded by Claude Code CLI from cwd (WORKSPACE)
  //    We do NOT inject it here to avoid double-loading and wasting tokens.
  //    Only inject what Claude CLI doesn't see: DNA files, diaries, architecture.

  // 2. Architecture context
  parts.push(architectureContext());

  // 3. All DNA files (skip CLAUDE.md — already loaded)
  const dnaFiles = ["SOUL.md", "MEMORY.md", "GOALS.md"];
  for (const name of dnaFiles) {
    const text = _safeRead(join(WORKSPACE, name));
    if (text) {
      const trimmed = name === "MEMORY.md" && text.length > MAX_MEMORY_CHARS
        ? text.slice(0, MAX_MEMORY_CHARS) + "\n...(truncated)"
        : text;
      parts.push(`--- ${name} ---\n${trimmed}`);
    }
  }

  // 4. Today's diary (last N chars — newest data)
  const today = new Date().toISOString().split("T")[0];
  const todayText = _safeRead(join(WORKSPACE, "memory", `${today}.md`));
  if (todayText) {
    const d = todayText.length > MAX_DIARY_CHARS ? todayText.slice(-MAX_DIARY_CHARS) : todayText;
    parts.push(`--- Щоденник ${today} ---\n${d}`);
  }

  // 5. Yesterday's diary
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().split("T")[0];
  const yText = _safeRead(join(WORKSPACE, "memory", `${yStr}.md`));
  if (yText) {
    const d = yText.length > MAX_DIARY_CHARS ? yText.slice(-MAX_DIARY_CHARS) : yText;
    parts.push(`--- Щоденник ${yStr} ---\n${d}`);
  }

  // 6. Crash context (if previous session crashed)
  if (existsSync(CRASH_CONTEXT_FILE)) {
    try {
      const ctx = readFileSync(CRASH_CONTEXT_FILE, "utf8");
      parts.push(`--- Контекст: попередня сесія завершилася помилкою ---\n${ctx}`);
      unlinkSync(CRASH_CONTEXT_FILE);
      console.log("[crash-recovery] injected crash context");
    } catch {}
  }

  // 7. Current date + memory nudge
  parts.push(`# Current date\n${today}`);
  parts.push("# Memory reminder\nЯкщо в цьому діалозі з'явилися важливі факти, рішення чи вподобання власниці, збережи їх у memory/YYYY-MM-DD.md або MEMORY.md. Не втрачай контекст між сесіями.");

  // Trim to max
  let result = parts.join("\n\n");
  if (result.length > MAX_SYSTEM_PROMPT_CHARS) {
    result = result.slice(0, MAX_SYSTEM_PROMPT_CHARS);
  }
  return result;
}

// ─── STATUS MESSAGE (typing animation) ──────────────────────────────────────

const THINKING_PHRASES = [
  ["Думаю…", "⏳"],
  ["Думаю…", "⌛️"],
  ["Метикую…", "🤔"],
  ["Розмірковую…", "🧠"],
  ["Формулюю…", "🧐"],
  ["Складаю текст…", "📝"],
  ["Ухвалюю рішення…", "⚡️"],
  ["Готую план…", "📋"],
  ["Аналізую…", "🔍"],
  ["Обробляю…", "⚙️"],
];

function formatThinkingPhrase(index, elapsedSec) {
  const [text, emoji] = THINKING_PHRASES[index % THINKING_PHRASES.length];
  const timer = elapsedSec >= 2 ? ` ${elapsedSec}с` : "";
  return `${text} ${emoji}${timer}`;
}

class StatusMessage {
  constructor(ctx, messageId) {
    this.ctx = ctx;
    this.chatId = ctx.chat.id;
    this.messageId = messageId;
    this.phraseIndex = 0;
    this.startTime = Date.now();
    this.typingInterval = null;
    this.animationInterval = null;
    this.stopped = false;
    this.streamingText = "";
    this.rateLimitedUntil = 0;
  }

  _activateBreaker(retryAfterSec) {
    this.rateLimitedUntil = Date.now() + (retryAfterSec * 1000) + 2000;
    setGlobalRateLimit(retryAfterSec);
  }

  _isBreakerActive() {
    return Date.now() < this.rateLimitedUntil || isGloballyRateLimited();
  }

  start() {
    this.typingInterval = setInterval(async () => {
      if (this.stopped || this._isBreakerActive()) return;
      try {
        await this.ctx.api.sendChatAction(this.chatId, "typing");
      } catch (e) {
        if (e?.error_code === 429) {
          this._activateBreaker(e?.parameters?.retry_after || 30);
        }
      }
    }, 4000);

    this.animationInterval = setInterval(async () => {
      if (this.stopped || this.streamingText || this._isBreakerActive()) return;
      this.phraseIndex = (this.phraseIndex + 1) % THINKING_PHRASES.length;
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      try {
        await this.ctx.api.editMessageText(
          this.chatId, this.messageId,
          formatThinkingPhrase(this.phraseIndex, elapsed)
        );
      } catch (e) {
        if (e?.error_code === 429) {
          this._activateBreaker(e?.parameters?.retry_after || 30);
        }
      }
    }, 2000);

    this.ctx.api.sendChatAction(this.chatId, "typing").catch(() => {});
  }

  async updateStreaming(text) {
    if (this.stopped) return;
    this.streamingText = text;
    if (this._isBreakerActive()) return;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const display = text.length > 3500 ? "…" + text.slice(-3500) : text;
    const indicator = `\n\n⏳ ${elapsed}с`;
    try {
      await this.ctx.api.editMessageText(this.chatId, this.messageId, display + indicator);
    } catch (e) {
      if (e?.error_code === 429) {
        this._activateBreaker(e?.parameters?.retry_after || 30);
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.typingInterval) clearInterval(this.typingInterval);
    if (this.animationInterval) clearInterval(this.animationInterval);
    this.typingInterval = null;
    this.animationInterval = null;
  }
}

let _activeStatus = null;

// ─── HUMAN-FRIENDLY ERRORS ──────────────────────────────────────────────────

function humanizeError(errMsg) {
  const msg = String(errMsg);
  if (msg.includes("429") || msg.includes("rate")) return "Забагато запитів. Зачекай хвилинку й спробуй знову.";
  if (msg.includes("529") || msg.includes("503") || msg.includes("overloaded")) return "Сервери Claude перевантажені. Спробуй за кілька хвилин.";
  if (msg.includes("401") || msg.includes("auth")) return "Проблема з авторизацією Claude. Потрібно авторизуватися заново (claude auth login).";
  if (msg.includes("image") || msg.includes("Could not process")) return "Не вдалося обробити файл. Спробуй надіслати в іншому форматі.";
  if (msg.includes("timeout") || msg.includes("TIMEOUT")) return "Claude думав надто довго. Спробуй поставити коротше запитання.";
  if (msg.includes("session") || msg.includes("corrupt")) return "Сесію пошкоджено. Натисни 🔄 Новий діалог.";
  return null; // unknown error — show generic message
}

// ─── URL PRE-FETCH (with Google Docs/Sheets support) ────────────────────────

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const GDOCS_RE = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
const GSHEETS_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

function httpGet(url, maxLen = 50000) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, maxLen).then(resolve);
      }
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; if (data.length > maxLen) { res.destroy(); resolve(data.slice(0, maxLen)); } });
      res.on("end", () => resolve(data));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function prefetchUrls(text) {
  const urls = text.match(URL_RE);
  if (!urls || urls.length === 0) return "";

  const fetched = [];
  for (const url of urls.slice(0, 3)) {
    try {
      let content = null;
      let source = url;

      // Google Docs -> export as HTML
      const gdocMatch = url.match(GDOCS_RE);
      if (gdocMatch) {
        const docId = gdocMatch[1];
        content = await httpGet(`https://docs.google.com/document/d/${docId}/export?format=html`);
        if (content) {
          content = stripHtml(content);
          source = `Google Doc (${docId})`;
        }
      }

      // Google Sheets -> export as CSV
      const gsheetMatch = url.match(GSHEETS_RE);
      if (gsheetMatch && !content) {
        const sheetId = gsheetMatch[1];
        content = await httpGet(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`);
        source = `Google Sheet (${sheetId})`;
      }

      // Regular URL
      if (!content) {
        const raw = await httpGet(url, 10000);
        if (raw) content = stripHtml(raw);
      }

      if (content && content.length > 100) {
        fetched.push({ url, source, content: content.slice(0, 30000) });
      }
    } catch (e) {
      console.error(`[prefetch] Error fetching ${url}:`, e.message);
    }
  }

  if (fetched.length === 0) return "";
  return "\n\n" + fetched.map(f =>
    `--- Вміст ${f.source} (${f.url}) ---\n${f.content}\n--- Кінець документа ---`
  ).join("\n\n");
}

// ─── CLAUDE CODE CLI ─────────────────────────────────────────────────────────

// Sequential queue — only one Claude call at a time
let _queue = Promise.resolve();
let _activeChild = null; // Track running Claude process for /stop
// _activeStatus is declared above with StatusMessage class

function isCliBusy() {
  return _activeChild !== null;
}

function callClaude(prompt, sessionId, { onText } = {}) {
  const p = _queue.then(() => {
    const started = Date.now();
    return _callClaudeInner(prompt, sessionId, { onText }).then((r) => ({
      ...r,
      helpers: r.sessionId ? helpersUsed(r.sessionId, started - 2000) : [],
    }));
  });
  _queue = p.catch(() => {});
  return p;
}

// Яких помічників Марічка залучала в цій відповіді: з журналу сесії Claude
// (виклики Agent із subagent_type, записані після початку запиту). Потрібно,
// щоб відповідь помічника йшла в його тему, навіть якщо Марічка забула позначку ===…===.
function helpersUsed(sessionId, sinceMs) {
  try {
    const dir = WORKSPACE.replace(/[\/.]/g, "-");
    const f = join(AGENT_HOME, ".claude", "projects", dir, sessionId + ".jsonl");
    const out = new Set();
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.includes("subagent_type")) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (Date.parse(o.timestamp || 0) < sinceMs) continue;
      for (const b of o.message?.content || []) {
        if (b.type === "tool_use" && b.input?.subagent_type) out.add(b.input.subagent_type);
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

function _getSessionSize(sessionId) {
  // Kept for diagnostics only — no longer used to kill sessions.
  // autocompact (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90") manages context natively.
  if (!sessionId) return 0;
  try {
    const sessDir = join(AGENT_HOME, ".claude", "sessions");
    const sessFile = join(sessDir, sessionId + ".jsonl");
    if (existsSync(sessFile)) return statSync(sessFile).size;
  } catch {}
  return 0;
}

function _callClaudeInner(prompt, sessionId, { onText } = {}) {
  return new Promise((resolve, reject) => {

    const useStream = typeof onText === "function";
    const args = [
      "-p", prompt,
      "--output-format", useStream ? "stream-json" : "json",
      "--max-turns", "40",
      "--model", getCurrentModel(),
      "--dangerously-skip-permissions",
    ];

    const systemPrompt = buildSystemPrompt();
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

    if (sessionId) args.push("--resume", sessionId);

    const child = spawn("claude", args, {
      cwd: WORKSPACE,
      env: { ...process.env, HOME: AGENT_HOME },
      timeout: 600000, // 10 min
    });
    _activeChild = child;
    child.on("close", () => { if (_activeChild === child) _activeChild = null; });
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let lastText = "";
    let lastStreamTs = 0;
    let resultSessionId = sessionId;
    let cost = 0;
    let hitMaxTurns = false;
    const STOPPED_TEXT = "⚠️ Задача виявилась довгою, і я зупинилась посередині (ліміт кроків на одне повідомлення). Частину вже зроблено. Напиши «продовжуй», і доведу до кінця.";

    child.stdout.on("data", (d) => {
      stdout += d;

      if (useStream) {
        // Parse JSONL lines for streaming
        const lines = stdout.split("\n");
        stdout = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "text" && block.text) {
                  lastText = block.text;
                  const now = Date.now();
                  if (now - lastStreamTs >= STREAM_THROTTLE_MS) {
                    lastStreamTs = now;
                    onText(lastText);
                  }
                }
              }
            } else if (obj.type === "result") {
              resultSessionId = obj.session_id || sessionId;
              cost = obj.cost_usd || 0;
              if (obj.subtype === "error_max_turns") hitMaxTurns = true;
              if (obj.result) lastText = obj.result;
            }
          } catch {}
        }
      }
    });

    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      if (useStream) {
        // Parse any remaining line
        if (stdout.trim()) {
          try {
            const obj = JSON.parse(stdout);
            if (obj.type === "result") {
              resultSessionId = obj.session_id || sessionId;
              cost = obj.cost_usd || 0;
              if (obj.subtype === "error_max_turns") hitMaxTurns = true;
              if (obj.result) lastText = obj.result;
            }
          } catch {}
        }
        recordSpend(cost);
        if (hitMaxTurns) lastText = (lastText ? lastText + "\n\n" : "") + STOPPED_TEXT;
        resolve({
          text: lastText || "⚠️ Відповідь вийшла порожня. Напиши «продовжуй» або повтори питання.",
          sessionId: resultSessionId,
          cost,
        });
        return;
      }

      // Non-stream JSON mode
      if (code !== 0 && !stdout.trim()) {
        // Save crash context for recovery
        try {
          writeFileSync(CRASH_CONTEXT_FILE,
            `Останній запит (${new Date().toISOString()}):\n${prompt.slice(0, 500)}\n\nПомилка: exit ${code}\n${stderr.slice(0, 300)}`);
        } catch {}
        return reject(new Error(`Claude exit ${code}: ${stderr.slice(0, 300)}`));
      }
      try {
        const result = JSON.parse(stdout);
        const rcost = result.cost_usd || 0;
        recordSpend(rcost);
        resolve({
          text: result.result || result.text || (result.subtype === "error_max_turns" ? STOPPED_TEXT : "⚠️ Відповідь вийшла порожня. Напиши «продовжуй» або повтори питання."),
          sessionId: result.session_id || sessionId,
          cost: rcost,
        });
      } catch {
        const text = stdout.trim();
        resolve({ text: text || "(порожня відповідь)", sessionId, cost: 0 });
      }
    });

    child.on("error", (err) => {
      // Save crash context
      try {
        writeFileSync(CRASH_CONTEXT_FILE,
          `Останній запит (${new Date().toISOString()}):\n${prompt.slice(0, 500)}\n\nПомилка: ${err.message}`);
      } catch {}
      reject(err);
    });
  });
}

// ─── FILE DOWNLOAD ──────────────────────────────────────────────────────────

async function downloadTgFile(url, destPath) {
  const proto = url.startsWith("https") ? https : http;
  const response = await new Promise((resolve, reject) => {
    proto.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      resolve(res);
    }).on("error", reject);
  });
  await pipeline(response, createWriteStream(destPath));
}

async function downloadAndSave(ctx, fileId, ext) {
  const file = await ctx.api.getFile(fileId);
  const tmpPath = `/tmp/media_${Date.now()}_${fileId.slice(-8)}${ext}`;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  await downloadTgFile(fileUrl, tmpPath);

  // Move to persistent .media/ directory (copyFile+unlink for cross-filesystem safety)
  const destPath = join(MEDIA_DIR, `${Date.now()}_${fileId.slice(-8)}${ext}`);
  try {
    renameSync(tmpPath, destPath);
  } catch {
    copyFileSync(tmpPath, destPath);
    unlinkSync(tmpPath);
  }
  return destPath;
}

// ─── MEDIA BATCH (for handling multiple photos at once) ─────────────────────

const MEDIA_BATCH_DELAY_MS = 2500;
const mediaBatch = new Map(); // chatId -> { items, caption, ctx, timer, statusMsgId }

async function enqueueMedia(ctx, item) {
  if (!isOwner(ctx)) return;
  const key = `${ctx.chat.id}:${ctx.msg?.message_thread_id || 0}`;
  let batch = mediaBatch.get(key);

  if (batch) {
    // Add to existing batch, restart timer
    batch.items.push(item);
    if (item.caption && !batch.caption) batch.caption = item.caption;
    batch.ctx = ctx;
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => processMediaBatch(key), MEDIA_BATCH_DELAY_MS);
    try {
      await ctx.api.editMessageText(ctx.chat.id, batch.statusMsgId,
        `Приймаю файли... (${batch.items.length} шт.) ⏳`);
    } catch {}
    return;
  }

  // First item — create new batch
  const statusMsg = await ctx.reply(`Приймаю файл... ⏳`);
  batch = {
    items: [item],
    caption: item.caption || null,
    chatId: ctx.chat.id,
    userId: String(ctx.from.id),
    statusMsgId: statusMsg.message_id,
    ctx,
    timer: null,
  };
  batch.timer = setTimeout(() => processMediaBatch(key), MEDIA_BATCH_DELAY_MS);
  mediaBatch.set(key, batch);
}

async function processMediaBatch(key) {
  const batch = mediaBatch.get(key);
  if (!batch) return;
  mediaBatch.delete(key);
  clearTimeout(batch.timer);

  const { ctx, items, userId, chatId, statusMsgId } = batch;

  try {
    await ctx.api.editMessageText(chatId, statusMsgId,
      `Завантажую ${items.length === 1 ? "файл" : items.length + " файлів"}... ⏳`);
  } catch {}

  // Download all files
  const downloaded = [];
  for (const it of items) {
    try {
      const path = await downloadAndSave(ctx, it.fileId, it.ext);
      downloaded.push({ ...it, path });
      console.log(`[media] ${userId} saved ${it.kind} -> ${path}`);
    } catch (e) {
      console.warn(`[media] download failed for ${it.kind}: ${e.message}`);
    }
  }

  if (downloaded.length === 0) {
    try {
      await ctx.api.editMessageText(chatId, statusMsgId, "Не вдалося завантажити файли. Спробуй ще раз.");
    } catch {}
    return;
  }

  // Build prompt with file paths
  const filesBlock = downloaded
    .map((d) => {
      const label = d.kind === "photo" ? "Фото" : d.kind === "video" ? "Відео" : `Файл (${d.fileName || d.ext})`;
      return `${label}: ${d.path}`;
    })
    .join("\n");

  const mediaIntro = downloaded.length === 1
    ? "Користувач надіслав медіа. Файл збережено, відкрий через Read:"
    : `Користувач надіслав ${downloaded.length} медіа. Файли збережено, відкрий через Read:`;

  const caption = batch.caption || "";
  const prompt = routePrompt(ctx, `${mediaIntro}\n${filesBlock}${caption ? `\n\nПідпис користувача: ${caption}` : ""}`);

  const status = new StatusMessage(ctx, statusMsgId);
  _activeStatus = status;
  status.start();

  try {
    const sKey = sessionKey(ctx);
    const sessionId = sessions.get(sKey) || null;
    const result = await callClaude(prompt, sessionId);

    if (result.sessionId) {
      sessions.set(sKey, result.sessionId);
      saveSessions();
    }

    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await deliverResponse(ctx, result.text, result.helpers);
  } catch (err) {
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.error("[media-error]", err.message);
    const friendly = humanizeError(err.message);
    await ctx.reply(friendly || "Помилка обробки медіа. Спробуй ще раз або натисни 🔄 Новий діалог.");
  }
}

// ─── MARKDOWN → TELEGRAM HTML ────────────────────────────────────────────────

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mdToTgHtml(text) {
  if (!text) return "";
  let result = text;

  // Code blocks: ```lang\n...\n``` → <pre>...</pre>
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    return `<pre>${escapeHtml(code.trim())}</pre>`;
  });

  // Inline code: `...` → <code>...</code>
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<i>$1</i>");

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headings: remove # prefix, make bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  return result;
}

// ─── MEDIA TAGS (Claude → Telegram file sending) ────────────────────────────

const MEDIA_TAG_RE = /\[(ФОТО|ФАЙЛ|СТІКЕР|ВІДЕО|АУДІО|ГОЛОС|GIF|PHOTO|FILE|STICKER|VIDEO|AUDIO|VOICE|ANIMATION):\s*([^\]\s]+)(?:\s+([^\]]*))?\]/gi;

const MEDIA_TYPE_MAP = {
  "ФОТО": "photo", "PHOTO": "photo",
  "ФАЙЛ": "document", "FILE": "document",
  "СТІКЕР": "sticker", "STICKER": "sticker",
  "ВІДЕО": "video", "VIDEO": "video",
  "АУДІО": "audio", "AUDIO": "audio",
  "ГОЛОС": "voice", "VOICE": "voice",
  "GIF": "animation", "ANIMATION": "animation",
};

function extractMediaTags(text) {
  const media = [];
  const cleaned = text.replace(MEDIA_TAG_RE, (_, type, path, caption) => {
    let filePath = path.trim();
    let fileCaption = caption?.trim()?.slice(0, 1024) || undefined;

    if (!filePath.startsWith("http") && !existsSync(filePath) && fileCaption) {
      const fullPath = (filePath + " " + fileCaption).replace(/\s+$/, "");
      if (existsSync(fullPath)) {
        filePath = fullPath;
        fileCaption = undefined;
      }
    }

    media.push({
      type: MEDIA_TYPE_MAP[type.toUpperCase()] || "document",
      path: filePath,
      caption: fileCaption,
    });
    return "";
  });
  return { cleaned: cleaned.trim(), media };
}

const MEDIA_METHOD = {
  photo: "Photo", document: "Document", voice: "Voice", video: "Video",
  audio: "Audio", animation: "Animation", sticker: "Sticker",
};

// Кілька фото підряд (наприклад, слайди каруселі) — одним альбомом по 10; решта — по одному
async function sendMediaList(ctx, media, target = null) {
  const photos = media.filter((m) => m.type === "photo" && !/^https?:/i.test(m.path) && existsSync(m.path));
  if (photos.length < 2) { for (const item of media) await sendMediaItem(ctx, item, target); return; }
  const chatId = target ? target.chatId : ctx.chat.id;
  const threadId = target ? target.threadId : ctx.msg?.message_thread_id;
  const extra = threadId ? { message_thread_id: threadId } : {};
  for (let i = 0; i < photos.length; i += 10) {
    const group = [];
    for (const [j, m] of photos.slice(i, i + 10).entries()) {
      const buf = await readFile(m.path);
      group.push({ type: "photo", media: new InputFile(buf, basename(m.path)), ...(j === 0 && m.caption ? { caption: m.caption } : {}) });
    }
    try { await bot.api.sendMediaGroup(chatId, group, extra); }
    catch (e) {
      console.error("[media] album failed, sending one by one:", e.message);
      for (const m of photos.slice(i, i + 10)) await sendMediaItem(ctx, m, target);
    }
  }
  for (const item of media.filter((m) => !photos.includes(m))) await sendMediaItem(ctx, item, target);
}

async function sendMediaItem(ctx, item, target = null) {
  const threadOpts = target?.threadId ? { message_thread_id: target.threadId } : {};
  const say = (msg) => target
    ? bot.api.sendMessage(target.chatId, msg, threadOpts)
    : ctx.reply(msg);
  try {
    const isUrl = /^https?:\/\//i.test(item.path);
    let source;
    if (isUrl) {
      source = item.path;
    } else if (existsSync(item.path)) {
      const buf = await readFile(item.path);
      source = new InputFile(buf, basename(item.path));
    } else {
      await say(`Файл не знайдено: ${item.path}`);
      return;
    }
    const opts = {};
    if (item.caption && item.type !== "sticker") opts.caption = item.caption;

    const kind = MEDIA_METHOD[item.type] || "Document";
    if (target) {
      await bot.api[`send${kind}`](target.chatId, source, { ...opts, ...threadOpts });
    } else {
      await ctx[`replyWith${kind}`](source, opts);
    }
  } catch (e) {
    console.error(`[media] Failed to send ${item.type} ${item.path}:`, e.message);
    await say(`Не вдалося надіслати: ${basename(item.path)}`).catch(() => {});
  }
}

// ─── CONFIRMATION BUTTONS ───────────────────────────────────────────────────

function needsConfirmation(text) {
  const lower = text.toLowerCase();
  return /робимо\s*\?|план:|✔\s*(або|чи|\/)\s*✖/i.test(lower);
}

function confirmKeyboard() {
  return new InlineKeyboard()
    .text("✔ Продовжуй", "confirm_continue")
    .text("✖ Стоп", "confirm_stop");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getStatusText() {
  const dnaFiles = ["SOUL.md", "MEMORY.md", "GOALS.md"];
  const found = dnaFiles.filter((f) => existsSync(join(WORKSPACE, f)));
  const missing = dnaFiles.filter((f) => !existsSync(join(WORKSPACE, f)));

  let projectsList = "порожньо";
  try {
    const dirs = readdirSync(PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (dirs.length > 0) projectsList = dirs.join(", ");
  } catch {}

  // Count media files
  let mediaCount = 0;
  try {
    mediaCount = readdirSync(MEDIA_DIR).length;
  } catch {}

  // Count skills
  let skillCount = 0;
  try {
    const skillDir = join(AGENT_HOME, ".claude", "skills");
    if (existsSync(skillDir)) {
      skillCount = readdirSync(skillDir, { withFileTypes: true }).filter(d => d.isDirectory()).length;
    }
  } catch {}

  const today = new Date().toISOString().split("T")[0];
  const hasDiary = existsSync(join(WORKSPACE, "memory", `${today}.md`));

  return (
    `📋 Статус агента\n\n` +
    `DNA-файли: ${found.length}/${dnaFiles.length} (${found.join(", ")})\n` +
    `${missing.length > 0 ? `Не знайдено: ${missing.join(", ")}\n` : ""}` +
    `Щоденник сьогодні: ${hasDiary ? "є" : "немає"}\n` +
    `Медіафайлів: ${mediaCount}\n` +
    `Скілів: ${skillCount}\n` +
    `Проєкти: ${projectsList}\n\n` +
    `Workspace: ${WORKSPACE}\n` +
    `Проєкти: ${PROJECTS}`
  );
}

function getProjectsText() {
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {}

  if (dirs.length === 0) {
    return (
      `📁 Проєкти\n\n` +
      `Папка проєктів поки порожня.\n` +
      `Шлях: ${PROJECTS}\n\n` +
      `Попроси мене створити проєкт, і я створю його тут.`
    );
  }

  return (
    `📁 Проєкти (${dirs.length})\n\n` +
    dirs.map((d) => `- ${d}`).join("\n") +
    `\n\nШлях: ${PROJECTS}`
  );
}

function getMemoryText() {
  const memoryDir = join(WORKSPACE, "memory");
  let files = [];
  try {
    files = readdirSync(memoryDir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort()
      .reverse()
      .slice(0, 7);
  } catch {}

  const memoryExists = existsSync(join(WORKSPACE, "MEMORY.md"));
  let memorySize = 0;
  if (memoryExists) {
    try {
      memorySize = readFileSync(join(WORKSPACE, "MEMORY.md"), "utf8").split("\n").length;
    } catch {}
  }

  return (
    `🧠 Пам'ять\n\n` +
    `MEMORY.md: ${memoryExists ? `${memorySize} рядків` : "не знайдено"}\n\n` +
    `Останні щоденники:\n` +
    (files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "порожньо") +
    `\n\nШлях: ${WORKSPACE}/memory/`
  );
}

// ─── SEND RESPONSE ──────────────────────────────────────────────────────────

const CHUNK_SOFT_LIMIT = 1800;
const CHUNK_HARD_LIMIT = 4000;

function sendChunked(html) {
  const chunks = [];
  const paragraphs = html.split("\n\n");
  let current = "";

  for (const para of paragraphs) {
    if (para.length > CHUNK_HARD_LIMIT) {
      // Split oversized paragraph by lines
      if (current) { chunks.push(current); current = ""; }
      const lines = para.split("\n");
      for (const line of lines) {
        let rest = line;
        while (rest.length > CHUNK_HARD_LIMIT) {
          if (current) { chunks.push(current); current = ""; }
          chunks.push(rest.slice(0, CHUNK_HARD_LIMIT));
          rest = rest.slice(CHUNK_HARD_LIMIT);
        }
        if (current.length + rest.length + 1 > CHUNK_HARD_LIMIT) {
          if (current) chunks.push(current);
          current = rest;
        } else {
          current = current ? current + "\n" + rest : rest;
        }
      }
    } else if (current.length + para.length + 2 > CHUNK_SOFT_LIMIT && current) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendResponse(ctx, text) {
  // Extract media tags before formatting
  const { cleaned, media } = extractMediaTags(text);
  const html = mdToTgHtml(cleaned);

  // Check if response needs confirmation buttons
  const hasConfirmation = needsConfirmation(cleaned);

  if (!cleaned.trim()) {
    // Відповідь — самі картинки (альбом слайдів без тексту): порожній текст Telegram не приймає
  } else if (html.length <= CHUNK_HARD_LIMIT) {
    const replyOpts = {
      parse_mode: "HTML",
      ...(hasConfirmation ? { reply_markup: confirmKeyboard() } : {}),
    };
    try {
      await ctx.reply(html, replyOpts);
    } catch {
      // Fallback: if HTML parsing fails, send as plain text
      await ctx.reply(cleaned);
    }
  } else {
    const chunks = sendChunked(html);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const markup = (isLast && hasConfirmation)
        ? { reply_markup: confirmKeyboard() }
        : {};
      try {
        await ctx.reply(chunks[i], { parse_mode: "HTML", ...markup });
      } catch {
        await ctx.reply(chunks[i].replace(/<[^>]+>/g, ""), markup);
      }
    }
  }

  // Send media files after text (кілька фото — альбомом)
  await sendMediaList(ctx, media);
}

// ─── BOOTSTRAP (знайомство на першому /start) ──────────────────────────────
// Три питання → SOUL.md, MEMORY.md, GOALS.md, pravyla.md з шаблонів bot/dna/.
// Усе інше про людину бот бере з її «Контексту» в Notion.

const bootstrapStep = new Map(); // userId -> step name
const bootstrapData = new Map(); // userId -> { name, rid, bot }
const DNA_DIR = join(import.meta.dirname, "dna");

const BOOTSTRAP_STEPS = {
  ask_name: { question: "Як тебе звати?", field: "name", next: "ask_rid" },
  ask_rid: { question: "Як до тебе звертатися: «готова» чи «готовий»? Напиши одне слово.", field: "rid", next: "ask_bot" },
  ask_bot: { question: "А як назвемо мене? Напиши ім'я. Наприклад, Марічка.", field: "bot", next: "confirm" },
};

function normalizeRid(text) {
  return /вий|ий\b|male|чолов/i.test(text) ? "готовий" : "готова";
}

async function handleBootstrap(ctx, text) {
  const userId = String(ctx.from.id);
  const step = bootstrapStep.get(userId);
  if (!step) return false;

  const stepConfig = BOOTSTRAP_STEPS[step];
  if (stepConfig) {
    const data = bootstrapData.get(userId) || {};
    data[stepConfig.field] = stepConfig.field === "rid" ? normalizeRid(text) : text.trim().slice(0, 60);
    bootstrapData.set(userId, data);

    if (stepConfig.next === "confirm") {
      const kb = new InlineKeyboard()
        .text("✔ Так", "bootstrap_confirm")
        .text("✖ Спочатку", "bootstrap_restart");
      await ctx.reply(
        `Перевір:\n\nТи: ${data.name} (${data.rid})\nЯ: ${data.bot}\n\nУсе так?`,
        { reply_markup: kb }
      );
      bootstrapStep.set(userId, "confirm");
    } else {
      bootstrapStep.set(userId, stepConfig.next);
      await ctx.reply(BOOTSTRAP_STEPS[stepConfig.next].question);
    }
    return true;
  }

  if (step === "confirm") {
    await ctx.reply("Натисни кнопку вище: ✔ або ✖");
    return true;
  }
  return false;
}

function fillTemplate(text, data) {
  return text
    .replaceAll("{{NAME}}", data.name)
    .replaceAll("{{BOT}}", data.bot)
    .replaceAll("{{RID}}", data.rid)
    .replaceAll("{{DATE}}", new Date().toISOString().slice(0, 10));
}

function writeDNAFiles(data) {
  // Пишемо тільки відсутні файли: наявну пам'ять не затираємо
  for (const name of ["SOUL.md", "MEMORY.md", "GOALS.md", "pravyla.md"]) {
    const dest = join(WORKSPACE, name);
    const src = join(DNA_DIR, name);
    if (!existsSync(dest) && existsSync(src)) {
      writeFileSync(dest, fillTemplate(readFileSync(src, "utf8"), data));
    }
  }
}

function claudeLoggedIn() {
  return existsSync(CREDENTIALS_FILE) ||
    !!process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN ||
    !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

function nextStepsText() {
  return (
    "Що далі:\n\n" +
    "1. Створи в Telegram групу (можна назвати «Моя система»), додай туди мене.\n" +
    "2. У налаштуваннях групи увімкни «Теми».\n" +
    "3. Зроби мене адміністратором з правом «Керування темами».\n" +
    "4. Напиши в групі /setup, і я створю теми для Леї і Марка.\n\n" +
    "А поки можна писати мені й тут."
  );
}

// ─── TEXT BATCHING (collect multiple messages before sending) ────────────────

const TEXT_BATCH_DELAY_MS = 1500;
const textBatch = new Map(); // userId -> { texts[], timer, ctx }

function enqueueText(ctx, text) {
  const userId = `${ctx.chat.id}:${ctx.msg?.message_thread_id || 0}`; // batch key: chat + topic
  let batch = textBatch.get(userId);

  if (batch) {
    batch.texts.push(text);
    batch.ctx = ctx;
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => processTextBatch(userId), TEXT_BATCH_DELAY_MS);
    return;
  }

  batch = {
    texts: [text],
    ctx,
    timer: setTimeout(() => processTextBatch(userId), TEXT_BATCH_DELAY_MS),
  };
  textBatch.set(userId, batch);
}

async function processTextBatch(userId) {
  const batch = textBatch.get(userId);
  if (!batch) return;
  textBatch.delete(userId);
  clearTimeout(batch.timer);

  const { ctx, texts } = batch;
  const combined = texts.join("\n\n");

  await handleTextMessage(ctx, combined);
}

// ─── MODEL SELECTION ────────────────────────────────────────────────────────

function getCurrentModel() {
  return state.model || "sonnet";
}

// ─── SETTINGS MENU (AF-compatible) ─────────────────────────────────────────

function settingsKeyboard() {
  const modelEmoji = state.model === "opus" ? "🟣" : state.model === "haiku" ? "🟢" : "🔵";
  const modeEmoji = state.mode === "auto" ? "🤖" : "👤";
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 50;

  return new InlineKeyboard()
    .text(`${modelEmoji} Модель: ${state.model || "sonnet"}`, "settings_model").row()
    .text(`${modeEmoji} Режим: ${state.mode || "normal"}`, "settings_mode").row()
    .text(`🕐 Часовий пояс: ${state.timezone || DEFAULT_TZ}`, "settings_tz").row()
    .text(`💰 Ліміт: $${limit}/день (витрачено: $${spent.toFixed(2)})`, "settings_spend_limit").row()
    .text(`🔄 Перезавантаження`, "settings_restart").row()
    .text(`🔑 Перепідключити Claude`, "settings_reauth_claude").row()
    .text(`✖ Закрити`, "settings_close");
}

function modelKeyboard() {
  return new InlineKeyboard()
    .text(state.model === "haiku" ? "✅ Haiku" : "Haiku", "model_haiku")
    .text(state.model === "sonnet" ? "✅ Sonnet" : "Sonnet", "model_sonnet")
    .text(state.model === "opus" ? "✅ Opus" : "Opus", "model_opus")
    .row()
    .text("← Назад", "settings_back");
}

function modeKeyboard() {
  return new InlineKeyboard()
    .text(state.mode === "normal" ? "✅ Звичайний" : "Звичайний", "mode_normal")
    .text(state.mode === "auto" ? "✅ Авто" : "Авто", "mode_auto")
    .row()
    .text("← Назад", "settings_back");
}

const tzList = [
  "UTC", "Europe/Kyiv", "Europe/Zurich", "Europe/Berlin", "Europe/Warsaw", "Asia/Almaty",
  "Asia/Vladivostok", "America/New_York", "America/Los_Angeles",
];

function tzKeyboard() {
  const kb = new InlineKeyboard();
  for (const tz of tzList) {
    const label = state.timezone === tz ? `✅ ${tz}` : tz;
    kb.text(label, `tz_${tz}`).row();
  }
  kb.text("← Назад", "settings_back");
  return kb;
}

function spendLimitKeyboard() {
  const limits = [10, 25, 50, 100, 200];
  const kb = new InlineKeyboard();
  for (const l of limits) {
    const label = state.dailySpendLimit === l ? `✅ $${l}` : `$${l}`;
    kb.text(label, `spend_${l}`);
  }
  kb.row().text("← Назад", "settings_back");
  return kb;
}

// ─── TELEGRAM BOT ────────────────────────────────────────────────────────────

// TELEGRAM_API_ROOT — тільки для тестів (підмінний сервер Telegram)
const bot = new Bot(BOT_TOKEN, process.env.TELEGRAM_API_ROOT ? { client: { apiRoot: process.env.TELEGRAM_API_ROOT } } : {});
bot.api.config.use(autoRetry());

// ─── GROUP WITH TOPICS ──────────────────────────────────────────────────────
// Бот працює в особистих і в ОДНІЙ групі. Групу запам'ятовує сам: перше
// повідомлення власниці з групи → state.group.id. Інші групи й люди — ігнор.

bot.use(async (ctx, next) => {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") return next();

  // Група → супергрупа (вмикання тем) змінює chat.id — переносимо збережений ID
  const m = ctx.msg;
  if (state.group?.id) {
    const from = m?.migrate_from_chat_id, to = m?.migrate_to_chat_id;
    if ((from && String(from) === String(state.group.id)) || (to && String(chat.id) === String(state.group.id))) {
      state.group.id = from ? chat.id : to;
      saveState(state);
      console.log(`[group] migrated to supergroup: ${state.group.id}`);
    }
  }

  if (chat.type === "channel") return;
  if (!isOwner(ctx)) return;
  if (!state.group?.id) {
    state.group = { id: chat.id, title: chat.title || "", topics: {} };
    saveState(state);
    console.log(`[group] remembered: ${chat.id} (${chat.title || ""})`);
  } else if (String(state.group.id) !== String(chat.id)) {
    // Інша група власниці (наприклад, «Приймальня», куди скрипти тільки кладуть результати): запам'ятати ID, не відповідати
    if (!state.seenGroups?.[chat.id]) {
      state.seenGroups = { ...(state.seenGroups || {}), [chat.id]: chat.title || "" };
      saveState(state);
      console.log(`[group] інша група власниці ${chat.id} «${chat.title || ""}»`);
    }
    return;
  }
  return next();
});

// Помічники. Мія вмикається словами «увімкни Мію»: ${WORKSPACE}/komanda.json → {"mia": true}, потім /setup
const TEAM = {
  mia: {
    optional: true,
    marker: "МІЯ", name: "Мія", agent: "mia-research", title: "💡 Мія • Дослідження", heading: "💡 Мія",
    intro: "Привіт! Я Мія 💡 Пиши сюди задачі на дослідження: аудиторія, болі, конкуренти, тренди. Відповідаю з посиланнями.",
  },
  leia: {
    marker: "ЛЕЯ", name: "Лея", agent: "leia-texts", title: "✍️ Лея • Тексти", heading: "✍️ Лея",
    intro: "Привіт! Я Лея ✍️ Пиши сюди задачі на тексти: пости, каруселі, підписи. Найкраще працюю з твоїми словами: кинь думки, і я зберу з них текст.",
  },
  marko: {
    marker: "МАРКО", name: "Марко", agent: "marko-visual", title: "🎬 Марко • Візуал", heading: "🎬 Марко",
    intro: "Привіт! Я Марко 🎬 Пиши сюди задачі на візуал: зверстаю карусель у твоєму брендбуці й пришлю картинки.",
  },
};
const SUMMARY_HEADING = "👑 Підсумок";
const MARKER_SRC = "^[ \\t]*(?:<[^>]+>)*[ \\t]*===[ \\t]*(МІЯ|ЛЕЯ|МАРКО|ПІДСУМОК)[ \\t]*===[ \\t]*(?:<\\/[^>]+>)*[ \\t]*$";

function isTeamGroup(ctx) {
  return !!state.group?.id && String(ctx.chat?.id) === String(state.group.id);
}

// Роль помічника, якщо повідомлення прийшло з його теми; інакше null
function topicRole(ctx) {
  if (!isTeamGroup(ctx)) return null;
  const m = ctx.msg;
  if (!m?.is_topic_message || !m.message_thread_id) return null;
  const topics = state.group.topics || {};
  return Object.keys(TEAM).find((r) => topics[r] === m.message_thread_id) || null;
}

// Особисті й General — одна сесія Марічки; кожна тема помічника — своя
function sessionKey(ctx) {
  const uid = String(ctx.from?.id);
  const role = topicRole(ctx);
  return role ? `${uid}:${role}` : uid;
}

function routePrompt(ctx, text) {
  const role = topicRole(ctx);
  if (!role) return text;
  const t = TEAM[role];
  return `[ТЕМА: ${t.name}]\n` +
    `Власниця пише напряму в тему помічника ${t.name}. Одразу передай задачу субагенту ${t.agent} ` +
    `через інструмент Agent (без плану й без «Запускаю команду?») і поверни його результат як є, без позначок ===...===.\n\n` +
    `Задача:\n${text}`;
}

function splitByMarkers(text) {
  const hits = [...text.matchAll(new RegExp(MARKER_SRC, "gmiu"))];
  if (!hits.length) return null;
  const pre = text.slice(0, hits[0].index).trim();
  const blocks = [];
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const body = text.slice(h.index + h[0].length, end).trim();
    if (body) blocks.push({ key: h[1].toUpperCase(), text: body });
  });
  return { pre, blocks };
}

function roleByMarker(key) {
  return Object.keys(TEAM).find((r) => TEAM[r].marker === key) || null;
}

function headingFor(key) {
  const role = roleByMarker(key);
  return role ? TEAM[role].heading : SUMMARY_HEADING;
}

function markersToHeadings(text) {
  return text.replace(new RegExp(MARKER_SRC, "gmiu"), (_, key) => `<b>${headingFor(key.toUpperCase())}:</b>`);
}

// Надіслати текст (і медіатеги з нього) в конкретну тему; threadId=null → General.
// Повертає false, якщо Telegram не прийняв жодної частини (наприклад, тему видалено).
async function sendToThread(chatId, threadId, text) {
  const { cleaned, media } = extractMediaTags(text);
  const extra = threadId ? { message_thread_id: threadId } : {};
  const html = mdToTgHtml(cleaned);
  const chunks = html.length <= CHUNK_HARD_LIMIT ? [html] : sendChunked(html);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML", ...extra });
    } catch {
      try {
        await bot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""), extra);
      } catch (e) {
        console.error(`[group] send to thread ${threadId || "General"} failed:`, e.message);
        return false;
      }
    }
  }
  await sendMediaList(null, media, { chatId, threadId });
  return true;
}

// Розкласти відповідь Марічки по темах за позначками ===МІЯ=== / ===ЛЕЯ=== / ===МАРКО=== / ===ПІДСУМОК===
async function deliverResponse(ctx, text, helpers = []) {
  const parts = splitByMarkers(text);
  if (!parts) {
    // Без позначок, але працював помічник → уся відповідь у його тему, у General — коротка примітка.
    // Марко головніший: якщо був він, це візуал (слайди, картинки, промпти).
    if (isTeamGroup(ctx) && !topicRole(ctx)) {
      const byAgent = (a) => Object.keys(TEAM).find((r) => TEAM[r].agent === a);
      const role = helpers.includes("marko-visual") ? "marko"
        : helpers.length === 1 ? byAgent(helpers[0]) : null;
      const threadId = role && (state.group.topics || {})[role];
      if (threadId && await sendToThread(ctx.chat.id, threadId, text)) {
        await sendToThread(ctx.chat.id, null, `<i>${TEAM[role].heading} відповів у своїй темі.</i>`);
        return;
      }
    }
    return sendResponse(ctx, text);
  }
  if (!isTeamGroup(ctx) || topicRole(ctx)) return sendResponse(ctx, markersToHeadings(text));

  const chatId = ctx.chat.id;
  const topics = state.group.topics || {};
  const general = parts.pre ? [parts.pre] : [];
  const routed = [];
  let summary = "";

  for (const b of parts.blocks) {
    const role = roleByMarker(b.key);
    if (!role) { summary += (summary ? "\n\n" : "") + b.text; continue; }
    const threadId = topics[role];
    if (threadId && await sendToThread(chatId, threadId, b.text)) {
      routed.push(TEAM[role].heading);
    } else {
      general.push(`<b>${TEAM[role].heading}:</b>\n${b.text}`);
    }
  }

  if (summary) general.push(`<b>${SUMMARY_HEADING}:</b>\n${summary}`);
  if (routed.length) general.push(`<i>Деталі в темах: ${routed.join(", ")}</i>`);
  if (general.length) await sendToThread(chatId, null, general.join("\n\n"));
}

// /setup — створити теми команди в групі (повторний виклик не дублює)
bot.command("setup", async (ctx) => {
  if (!isOwner(ctx)) return;
  if (!isTeamGroup(ctx)) {
    return ctx.reply("Команда /setup працює в групі команди. Додай мене в групу з темами (адміністратором із правом «Керування темами») і напиши /setup там.");
  }
  if (!ctx.chat.is_forum) {
    return ctx.reply("У цій групі вимкнені теми. Увімкни «Теми» в налаштуваннях групи й повтори /setup.");
  }

  state.group.topics = state.group.topics || {};
  const created = [], kept = [];

  let komanda = {};
  try { komanda = JSON.parse(readFileSync(join(WORKSPACE, "komanda.json"), "utf8")); } catch {}
  for (const [role, t] of Object.entries(TEAM)) {
    if (t.optional && !komanda[role]) continue;
    const existingId = state.group.topics[role];
    if (existingId) {
      // Перевіряємо, що тема ще існує: перейменування на ту саму назву → "not modified"
      try {
        await ctx.api.editForumTopic(ctx.chat.id, existingId, { name: t.title });
        kept.push(t.title); continue;
      } catch (e) {
        if (/not.?modified/i.test(e.description || e.message)) { kept.push(t.title); continue; }
        console.warn(`[setup] topic ${role} (${existingId}) missing, recreating:`, e.description || e.message);
      }
    }
    try {
      const topic = await ctx.api.createForumTopic(ctx.chat.id, t.title);
      state.group.topics[role] = topic.message_thread_id;
      saveState(state);
      created.push(t.title);
      await ctx.api.sendMessage(ctx.chat.id, t.intro, { message_thread_id: topic.message_thread_id }).catch(() => {});
    } catch (e) {
      console.error(`[setup] createForumTopic ${role} failed:`, e.description || e.message);
      return ctx.reply(`❌ Не вдалося створити тему «${t.title}»: ${e.description || e.message}\n\nПеревір, що я адміністратор групи з правом «Керування темами».`);
    }
  }

  const lines = [];
  if (created.length) lines.push(`✅ Створено: ${created.join(", ")}`);
  if (kept.length) lines.push(`☑️ Уже є: ${kept.join(", ")}`);
  lines.push("", `Пиши в General: відповість ${botName()} і розкладе роботу по темах. Пиши в тему помічника: задача піде саме йому.`);
  await ctx.reply(lines.join("\n"));
});

// /settings — full settings menu (AF-compatible)
bot.command("settings", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply("⚙️ Налаштування", { reply_markup: settingsKeyboard() });
});

// Settings callbacks
bot.callbackQuery("settings_model", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Обери модель:", { reply_markup: modelKeyboard() });
});

bot.callbackQuery("settings_mode", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "Звичайний: Claude питає перед діями\nАвто: Claude діє самостійно",
    { reply_markup: modeKeyboard() }
  );
});

bot.callbackQuery("settings_tz", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Обери часовий пояс:", { reply_markup: tzKeyboard() });
});

bot.callbackQuery("settings_spend_limit", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Денний ліміт витрат:", { reply_markup: spendLimitKeyboard() });
});

bot.callbackQuery("settings_restart", async (ctx) => {
  await ctx.answerCallbackQuery("Перезавантаження...");
  await ctx.editMessageText("Перезавантажуюсь...");
  setTimeout(() => process.exit(0), 500);
});

bot.callbackQuery("settings_close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
});

bot.callbackQuery("settings_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("⚙️ Налаштування", { reply_markup: settingsKeyboard() });
});

bot.callbackQuery("settings_reauth_claude", async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  try { await ctx.deleteMessage(); } catch {}
  await startReauthFlow(ctx);
});

bot.callbackQuery("reauth_claude:cancel", async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery("Скасовано");
  const s = reauthSessions.get(String(ctx.from.id));
  if (s) {
    clearTimeout(s.timer);
    reauthSessions.delete(String(ctx.from.id));
  }
  appendReauthLog(`flow cancelled by user ${ctx.from.id}`);
  try {
    await ctx.editMessageText("Скасовано. Коли захочеш: /settings → 🔑 Перепідключити Claude");
  } catch {
    await ctx.reply("Скасовано. Коли захочеш: /settings → 🔑 Перепідключити Claude");
  }
});

// Model selection callbacks
bot.callbackQuery(/^model_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const model = ctx.callbackQuery.data.replace("model_", "");
  if (["haiku", "sonnet", "opus"].includes(model)) {
    state.model = model;
    saveState(state);
    await ctx.editMessageText("Обери модель:", { reply_markup: modelKeyboard() });
  }
});

// Mode selection callbacks
bot.callbackQuery(/^mode_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const mode = ctx.callbackQuery.data.replace("mode_", "");
  if (["normal", "auto"].includes(mode)) {
    state.mode = mode;
    saveState(state);
    await ctx.editMessageText(
      "Звичайний: Claude питає перед діями\nАвто: Claude діє самостійно",
      { reply_markup: modeKeyboard() }
    );
  }
});

// Timezone selection callbacks
bot.callbackQuery(/^tz_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.callbackQuery.data.replace("tz_", "");
  state.timezone = tz;
  saveState(state);
  await ctx.editMessageText("Обери часовий пояс:", { reply_markup: tzKeyboard() });
});

// Spend limit selection callbacks
bot.callbackQuery(/^spend_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const limit = parseInt(ctx.callbackQuery.data.replace("spend_", ""));
  state.dailySpendLimit = limit;
  saveState(state);
  await ctx.editMessageText("Денний ліміт витрат:", { reply_markup: spendLimitKeyboard() });
});

// /start — знайомство або привітання
bot.command("start", async (ctx) => {
  // Auto-lock: first user to /start becomes the owner
  if (!_ownerId) {
    saveOwner(ctx);
  }
  if (!isOwner(ctx)) return;

  if (!state.bootstrapDone) {
    bootstrapStep.set(String(ctx.from.id), "ask_name");
    bootstrapData.set(String(ctx.from.id), {});
    await ctx.reply(
      "Привіт! Я твоя AI-помічниця, живу на твоєму сервері й працюю цілодобово.\n\n" +
      "Познайомимось: три коротких питання.\n\n" +
      BOOTSTRAP_STEPS.ask_name.question
    );
    return;
  }

  if (!claudeLoggedIn()) {
    await ctx.reply("Щоб я могла думати, мені треба увійти в твій Claude. Це один раз.");
    return startReauthFlow(ctx);
  }

  await ctx.reply(
    `Привіт, ${state.ownerName || ""}! Я ${botName()}.\n\n` +
    "Пиши мені текстом, надсилай фото чи файли.\n\n" +
    "/settings: налаштування\n/reset: нова розмова\n/status: як я"
  );
});

// Bootstrap callbacks
bot.callbackQuery("bootstrap_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const data = bootstrapData.get(userId);
  if (!data) return;

  try {
    writeDNAFiles(data);
    state.bootstrapDone = true;
    state.ownerName = data.name;
    state.ownerRid = data.rid;
    state.botName = data.bot;
    saveState(state);
    bootstrapStep.delete(userId);
    bootstrapData.delete(userId);
    await ctx.reply(`✅ Приємно познайомитись, ${data.name}! Тепер я ${data.bot}.`);
    if (!claudeLoggedIn()) {
      await ctx.reply("Останній крок: увійти в твій Claude, щоб я могла думати. Це один раз.");
      await startReauthFlow(ctx);
    } else {
      await ctx.reply(nextStepsText());
    }
  } catch (err) {
    console.error("[bootstrap]", err.message);
    await ctx.reply("Не вийшло записати файли: " + err.message.slice(0, 200));
  }
});

bot.callbackQuery("bootstrap_restart", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  bootstrapStep.set(userId, "ask_name");
  bootstrapData.set(userId, {});
  await ctx.reply("Починаємо спочатку.\n\n" + BOOTSTRAP_STEPS.ask_name.question);
});

// /model — redirect to settings (command still works, but not in menu)
bot.command("model", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply("Обери модель:", { reply_markup: modelKeyboard() });
});

// /reset
bot.command("reset", async (ctx) => {
  if (!isOwner(ctx)) return;
  sessions.delete(sessionKey(ctx));
  saveSessions();
  await ctx.reply("🧹 Сесію скинуто. Починаємо з чистого аркуша.");
});

// /stop — kill active Claude process
bot.command("stop", async (ctx) => {
  if (!isOwner(ctx)) return;
  if (!_activeChild && !isCliBusy()) {
    await ctx.reply("Немає активної задачі.");
    return;
  }
  if (_activeChild) {
    _activeChild.kill("SIGTERM");
    setTimeout(() => { if (_activeChild) _activeChild.kill("SIGKILL"); }, 3000);
  }
  if (_activeStatus) {
    _activeStatus.stop();
    try {
      await ctx.api.editMessageText(ctx.chat.id, _activeStatus.messageId, "⏹ Задачу зупинено.");
    } catch {}
    _activeStatus = null;
  }
  console.warn("[/stop] Task stopped by user");
});

// /status — extended info
bot.command("status", async (ctx) => {
  if (!isOwner(ctx)) return;
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 50;
  const spendStatus = checkSpendLimit();
  const spendIcon = spendStatus === "blocked" ? "🔴" : spendStatus === "warning" ? "🟡" : "🟢";

  const status =
    `<b>${botName()} v${BOT_VERSION}</b>\n\n` +
    `<b>Модель:</b> ${state.model || "sonnet"}\n` +
    `<b>Режим:</b> ${state.mode || "normal"}\n` +
    `<b>Часовий пояс:</b> ${state.timezone || DEFAULT_TZ}\n` +
    `<b>Bootstrap:</b> ${state.bootstrapDone ? "✅" : "⏳"}\n` +
    `<b>Сесія:</b> ${sessions.has(String(ctx.from.id)) ? "активна" : "немає"}\n\n` +
    `${spendIcon} <b>Витрати сьогодні:</b> $${spent.toFixed(2)} / $${limit}`;

  await ctx.reply(status, { parse_mode: "HTML" });
});

// /imya Нове ім'я — перейменувати помічницю (ім'я в розмовах і в SOUL.md)
bot.command("imya", async (ctx) => {
  if (!isOwner(ctx)) return;
  const name = (ctx.match || "").trim().slice(0, 40);
  if (!name) {
    return ctx.reply(`Зараз мене звати ${botName()}. Щоб перейменувати, напиши: /imya Нове ім'я`);
  }
  const old = botName();
  state.botName = name;
  saveState(state);
  const soul = join(WORKSPACE, "SOUL.md");
  try {
    if (existsSync(soul)) writeFileSync(soul, readFileSync(soul, "utf8").replaceAll(old, name));
  } catch (e) { console.warn("[imya]", e.message); }
  await ctx.reply(
    `✅ Тепер я ${name}.\n\n` +
    "Ім'я і фото, які видно в Telegram, міняються окремо: @BotFather → /mybots → твій бот → Edit Bot → Edit Name або Edit Botpic."
  );
});

// /update — оновитися з шаблону (той самий скрипт, що щоночі)
bot.command("update", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply("🔄 Оновлююсь з шаблону…");
  execFile(join(AGENT_HOME, "bin", "onovyty.sh"), [], { timeout: 300000 }, async (err, stdout, stderr) => {
    const out = (stdout || "").trim().split("\n").slice(-3).join("\n");
    await ctx.reply(err ? `❌ Не вийшло: ${(stderr || err.message).slice(0, 300)}` : `✅ ${out || "Готово"}`).catch(() => {});
  });
});

// /version
bot.command("version", async (ctx) => {
  if (!isOwner(ctx)) return;
  const ver = (() => {
    try { return readFileSync(join(import.meta.dirname, "VERSION"), "utf8").trim(); }
    catch { return "unknown"; }
  })();
  await ctx.reply(`${botName()} v${ver}`);
});

// ─── CONFIRMATION CALLBACKS ─────────────────────────────────────────────────

bot.callbackQuery("confirm_continue", async (ctx) => {
  await ctx.answerCallbackQuery();
  const sKey = sessionKey(ctx);
  const sessionId = sessions.get(sKey) || null;

  const thinkingMsg = await ctx.reply(formatThinkingPhrase(0, 0));
  const status = new StatusMessage(ctx, thinkingMsg.message_id);
  _activeStatus = status;
  status.start();

  try {
    const result = await callClaude("✔ Продовжуй виконання.", sessionId);
    if (result.sessionId) {
      sessions.set(sKey, result.sessionId);
      saveSessions();
    }
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await deliverResponse(ctx, result.text, result.helpers);
  } catch (err) {
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    const friendly = humanizeError(err.message);
    await ctx.reply(friendly || "Помилка. Спробуй ще раз.");
  }
});

bot.callbackQuery("confirm_stop", async (ctx) => {
  await ctx.answerCallbackQuery("Зупинено");
  await ctx.reply("Зупинено. Що робимо далі?");
});

// Handle photos (single or media group)
bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // largest size
  await enqueueMedia(ctx, {
    kind: "photo",
    fileId: photo.file_id,
    ext: ".jpg",
    caption: ctx.message.caption || null,
  });
});

// Handle documents (PDF, DOCX, etc.)
bot.on("message:document", async (ctx) => {
  if (!isOwner(ctx)) return;
  const doc = ctx.message.document;
  const ext = doc.file_name ? "." + doc.file_name.split(".").pop() : ".bin";
  await enqueueMedia(ctx, {
    kind: "document",
    fileId: doc.file_id,
    ext,
    fileName: doc.file_name,
    caption: ctx.message.caption || null,
  });
});

// Handle video
bot.on("message:video", async (ctx) => {
  if (!isOwner(ctx)) return;
  await enqueueMedia(ctx, {
    kind: "video",
    fileId: ctx.message.video.file_id,
    ext: ".mp4",
    caption: ctx.message.caption || null,
  });
});

// ─── REAUTH CLAUDE (/reauth) ─────────────────────────────────────────────────
// Константи для команди /reauth — перепідключення Claude через PKCE OAuth.
// Портовано з agent-factory@03a493a (v4.7).

const ENV_FILE = join(DATA_DIR, ".env");
const REAUTH_LOG_FILE = join(DATA_DIR, ".reauth.log");
const REAUTH_NOTIFY_FILE = join(DATA_DIR, ".reauth-pending-notify.json");
const CREDENTIALS_FILE = join(AGENT_HOME, ".claude", ".credentials.json");
const STEP5_AUTHORIZE_IMG = join(import.meta.dirname, "images", "step5_claude_authorize.png");
const STEP5_ERROR_IMG = join(import.meta.dirname, "images", "step5_browser_error.png");
const REAUTH_TIMEOUT_MS = 10 * 60 * 1000;

// userId → { codeVerifier, state, timer } для активного PKCE-флоу (живе 10 хв)
const reauthSessions = new Map();

// Лог reauth-подій БЕЗ значень токенів — лише факти (started, exchanged, failed)
function appendReauthLog(line) {
  try {
    const ts = new Date().toISOString();
    appendFileSync(REAUTH_LOG_FILE, `[${ts}] ${line}\n`);
  } catch {}
}

// Крок 1 reauth: генеруємо PKCE, надсилаємо 2 скриншоти + кнопку «Авторизуватися»
async function startReauthFlow(ctx) {
  const userId = String(ctx.from.id);
  const prev = reauthSessions.get(userId);
  if (prev) clearTimeout(prev.timer);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const stateValue = generateState();
  const authUrl = buildAuthUrl(codeChallenge, stateValue);

  const timer = setTimeout(() => {
    if (reauthSessions.has(userId)) {
      reauthSessions.delete(userId);
      appendReauthLog(`flow timed out for user ${userId}`);
      bot.api.sendMessage(
        ctx.chat.id,
        "⌛ Час на авторизацію минув (10 хвилин). Почни заново через /settings → 🔑 Перепідключити Claude"
      ).catch(() => {});
    }
  }, REAUTH_TIMEOUT_MS);

  reauthSessions.set(userId, { codeVerifier, state: stateValue, timer });
  appendReauthLog(`flow started for user ${userId}`);

  try {
    if (existsSync(STEP5_AUTHORIZE_IMG)) {
      await ctx.replyWithPhoto(new InputFile(STEP5_AUTHORIZE_IMG), {
        caption: "Крок 1: відкриється сторінка Claude, увійди в акаунт і натисни <b>Authorize</b>",
        parse_mode: "HTML",
      });
    }
    if (existsSync(STEP5_ERROR_IMG)) {
      await ctx.replyWithPhoto(new InputFile(STEP5_ERROR_IMG), {
        caption: "Крок 2: у браузері з'явиться <b>помилка</b>, це нормально. Скопіюй ВСЮ адресу з адресного рядка й надішли сюди повідомленням.",
        parse_mode: "HTML",
      });
    }
  } catch (e) {
    console.warn("[reauth] photo send failed:", e.message);
  }

  const kb = new InlineKeyboard()
    .url("🔗 Авторизуватися в Claude", authUrl)
    .row()
    .text("✖ Скасувати", "reauth_claude:cancel");

  await ctx.reply(
    "<b>🔑 Перепідключення Claude</b>\n\n" +
      "1) Натисни «Авторизуватися в Claude» нижче\n" +
      "2) Увійди в акаунт Claude → натисни «Authorize»\n" +
      "3) У браузері з'явиться помилка (це норма). Скопіюй ВСЮ адресу й надішли сюди повідомленням\n\n" +
      "Найпростіше робити це з комп'ютера: там легко скопіювати адресу. У тебе 10 хвилин. Передумала: тисни «Скасувати».",
    { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }
  );
}

// Крок 2 reauth: парсимо URL, обмінюємо code → token, пишемо .env, рестартуємо бота.
// Повертає true, якщо повідомлення оброблено як reauth-URL (тоді не передаємо в Claude).
async function completeReauthFlow(ctx, text) {
  const userId = String(ctx.from.id);
  const session = reauthSessions.get(userId);
  if (!session) return false;

  const m = text.match(/[?&]code=([^&\s]+)/);
  if (!m) {
    await ctx.reply(
      "Не бачу <code>code=</code> у повідомленні. Надішли ВСЮ адресу з адресного рядка браузера (вона починається з <code>http://localhost:16424/callback?code=…</code>).",
      { parse_mode: "HTML" }
    );
    return true;
  }

  const authCode = decodeURIComponent(m[1]);
  appendReauthLog(`code received from user ${userId} (${authCode.slice(0, 10)}...)`);

  await ctx.reply("⏳ Обмінюю код на токен (до 30 секунд)...");

  let tokenData;
  try {
    tokenData = await exchangeCodeForToken(authCode, session.codeVerifier, session.state);
  } catch (e) {
    appendReauthLog(`exchange FAILED for user ${userId}: ${e.message}`);
    await ctx.reply(
      `❌ Помилка обміну: ${e.message}\n\nСпробуй ще раз через /settings → 🔑 Перепідключити Claude: потрібне <b>нове</b> посилання, старий одноразовий.`,
      { parse_mode: "HTML" }
    );
    clearTimeout(session.timer);
    reauthSessions.delete(userId);
    return true;
  }

  // Бекап credentials.json (best-effort)
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      const backup = `${CREDENTIALS_FILE}.bak.${Date.now()}`;
      writeFileSync(backup, readFileSync(CREDENTIALS_FILE), { mode: 0o600 });
      appendReauthLog(`backup credentials → ${basename(backup)}`);
    }
  } catch (e) {
    console.warn("[reauth] backup failed:", e.message);
  }

  // Запис refresh+scopes у .env, видалення старого TOKEN
  try {
    safeEnvRemove(ENV_FILE, "CLAUDE_CODE_OAUTH_TOKEN");
    safeEnvWrite(ENV_FILE, "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", tokenData.refresh_token);
    safeEnvWrite(ENV_FILE, "CLAUDE_CODE_OAUTH_SCOPES", OAUTH_SCOPES);
    appendReauthLog(`env updated (refresh+scopes), old TOKEN removed`);
  } catch (e) {
    appendReauthLog(`env write FAILED: ${e.message}`);
    await ctx.reply(`❌ Не зміг записати в .env: ${e.message}`);
    clearTimeout(session.timer);
    reauthSessions.delete(userId);
    return true;
  }

  // Реєстрація токена в Claude CLI (best-effort — на рестарті auth-check має дотягнути)
  await ctx.reply("🔧 Реєструю токен у Claude CLI...");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("claude", ["auth", "login"], {
        env: {
          ...process.env,
          HOME: AGENT_HOME,
          NODE_OPTIONS: "--dns-result-order=ipv4first",
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: tokenData.refresh_token,
          CLAUDE_CODE_OAUTH_SCOPES: OAUTH_SCOPES,
        },
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`exit code ${code}: ${stderr.slice(0, 200)}`));
      });
      child.on("error", reject);
    });
    appendReauthLog(`claude auth login OK`);
  } catch (e) {
    appendReauthLog(`claude auth login FAILED: ${e.message}`);
    await ctx.reply(
      `⚠️ Токен записано в .env, але <code>claude auth login</code> не спрацював: ${e.message}\n\nЯ все одно перезапущуся і спробую ще раз сама.`,
      { parse_mode: "HTML" }
    );
  }

  clearTimeout(session.timer);
  reauthSessions.delete(userId);

  // Pending-notify marker: після рестарту надішлю «Готова до роботи»
  try {
    writeFileSync(
      REAUTH_NOTIFY_FILE,
      JSON.stringify({ chatId: ctx.chat.id, ts: Date.now() }),
      { mode: 0o600 }
    );
  } catch (e) {
    appendReauthLog(`notify-marker write failed: ${e.message}`);
  }

  await ctx.reply("✅ Готово! Перезавантажуюсь, за 10 секунд скажу, що готова.");
  appendReauthLog(`flow completed for user ${userId}, exiting for systemd restart`);
  setTimeout(() => process.exit(0), 1500);
  return true;
}

// /reauth — запуск flow перепідключення Claude.
// Реєструється ДО bot.on("message:text"), інакше message:text перехопить
// повідомлення першим і обірве ланцюжок (класична пастка Grammy).
bot.command("reauth", async (ctx) => {
  if (!isOwner(ctx)) return;
  await startReauthFlow(ctx);
});

// Handle text messages
bot.on("message:text", async (ctx) => {
  if (!isOwner(ctx)) return;

  const text = ctx.message.text;

  // Reauth flow: highest priority — юзер вставляє URL з ?code=...
  if (reauthSessions.has(String(ctx.from.id))) {
    const handled = await completeReauthFlow(ctx, text);
    if (handled) return;
  }

  // Bootstrap intercept — if wizard is active, handle answers
  if (await handleBootstrap(ctx, text)) return;

  // Text batching — collect rapid messages (1.5s window)
  enqueueText(ctx, text);
});

// Core text handler (called from batch processor or directly)
async function handleTextMessage(ctx, text) {
  const userId = String(ctx.from.id);

  const thinkingMsg = await ctx.reply(formatThinkingPhrase(0, 0));
  const status = new StatusMessage(ctx, thinkingMsg.message_id);
  _activeStatus = status;
  status.start();

  try {
    // Pre-fetch URLs in message (including Google Docs/Sheets)
    const urlContext = await prefetchUrls(text);
    const enrichedPrompt = routePrompt(ctx, urlContext ? text + urlContext : text);

    const sKey = sessionKey(ctx);
    const sessionId = sessions.get(sKey) || null;
    let result = await callClaude(enrichedPrompt, sessionId);

    if (result.sessionId) {
      sessions.set(sKey, result.sessionId);
      saveSessions();
    }

    // Auto-continue: if response looks truncated, send continuation
    let autoContinues = 0;
    while (autoContinues < 3 && isResponseTruncated(result.text)) {
      autoContinues++;
      console.log(`[auto-continue] Attempt ${autoContinues} for session ${result.sessionId}`);
      const contResult = await callClaude("Продовжуй.", result.sessionId);
      if (contResult.sessionId) {
        sessions.set(sKey, contResult.sessionId);
        saveSessions();
      }
      result.text += "\n\n" + contResult.text;
      result.sessionId = contResult.sessionId || result.sessionId;
    }

    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await deliverResponse(ctx, result.text, result.helpers);
  } catch (err) {
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    console.error("[error]", err.message);

    // Check for rate limit
    const match = err.message.match(/retry.after.*?(\d+)/i);
    if (match) setGlobalRateLimit(parseInt(match[1]));

    const friendly = humanizeError(err.message);
    await ctx.reply(friendly || "Сталася помилка. Спробуй ще раз або натисни 🔄 Новий діалог.");
  }
}

// Auto-continue detection: response looks cut off mid-sentence
function isResponseTruncated(text) {
  if (!text || text.length < 200) return false;
  const trimmed = text.trimEnd();
  // Ends mid-word, mid-code-block, or with ellipsis-like patterns
  if (trimmed.match(/```[^`]*$/)) return true; // unclosed code block
  const lastChar = trimmed[trimmed.length - 1];
  // Normal endings
  if (".!?)>\"':;".includes(lastChar)) return false;
  // Ends with a letter/digit mid-sentence — likely truncated
  if (/[\w\u0400-\u04FF]$/.test(trimmed)) return true;
  return false;
}

// Handle voice messages
bot.on(["message:voice", "message:video_note"], async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply(
    "🎤 Голосові я не слухаю, мені потрібен текст.\n\n" +
    "Як швидко: натисни на голосовому кнопку «→A», Telegram перетворить його на текст. Скопіюй текст і надішли мені.\n\n" +
    "Або одразу диктуй текстом: мікрофон на клавіатурі телефона."
  );
});

// ─── START ────────────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error("[bot-error]", err.message);
  // Detect rate limit from bot framework
  const match = String(err.message).match(/retry.after.*?(\d+)/i);
  if (match) setGlobalRateLimit(parseInt(match[1]));
});

bot.start({
  onStart: async () => {
    bot.api.setMyCommands([
      { command: "start", description: "Меню" },
      { command: "stop", description: "Зупинити задачу" },
      { command: "reset", description: "Нова сесія" },
      { command: "setup", description: "👑 Створити теми команди в групі" },
      { command: "settings", description: "Налаштування" },
      { command: "status", description: "Статус системи" },
      { command: "reauth", description: "🔑 Перепідключити Claude" },
      { command: "imya", description: "✏️ Перейменувати мене" },
      { command: "update", description: "🔄 Оновитися" },
      { command: "version", description: "ℹ️ Версія" },
    ]).catch((e) => console.warn("[commands] setMyCommands failed:", e.message));

    // Initialize optional modules
    await initSemanticMemory();
    startScheduler();

    // Reauth notify: якщо щойно пройшов reauth-flow — повідомити юзеру, що готова.
    // Маркер пишеться в completeReauthFlow перед process.exit(0); systemd рестартує.
    try {
      if (existsSync(REAUTH_NOTIFY_FILE)) {
        const data = JSON.parse(readFileSync(REAUTH_NOTIFY_FILE, "utf8"));
        const age = Date.now() - (data.ts || 0);
        if (age < 5 * 60 * 1000 && data.chatId) {
          await bot.api.sendMessage(
            data.chatId,
            "✅ Готова до роботи! Можеш писати звичайним повідомленням."
          );
          await bot.api.sendMessage(data.chatId, nextStepsText()).catch(() => {});
          appendReauthLog(`notify sent to chat ${data.chatId} (age ${age}ms)`);
        } else {
          appendReauthLog(`notify-marker stale (age ${age}ms) — discarded`);
        }
        unlinkSync(REAUTH_NOTIFY_FILE);
      }
    } catch (e) {
      console.warn("[reauth-notify] error:", e.message);
      try { unlinkSync(REAUTH_NOTIFY_FILE); } catch {}
    }

    // Перший запуск після встановлення: власниця відома з OWNER_ID — вітаємось першими
    if (_ownerId && !state.bootstrapDone && !state.greeted) {
      bot.api.sendMessage(_ownerId, "✅ Я встала на твій сервер і працюю! Напиши /start, і познайомимось.")
        .then(() => { state.greeted = true; saveState(state); })
        .catch((e) => console.warn("[greet]", e.description || e.message));
    }

    console.log(`Agent bot v${BOT_VERSION} started (workspace: ${WORKSPACE}, projects: ${PROJECTS})`);
    console.log(`Model: ${getCurrentModel()}, Bootstrap: ${state.bootstrapDone ? "done" : "pending"}`);
    if (_ownerId) console.log(`Owner: ${_ownerId} (only owner can use bot)`);
    else console.log("No owner yet — first /start will auto-lock");

  },
  drop_pending_updates: true,
});
