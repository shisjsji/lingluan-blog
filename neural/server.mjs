// 智能体神经元服务
// 存储：一次对话片段 = 一个神经元；时间邻近与标签重叠构成突触
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3002);
const DB_PATH = process.env.DB_PATH || '/opt/apps/neural/data/neural.db';
const TOKEN = (process.env.NEURAL_TOKEN || '').trim();
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || 'https://lingluandf.online').split(',');

if (!TOKEN) {
  console.error('缺少环境变量 NEURAL_TOKEN');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS neurons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE NOT NULL,
    session_id TEXT,
    category TEXT NOT NULL DEFAULT '编程',
    project TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    summary TEXT DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL DEFAULT 'dialog',
    weight REAL NOT NULL DEFAULT 1,
    heat REAL NOT NULL DEFAULT 1,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    z REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_neurons_created ON neurons(created_at);
  CREATE INDEX IF NOT EXISTS idx_neurons_project ON neurons(project);
  CREATE INDEX IF NOT EXISTS idx_neurons_category ON neurons(category);

  CREATE TABLE IF NOT EXISTS synapses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'semantic',
    weight REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(source, target, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_synapses_source ON synapses(source);
  CREATE INDEX IF NOT EXISTS idx_synapses_target ON synapses(target);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 原始对话：等模型来总结，不再直接生成碎片
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    summarized_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    ip_hash TEXT NOT NULL DEFAULT '',
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'progress',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    session_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project, kind, title)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
  CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge(kind);

  CREATE TABLE IF NOT EXISTS token_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- 模型调用结果的缓存。同样的输入不再第二次付钱：
  -- 重复点总结、总结失败后重试、会话只加了几句再总结，都命中这里。
  CREATE TABLE IF NOT EXISTS llm_cache (
    key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    reply TEXT NOT NULL,
    in_chars INTEGER NOT NULL,
    out_chars INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_hit_at TEXT
  );
`);

const insertNeuron = db.prepare(`
  INSERT INTO neurons (uid, session_id, category, project, title, summary, tags, kind, weight, heat, x, y, z, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertSynapse = db.prepare(`
  INSERT OR IGNORE INTO synapses (source, target, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
`);
const selectByUid = db.prepare('SELECT * FROM neurons WHERE uid = ?');
const selectAll = db.prepare('SELECT * FROM neurons ORDER BY created_at ASC, id ASC');
const selectSynapses = db.prepare('SELECT source, target, kind, weight FROM synapses');
const selectRecent = db.prepare('SELECT * FROM neurons ORDER BY created_at DESC, id DESC LIMIT ?');
const selectSessionLast = db.prepare('SELECT * FROM neurons WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
const selectSessionUids = db.prepare('SELECT uid FROM neurons WHERE session_id = ?');
const deleteSessionNeurons = db.prepare('DELETE FROM neurons WHERE session_id = ?');
const deleteSynapsesOf = db.prepare('DELETE FROM synapses WHERE source = ? OR target = ?');

// ---------- 布局：标签决定方向，时间决定半径 ----------

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function unit(text, salt) {
  return (hashString(text + '#' + salt) % 10000) / 10000;
}

/**
 * 同一主标签的神经元聚在同一方向，时间越晚离中心越远。
 * 这样网络天然长成一团一团的簇，而时间轴回放时是向外生长的。
 */
function layoutFor(uid, tags, createdAt) {
  const mainTag = (tags && tags.length ? tags[0] : 'misc').toLowerCase();
  const baseTheta = unit(mainTag, 'theta') * Math.PI * 2;
  const basePhi = (unit(mainTag, 'phi') * 0.7 + 0.15) * Math.PI;

  const jitter = 0.55;
  const theta = baseTheta + (unit(uid, 'jt') - 0.5) * jitter * 2;
  const phi = basePhi + (unit(uid, 'jp') - 0.5) * jitter * 1.4;

  // 半径由时间决定：以 2026-01-01 为基准，按天取次线性增长
  const base = Date.parse('2026-01-01T00:00:00Z');
  const days = Math.max(0, (Date.parse(createdAt) - base) / 86400000);
  const radius = 6 + Math.pow(days / 365, 0.62) * 30;

  const sinPhi = Math.sin(phi);
  return {
    x: radius * sinPhi * Math.cos(theta),
    y: radius * Math.cos(phi) * 0.72,
    z: radius * sinPhi * Math.sin(theta),
  };
}

// ---------- 内部工具 ----------

function newUid() {
  return 'n_' + crypto.randomBytes(5).toString('hex');
}

function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const tag = String(raw || '').trim().slice(0, 24);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 6) break;
  }
  return out;
}

function rowToNode(row) {
  return {
    uid: row.uid,
    sessionId: row.session_id,
    category: row.category,
    project: row.project,
    title: row.title,
    summary: row.summary,
    tags: JSON.parse(row.tags || '[]'),
    kind: row.kind,
    weight: row.weight,
    heat: row.heat,
    pos: [row.x, row.y, row.z],
    createdAt: row.created_at,
  };
}

// 老库补列，忽略「已存在」的错误
try { db.exec("ALTER TABLE knowledge ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); } catch { /* 已存在 */ }

const KINDS = ['progress', 'pitfall', 'insight', 'decision', 'output', 'preference'];

// 提示词单独放文件，方便调整判断标准和示例
function readPrompt(name, fallback) {
  try {
    return fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  } catch {
    return fallback;
  }
}
const SUMMARY_PROMPT = readPrompt('summary-prompt.md', '你在整理工作对话。只输出 JSON：{"title","summary","category","project","pitfalls","decisions","preferences"}');
// 长会话先分段捞素材，再合并成记忆；这是第二步用的提示词
const EXTRACT_PROMPT = readPrompt('extract-prompt.md', '从这段对话里提取：问题（现象/根因/修法）、取舍、做法、他的要求、交付物。每条一行，标签开头。');

const upsertKnowledge = db.prepare(`
  INSERT INTO knowledge (project, kind, title, body, tags, status, session_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(project, kind, title) DO UPDATE SET
    body = excluded.body,
    tags = excluded.tags,
    status = excluded.status,
    session_id = excluded.session_id,
    updated_at = excluded.updated_at
`);

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

function setting(key, fallback = '') {
  const row = getSetting.get(key);
  return row ? row.value : fallback;
}

const PROVIDERS = {
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek' },
  mimo: { url: 'https://api.xiaomi.com/v1/chat/completions', model: 'mimo-v2.6-pro', label: 'MiMo' },
  qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', label: '通义千问' },
  kimi: { url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', label: 'Kimi' },
};

function llmConfig() {
  const provider = setting('llm_provider', 'deepseek');
  const preset = PROVIDERS[provider] || PROVIDERS.deepseek;
  return {
    provider,
    url: setting('llm_url') || preset.url,
    key: setting('llm_key'),
    model: setting('llm_model') || preset.model,
  };
}

const insertMessage = db.prepare('INSERT INTO messages (name, body, ip_hash, created_at) VALUES (?, ?, ?, ?)');
const MESSAGE_MAX = 50;          // 正文上限，按用户要求
const MESSAGE_COOLDOWN = 10 * 60 * 1000; // 同一来源 10 分钟一条
const messageRate = new Map();   // ip_hash -> 上次发言时间

// 只用不清理会让这张表随访客数一直增长，每小时扫一次过期的
setInterval(() => {
  const nowMs = Date.now();
  for (const [key, at] of messageRate) {
    if (nowMs - at > MESSAGE_COOLDOWN) messageRate.delete(key);
  }
}, 60 * 60 * 1000).unref();

function clientIp(req) {
  // nginx 反代后 remoteAddress 是 127.0.0.1，必须读 X-Real-IP
  const forwarded = String(req.headers['x-real-ip'] || '').trim();
  const raw = forwarded || req.socket.remoteAddress || '';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// 模型输出用的是分段文本而不是 JSON：JSON 对模型太脆，一个裸换行就整条作废。
// 这里按【段名】切分，某段格式坏了不影响其他段。
function parseSummary(text) {
  const raw = String(text || '').replace(/```(?:json|markdown)?/gi, '').trim();
  const sections = {};
  let current = null;
  const buffer = {};

  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*【(.+?)】\s*:?\s*(.*)$/);
    if (match) {
      current = match[1].trim();
      buffer[current] = match[2] ? [match[2]] : [];
      continue;
    }
    if (current && line.trim()) buffer[current].push(line.trim());
  }

  const join = (name) => (buffer[name] || []).join(' ').trim();
  const pairs = (name, limit) => {
    const out = [];
    for (const row of buffer[name] || []) {
      const idx = row.search(/[|｜]/);
      if (idx === -1) {
        if (row.length > 4) out.push({ title: row.slice(0, 100), detail: row });
      } else {
        const title = row.slice(0, idx).trim().slice(0, 100);
        const detail = row.slice(idx + 1).trim().slice(0, 2000);
        if (title) out.push({ title, detail: detail || title });
      }
      if (out.length >= limit) break;
    }
    return out;
  };

  const title = join('标题').slice(0, 120);
  if (!title) throw new Error('模型没有给出标题');

  return {
    title,
    summary: join('总结').slice(0, 2000),
    category: join('分类').slice(0, 20),
    project: join('项目').slice(0, 48),
    pitfalls: pairs('坑', 3),
    decisions: pairs('决定', 2),
    insights: pairs('经验', 2),
    outputs: pairs('交付', 2),
    preferences: pairs('偏好', 3),
  };
}

// 长会话一次读不完：先分段捞素材，再拿素材合并成记忆。
// 直接 slice(0,12000) 会把结尾的结论整段丢掉，而结论恰恰是最该记的。
const CHUNK_SIZE = 15000;
const CHUNK_MAX = 4;

async function distill(raw) {
  const text = String(raw || '');
  if (text.length <= CHUNK_SIZE) return text;

  const n = Math.min(CHUNK_MAX, Math.ceil(text.length / CHUNK_SIZE));
  const size = Math.ceil(text.length / n);
  const digests = [];

  for (let i = 0; i < n; i += 1) {
    const part = text.slice(i * size, (i + 1) * size);
    const where = `第 ${i + 1}/${n} 段${i === 0 ? '（开头）' : ''}${i === n - 1 ? '（结尾）' : ''}`;
    const out = await callLLM([
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: `这是整段对话的${where}。捞素材。\n\n${part}` },
    ], { maxTokens: 900, temperature: 0.2 });
    const cleaned = String(out || '').trim();
    if (cleaned && !cleaned.includes('无有效素材')) digests.push(`【${where}】\n${cleaned}`);
  }

  return digests.length ? digests.join('\n\n') : text.slice(0, CHUNK_SIZE);
}

// 调云端模型。统一走 OpenAI 兼容格式，DeepSeek / MiMo / 通义都支持
//
// 结果按「模型 + 参数 + 完整提问」哈希后落库。同样的输入只付一次钱：
// 重复点总结、中途失败重试、会话只多聊了几句再总结，都会命中缓存直接返回。
// 换模型或改提示词会让哈希变化，缓存自动失效，不需要手动清。
const cacheGet = db.prepare('SELECT reply, hits FROM llm_cache WHERE key = ?');
const cacheStore = db.prepare(`
  INSERT OR REPLACE INTO llm_cache (key, model, reply, in_chars, out_chars, hits, created_at, last_hit_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, NULL)
`);
const cacheTouch = db.prepare('UPDATE llm_cache SET hits = hits + 1, last_hit_at = ? WHERE key = ?');

const recentHits = { count: 0, inChars: 0 };

function llmCacheKey(model, messages, temperature, maxTokens) {
  const h = crypto.createHash('sha256');
  h.update(`${model}\u0000${temperature}\u0000${maxTokens}\u0000`);
  for (const m of messages) h.update(`${m.role}\u0000${m.content}\u0000\u0001`);
  return h.digest('hex');
}

async function callLLM(messages, options = {}) {
  const cfg = llmConfig();
  if (!cfg.url || !cfg.key) throw new Error('还没配置模型地址和密钥');

  const temperature = options.temperature ?? 0.3;
  const maxTokens = options.maxTokens ?? 1200;
  const key = llmCacheKey(cfg.model, messages, temperature, maxTokens);

  if (!options.noCache) {
    const hit = cacheGet.get(key);
    if (hit) {
      cacheTouch.run(new Date().toISOString(), key);
      recentHits.count += 1;
      recentHits.inChars += messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
      return hit.reply;
    }
  }

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`模型返回 ${res.status}：${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content || '';

  if (reply && !options.noCache) {
    const inChars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
    cacheStore.run(key, cfg.model, reply, inChars, reply.length, new Date().toISOString());
  }
  return reply;
}

const subscribers = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

// 新节点接入网络时，自动织出突触
// prev：同会话的上一段（必须在插入本节点之前查询，否则查到的是自己）
function weaveSynapses(node, tags, prev) {
  const now = new Date().toISOString();
  const created = [];

  // 1) 同会话：接上一段
  if (prev) {
    insertSynapse.run(prev.uid, node.uid, 'temporal', 1.4, now);
    created.push({ source: prev.uid, target: node.uid, kind: 'temporal', weight: 1.4 });
  }

  // 2) 标签重叠：先用 SQL 粗筛候选，再精确算重叠
  if (tags.length) {
    const wanted = new Set(tags.map((t) => t.toLowerCase()));
    const cond = tags.map(() => 'tags LIKE ?').join(' OR ');
    // LIKE 只做粗筛，真正的重叠数在下面按数组精确计算
    const candidates = db
      .prepare(`SELECT uid, tags, created_at FROM neurons WHERE uid <> ? AND (${cond}) LIMIT 500`)
      .all(node.uid, ...tags.map((t) => `%${t}%`));

    const scored = [];
    for (const row of candidates) {
      const otherTags = JSON.parse(row.tags || '[]').map((t) => t.toLowerCase());
      let overlap = 0;
      for (const t of otherTags) if (wanted.has(t)) overlap += 1;
      if (overlap > 0) scored.push({ uid: row.uid, overlap, createdAt: row.created_at });
    }
    scored.sort((a, b) => b.overlap - a.overlap || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const item of scored.slice(0, 3)) {
      const weight = 0.6 + item.overlap * 0.4;
      insertSynapse.run(node.uid, item.uid, 'semantic', weight, now);
      created.push({ source: node.uid, target: item.uid, kind: 'semantic', weight });
    }
  }

  return created;
}

// 整体重织 semantic 边：标签重叠数决定权重（0.6 + 重叠 × 0.4），每个节点保留最相近的 3 个。
// temporal 边（同会话前后段）不动，那是记录顺序，不是相似度。
function rebuildSemanticSynapses() {
  const rows = db.prepare('SELECT uid, tags FROM neurons ORDER BY created_at ASC, id ASC').all();
  const nodes = rows.map((r) => ({
    uid: r.uid,
    tags: new Set(JSON.parse(r.tags || '[]').map((t) => String(t).toLowerCase())),
  }));

  db.prepare("DELETE FROM synapses WHERE kind = 'semantic'").run();
  if (!nodes.length) return { nodes: 0, edges: 0 };

  const now = new Date().toISOString();
  let made = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const self = nodes[i];
    if (!self.tags.size) continue;

    const scored = [];
    for (let j = 0; j < nodes.length; j += 1) {
      if (i === j) continue;
      let overlap = 0;
      for (const t of nodes[j].tags) if (self.tags.has(t)) overlap += 1;
      if (overlap > 0) scored.push({ uid: nodes[j].uid, overlap });
    }

    scored.sort((a, b) => b.overlap - a.overlap);
    for (const item of scored.slice(0, 3)) {
      insertSynapse.run(self.uid, item.uid, 'semantic', 0.6 + item.overlap * 0.4, now);
      made += 1;
    }
  }

  return { nodes: nodes.length, edges: made };
}

function recordNeuron(input) {
  const title = String(input.title || '').trim().slice(0, 120);
  if (!title) throw new Error('title 不能为空');

  const tags = normalizeTags(input.tags);
  const summary = String(input.summary || '').trim().slice(0, 400);
  const sessionId = input.sessionId ? String(input.sessionId).slice(0, 64) : null;
  const category = ['编程', '论文', '杂项'].includes(input.category) ? input.category : '编程';
  const project = String(input.project || '').trim().slice(0, 24);
  const kind = ['dialog', 'tool', 'note', 'insight'].includes(input.kind) ? input.kind : 'dialog';
  const weight = Math.min(3, Math.max(0.3, Number(input.weight) || 1));
  const createdAt = input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString();

  const uid = newUid();
  const pos = layoutFor(uid, tags, createdAt);

  // 同一场会话重新总结时，旧节点要清掉再建，否则同一件事会在星图上出现好几个点
  if (sessionId && input.replace) {
    for (const row of selectSessionUids.all(sessionId)) deleteSynapsesOf.run(row.uid, row.uid);
    deleteSessionNeurons.run(sessionId);
  }

  const prev = sessionId ? selectSessionLast.get(sessionId) : null;
  insertNeuron.run(uid, sessionId, category, project, title, summary, JSON.stringify(tags), kind, weight, 1, pos.x, pos.y, pos.z, createdAt);

  const node = rowToNode(selectByUid.get(uid));
  const edges = weaveSynapses(node, tags, prev);

  broadcast('neuron', { node, edges });
  return { node, edges };
}

// ---------- HTTP ----------

function cors(res) {
  // 逗号分隔的多个来源写进单个响应头浏览器不接受，只能回显匹配的那一个
  const origin = String(res.req?.headers?.origin || '').trim();
  const allowed = ALLOW_ORIGIN.map((o) => o.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', allowed[0] || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

function sendJSON(res, code, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 检索：先用 LIKE 全量召回（中文短词只有两三个字，trigram 覆盖不到），
// 再在应用层按命中位置打分。标题命中 > 标签命中 > 摘要命中，同分看新旧。
function searchNeurons({ q, tag, from, to, limit = 20 }) {
  const clauses = [];
  const params = [];
  if (tag) {
    clauses.push('tags LIKE ?');
    params.push(`%"${tag}"%`);
  }
  if (from) {
    clauses.push('created_at >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    clauses.push('created_at <= ?');
    params.push(new Date(to).toISOString());
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM neurons ${where}`).all(...params);

  const terms = String(q || '').split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean);
  const now = Date.now();

  const scored = [];
  for (const row of rows) {
    const node = rowToNode(row);
    let score = 0;

    if (terms.length) {
      let allMatched = true;
      for (const term of terms) {
        let hit = 0;
        if (node.title.includes(term)) hit += 10;
        if (node.tags.some((t) => t.includes(term))) hit += 6;
        if (node.summary.includes(term)) hit += 3;
        if (hit === 0) allMatched = false;
        score += hit;
      }
      // 所有词都命中的优先，部分命中的作为补充
      if (!allMatched) score *= 0.35;
      if (score === 0) continue;
      // 标题完整包含原查询，额外加分
      if (node.title.includes(q)) score += 8;
    }

    // 时间衰减：越新越靠前，但只作为同分时的次要因素
    const days = (now - Date.parse(node.createdAt)) / 86400000;
    score += Math.max(0, 3 - Math.log10(1 + days) * 1.2);

    scored.push({ node, score });
  }

  scored.sort((a, b) => b.score - a.score || Date.parse(b.node.createdAt) - Date.parse(a.node.createdAt));
  const size = Math.min(100, Math.max(1, Number(limit) || 20));
  return scored.slice(0, size).map((item) => ({ ...item.node, score: Number(item.score.toFixed(2)) }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname.replace(/^\/neural-api/, '');

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (p === '/graph' && req.method === 'GET') {
      const project = url.searchParams.get('project');
      const category = url.searchParams.get('category');
      const limit = Math.min(600, Number(url.searchParams.get('limit')) || 0);

      let rows;
      if (project) rows = db.prepare('SELECT * FROM neurons WHERE project = ? ORDER BY created_at ASC').all(project);
      else if (category) rows = db.prepare('SELECT * FROM neurons WHERE category = ? ORDER BY created_at ASC').all(category);
      else rows = selectAll.all();

      // 默认给每个视图封顶，避免一次渲染过多节点把页面压垮
      if (limit && rows.length > limit) rows = rows.slice(-limit);

      const nodes = rows.map(rowToNode);
      const keep = new Set(nodes.map((n) => n.uid));
      const edges = selectSynapses
        .all()
        .filter((e) => keep.has(e.source) && keep.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, kind: e.kind, weight: e.weight }));

      sendJSON(res, 200, { nodes, edges, total: rows.length });
      return;
    }

    // 留言板：读和写都公开，写有频率与长度约束
    if (p === '/messages' && req.method === 'GET') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 50);
      const rows = db
        .prepare('SELECT id, name, body, created_at FROM messages WHERE hidden = 0 ORDER BY created_at DESC LIMIT ?')
        .all(limit);
      sendJSON(res, 200, {
        ok: true,
        total: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE hidden = 0').get().c,
        items: rows.map((r) => ({ id: r.id, name: r.name, body: r.body, createdAt: r.created_at })),
      });
      return;
    }

    if (p === '/messages' && req.method === 'POST') {
      const raw = await readBody(req, 4096);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJSON(res, 400, { ok: false, error: '格式不对' });
        return;
      }

      const body = String(payload.body || '').trim();
      const name = String(payload.name || '').trim().slice(0, 20);
      if (!body) { sendJSON(res, 400, { ok: false, error: '写点什么再发吧' }); return; }
      if (body.length > MESSAGE_MAX) {
        sendJSON(res, 400, { ok: false, error: `最多 ${MESSAGE_MAX} 个字` });
        return;
      }
      // 纯链接视为垃圾
      const links = body.match(/https?:\/\//g) || [];
      if (links.length >= 2) { sendJSON(res, 400, { ok: false, error: '内容里有太多链接' }); return; }

      const ip = clientIp(req);
      const now = Date.now();
      const last = messageRate.get(ip) || 0;
      if (now - last < MESSAGE_COOLDOWN) {
        const wait = Math.ceil((MESSAGE_COOLDOWN - (now - last)) / 60000);
        sendJSON(res, 429, { ok: false, error: `刚留过了，${wait} 分钟后再来` });
        return;
      }

      const createdAt = new Date().toISOString();
      const info = insertMessage.run(name, body, ip, createdAt);
      messageRate.set(ip, now);
      sendJSON(res, 200, { ok: true, item: { id: Number(info.lastInsertRowid), name, body, createdAt } });
      return;
    }

    if (p === '/tokens' && req.method === 'GET') {
      const row = db.prepare('SELECT payload, created_at FROM token_stats ORDER BY id DESC LIMIT 1').get();
      if (!row) {
        sendJSON(res, 200, { ok: true, empty: true });
        return;
      }
      sendJSON(res, 200, { ok: true, ...JSON.parse(row.payload), snapshotAt: row.created_at });
      return;
    }

    // 缓存省了多少，直接看这里
    if (p === '/cache' && req.method === 'GET') {
      const agg = db.prepare(`
        SELECT COUNT(*) AS entries,
               COALESCE(SUM(hits), 0) AS hits,
               COALESCE(SUM(in_chars), 0) AS sentIn,
               COALESCE(SUM(out_chars), 0) AS sentOut,
               COALESCE(SUM(in_chars * hits), 0) AS savedIn,
               COALESCE(SUM(out_chars * hits), 0) AS savedOut
        FROM llm_cache
      `).get();
      sendJSON(res, 200, {
        ok: true,
        entries: agg.entries,
        hits: agg.hits,
        // 真正发给模型的和被缓存挡下来的，分开算，别自己骗自己
        spentChars: agg.sentIn + agg.sentOut,
        savedChars: agg.savedIn + agg.savedOut,
        thisRun: { ...recentHits },
      });
      return;
    }

    if (p === '/scope' && req.method === 'GET') {
      const rows = db.prepare('SELECT category, project, COUNT(*) AS n FROM neurons GROUP BY category, project').all();
      const map = new Map();
      for (const r of rows) {
        const cat = r.category || '编程';
        if (!map.has(cat)) map.set(cat, { category: cat, total: 0, projects: [] });
        const entry = map.get(cat);
        entry.total += r.n;
        if (r.project) entry.projects.push({ name: r.project, count: r.n });
      }
      for (const entry of map.values()) entry.projects.sort((a, b) => b.count - a.count);
      sendJSON(res, 200, { categories: [...map.values()] });
      return;
    }

    if (p === '/stats' && req.method === 'GET') {
      const total = db.prepare('SELECT COUNT(*) AS c FROM neurons').get().c;
      const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM synapses').get().c;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayCount = db.prepare('SELECT COUNT(*) AS c FROM neurons WHERE created_at >= ?').get(today.toISOString()).c;
      const sessions = db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM neurons WHERE session_id IS NOT NULL').get().c;
      const first = db.prepare('SELECT MIN(created_at) AS t FROM neurons').get().t;
      const last = db.prepare('SELECT MAX(created_at) AS t FROM neurons').get().t;
      const tagRows = db.prepare('SELECT tags FROM neurons').all();
      const tagCount = new Map();
      for (const row of tagRows) {
        for (const tag of JSON.parse(row.tags || '[]')) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      }
      const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
      sendJSON(res, 200, { total, edges: edgeCount, today: todayCount, sessions, first, last, topTags });
      return;
    }

    if (p === '/recent' && req.method === 'GET') {
      const limit = Math.min(50, Number(url.searchParams.get('limit')) || 8);
      sendJSON(res, 200, { nodes: selectRecent.all(limit).map(rowToNode) });
      return;
    }

    if (p.startsWith('/node/') && req.method === 'GET') {
      const uid = p.slice('/node/'.length);
      const row = selectByUid.get(uid);
      if (!row) {
        sendJSON(res, 404, { ok: false, error: '神经元不存在' });
        return;
      }
      const links = db.prepare('SELECT source, target, kind, weight FROM synapses WHERE source = ? OR target = ?').all(uid, uid);
      sendJSON(res, 200, { node: rowToNode(row), links });
      return;
    }

    if (p === '/stream' && req.method === 'GET') {
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('event: ready\ndata: {}\n\n');
      subscribers.add(res);
      const keep = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keep);
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(keep);
        subscribers.delete(res);
      });
      return;
    }

    // ---- 以下需要鉴权 ----
    if (!authed(req)) {
      sendJSON(res, 401, { ok: false, error: '未授权：需要 Bearer token' });
      return;
    }

    // 重新总结会删掉旧节点再建新的，它连出去和被连的边也跟着没了。
    // 反复几次星图就会越来越稀，所以在总结之后整体重织一遍。
    if (p === '/synapses/rebuild' && req.method === 'POST') {
      sendJSON(res, 200, { ok: true, ...rebuildSemanticSynapses() });
      return;
    }

    if (p.startsWith('/messages/') && req.method === 'DELETE') {
      const id = Number(p.slice('/messages/'.length));
      if (!Number.isInteger(id) || id <= 0) { sendJSON(res, 400, { ok: false, error: 'id 不对' }); return; }
      const r = db.prepare('UPDATE messages SET hidden = 1 WHERE id = ?').run(id);
      sendJSON(res, 200, { ok: true, hidden: r.changes });
      return;
    }

    if (p === '/tokens' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJSON(res, 400, { ok: false, error: 'JSON 格式错误' });
        return;
      }
      db.prepare('INSERT INTO token_stats (payload, created_at) VALUES (?, ?)').run(JSON.stringify(payload), new Date().toISOString());
      // 只保留最近 200 次快照
      db.prepare('DELETE FROM token_stats WHERE id NOT IN (SELECT id FROM token_stats ORDER BY id DESC LIMIT 200)').run();
      sendJSON(res, 200, { ok: true });
      return;
    }


    if (p === '/knowledge' && req.method === 'GET') {
      const project = url.searchParams.get('project');
      const kind = url.searchParams.get('kind');
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
      const clauses = [];
      const params = [];
      if (project) { clauses.push('project = ?'); params.push(project); }
      if (kind) { clauses.push('kind = ?'); params.push(kind); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM knowledge ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
      sendJSON(res, 200, {
        ok: true,
        items: rows.map((r) => ({
          project: r.project,
          kind: r.kind,
          title: r.title,
          body: r.body,
          tags: JSON.parse(r.tags || '[]'),
          status: r.status,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      });
      return;
    }

    // 项目全貌：一次读完，供 agent 加载上下文
    if (p === '/brief' && req.method === 'GET') {
      const project = url.searchParams.get('project');
      if (!project) {
        sendJSON(res, 400, { ok: false, error: '需要 project 参数' });
        return;
      }
      const rows = db.prepare('SELECT * FROM knowledge WHERE project = ? ORDER BY kind, updated_at DESC').all(project);
      const grouped = {};
      for (const kind of KINDS) grouped[kind] = [];
      for (const r of rows) {
        if (!grouped[r.kind]) grouped[r.kind] = [];
        grouped[r.kind].push({
          title: r.title,
          body: r.body,
          tags: JSON.parse(r.tags || '[]'),
          status: r.status,
          updatedAt: r.updated_at,
        });
      }
      const lastActive = rows.length ? rows.map((r) => r.updated_at).sort().pop() : null;
      sendJSON(res, 200, { ok: true, project, lastActive, total: rows.length, ...grouped });
      return;
    }

    if (p === '/projects' && req.method === 'GET') {
      const rows = db.prepare('SELECT project, COUNT(*) AS n, MAX(updated_at) AS last FROM knowledge WHERE project <> \'\' GROUP BY project ORDER BY last DESC').all();
      sendJSON(res, 200, { ok: true, projects: rows.map((r) => ({ project: r.project, count: r.n, lastActive: r.last })) });
      return;
    }

    // ---- 模型配置 ----
    if (p === '/settings' && req.method === 'GET') {
      const cfg = llmConfig();
      const masked = cfg.key ? cfg.key.slice(0, 6) + '••••' + cfg.key.slice(-4) : '';
      sendJSON(res, 200, {
        ok: true, provider: cfg.provider, url: cfg.url, model: cfg.model, key: masked, hasKey: !!cfg.key,
        providers: Object.entries(PROVIDERS).map(([id, v]) => ({ id, label: v.label, url: v.url, model: v.model })),
      });
      return;
    }

    // 保存后立刻试一次，让人看到通不通，而不是等到总结时才报错
    if (p === '/settings/test' && req.method === 'POST') {
      try {
        const reply = await callLLM([
          { role: 'user', content: '只回复两个字：可用' },
        ], { maxTokens: 20, temperature: 0, noCache: true });
        sendJSON(res, 200, { ok: true, reply: reply.trim().slice(0, 40) });
      } catch (err) {
        sendJSON(res, 200, { ok: false, error: String(err.message).slice(0, 300) });
      }
      return;
    }

    if (p === '/settings' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { sendJSON(res, 400, { ok: false, error: 'JSON 格式错误' }); return; }
      const now = new Date().toISOString();
      if (typeof payload.provider === 'string' && PROVIDERS[payload.provider]) {
        putSetting.run('llm_provider', payload.provider, now);
        const preset = PROVIDERS[payload.provider];
        // 换提供商时把地址和模型重置成该家的预设，省得手填
        putSetting.run('llm_url', preset.url, now);
        putSetting.run('llm_model', preset.model, now);
      }
      if (typeof payload.url === 'string') putSetting.run('llm_url', payload.url.trim(), now);
      if (typeof payload.model === 'string') putSetting.run('llm_model', payload.model.trim(), now);
      // 密钥传了才改，传空字符串不动，避免脱敏显示被写回去
      if (typeof payload.key === 'string' && payload.key.trim() && !payload.key.includes('•')) {
        putSetting.run('llm_key', payload.key.trim(), now);
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---- 客户端上传原始对话，等模型总结 ----
    if (p === '/sessions' && req.method === 'POST') {
      const raw = await readBody(req, 512 * 1024);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { sendJSON(res, 400, { ok: false, error: 'JSON 格式错误' }); return; }
      const items = Array.isArray(payload) ? payload : [payload];
      const now = new Date().toISOString();
      let saved = 0;
      for (const item of items) {
        const id = String(item.id || '').trim().slice(0, 80);
        const text = String(item.raw || '').trim();
        if (!id || !text) continue;
        db.prepare(`
          INSERT INTO sessions (id, title, project, raw, status, message_count, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            raw = excluded.raw,
            message_count = excluded.message_count,
            status = CASE
              WHEN sessions.status = 'pending' THEN 'pending'
              WHEN excluded.message_count >= sessions.message_count + 20 THEN 'pending'
              ELSE sessions.status
            END
        `).run(id, String(item.title || '').slice(0, 120), String(item.project || '').slice(0, 40), text, Number(item.messageCount) || 0, now);
        saved += 1;
      }
      sendJSON(res, 200, { ok: true, saved });
      return;
    }

    if (p === '/sessions' && req.method === 'GET') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 30);
      const rows = db.prepare('SELECT id, title, project, status, summary, message_count, created_at, summarized_at FROM sessions ORDER BY created_at DESC LIMIT ?').all(limit);
      sendJSON(res, 200, {
        ok: true,
        pending: db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'pending'").get().c,
        items: rows.map((r) => ({
          id: r.id, title: r.title, project: r.project, status: r.status,
          summary: r.summary, messageCount: r.message_count,
          createdAt: r.created_at, summarizedAt: r.summarized_at,
        })),
      });
      return;
    }

    // ---- 用模型总结 ----
    if (p === '/summarize' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* 用默认值 */ }

      const target = payload.sessionId
        ? db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'pending'").all(payload.sessionId)
        : db.prepare("SELECT * FROM sessions WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?").all(Math.min(5, Number(payload.limit) || 3));

      if (!target.length) { sendJSON(res, 200, { ok: true, done: 0, message: '没有待总结的会话' }); return; }

      const results = [];
      const hitsBefore = recentHits.count;
      const putPairs = (project, cat, sessionId, kind, status, list, limit, nowIso) => {
        for (const row of (list || []).slice(0, limit)) {
          const item = typeof row === 'string' ? { title: row, detail: '' } : (row || {});
          const title = String(item.title || '').trim().slice(0, 100);
          if (!title) continue;
          const detail = String(item.detail || '').trim().slice(0, 2000) || title;
          upsertKnowledge.run(project, kind, title, detail, JSON.stringify([cat]), status, sessionId, nowIso, nowIso);
        }
      };

      for (const session of target) {
        try {
          const material = await distill(session.raw);
          const merged = material.length < String(session.raw || '').length;

          const content = await callLLM([
            { role: 'system', content: SUMMARY_PROMPT },
            {
              role: 'user',
              content: merged
                ? `记录太长，下面是分段提炼出的素材。事实都在里面，但它还不是记忆。按上面的标准合并成一条记忆：重复的并掉，前后矛盾的以结尾段的结论为准。\n\n${material}`
                : `下面是这次对话的完整记录。按上面的标准提炼成一条记忆。\n\n${material}`,
            },
          ], { maxTokens: 1100 });

          const parsed = parseSummary(content);

          const nowIso = new Date().toISOString();
          db.prepare('UPDATE sessions SET status = ?, summary = ?, summarized_at = ? WHERE id = ?')
            .run('done', JSON.stringify(parsed), nowIso, session.id);

          // 同一场会话重新总结时，先清掉上次生成的条目，否则会越积越多
          db.prepare("DELETE FROM knowledge WHERE session_id = ? AND kind IN ('progress','pitfall','decision','preference','insight','output')").run(session.id);

          // 落成 knowledge 条目，供 memory_load 读取
          const project = String(parsed.project || session.project || 'general').slice(0, 48);
          const cat = ['编程', '运维', '设计', '论文', '其他'].includes(parsed.category) ? parsed.category : '编程';
          upsertKnowledge.run(project, 'progress', String(parsed.title || session.title).slice(0, 120), String(parsed.summary || '').slice(0, 4000), JSON.stringify([cat]), 'done', session.id, nowIso, nowIso);
          putPairs(project, cat, session.id, 'pitfall', 'active', parsed.pitfalls, 3, nowIso);
          putPairs(project, cat, session.id, 'preference', 'active', parsed.preferences, 3, nowIso);
          putPairs(project, cat, session.id, 'decision', 'active', parsed.decisions, 2, nowIso);
          putPairs(project, cat, session.id, 'insight', 'active', parsed.insights, 2, nowIso);
          putPairs(project, cat, session.id, 'output', 'active', parsed.outputs, 2, nowIso);

          // 星图需要节点，这里把总结也写成一条神经元（会自动织边）
          try {
            recordNeuron({
              title: String(parsed.title || session.title || '未命名').slice(0, 80),
              summary: String(parsed.summary || '').slice(0, 400),
              tags: [cat, project].filter(Boolean),
              category: cat,
              project,
              sessionId: session.id,
              kind: 'insight',
              weight: 1.5,
              createdAt: nowIso,
              replace: true,
            });
          } catch (e) {
            // 神经元写入失败不该让整次总结失败
          }

          results.push({ id: session.id, ok: true, title: parsed.title, project, category: cat, merged });
        } catch (err) {
          results.push({ id: session.id, ok: false, error: String(err.message).slice(0, 160) });
        }
      }

      sendJSON(res, 200, { ok: true, done: results.filter((r) => r.ok).length, cached: recentHits.count - hitsBefore, results });
      return;
    }

    if (p === '/knowledge' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJSON(res, 400, { ok: false, error: 'JSON 格式错误' });
        return;
      }
      const items = Array.isArray(payload) ? payload : [payload];
      const now = new Date().toISOString();
      let saved = 0;
      for (const item of items) {
        const project = String(item.project || '').trim().slice(0, 48);
        const kind = KINDS.includes(item.kind) ? item.kind : 'progress';
        const title = String(item.title || '').trim().slice(0, 120);
        if (!title) continue;
        const body = String(item.body || '').trim().slice(0, 4000);
        const tags = normalizeTags(item.tags);
        const status = ['active', 'done', 'dropped'].includes(item.status) ? item.status : 'active';
        // 注意：upsertKnowledge 是 9 个占位符（project/kind/title/body/tags/status/session_id/created_at/updated_at）。
        // 少传一个不会报参数错误，只会把后面的值整体前移、末尾留 NULL，所以这里必须逐个对齐。
        const sessionId = String(item.sessionId || '').slice(0, 64);
        upsertKnowledge.run(project, kind, title, body, JSON.stringify(tags), status, sessionId, now, now);
        saved += 1;
      }
      sendJSON(res, 200, { ok: true, saved });
      return;
    }

    if (p === '/record' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJSON(res, 400, { ok: false, error: 'JSON 格式错误' });
        return;
      }
      const result = recordNeuron(payload);
      sendJSON(res, 200, { ok: true, ...result });
      return;
    }

    if (p === '/search' && (req.method === 'POST' || req.method === 'GET')) {
      let params;
      if (req.method === 'POST') {
        const raw = await readBody(req);
        params = JSON.parse(raw.toString('utf8') || '{}');
      } else {
        params = Object.fromEntries(url.searchParams.entries());
      }
      sendJSON(res, 200, { ok: true, nodes: searchNeurons(params) });
      return;
    }

    sendJSON(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    sendJSON(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`neural-api listening on 127.0.0.1:${PORT}`);
});