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

const KINDS = ['progress', 'pitfall', 'insight', 'decision', 'output'];

const upsertKnowledge = db.prepare(`
  INSERT INTO knowledge (project, kind, title, body, tags, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(project, kind, title) DO UPDATE SET
    body = excluded.body,
    tags = excluded.tags,
    status = excluded.status,
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

function llmConfig() {
  return {
    url: setting('llm_url'),
    key: setting('llm_key'),
    model: setting('llm_model', 'deepseek-chat'),
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

// 调云端模型。统一走 OpenAI 兼容格式，DeepSeek / MiMo / 通义都支持
async function callLLM(messages, options = {}) {
  const cfg = llmConfig();
  if (!cfg.url || !cfg.key) throw new Error('还没配置模型地址和密钥');

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 1200,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`模型返回 ${res.status}：${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
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
      sendJSON(res, 200, { ok: true, url: cfg.url, model: cfg.model, key: masked, hasKey: !!cfg.key });
      return;
    }

    if (p === '/settings' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { sendJSON(res, 400, { ok: false, error: 'JSON 格式错误' }); return; }
      const now = new Date().toISOString();
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
          ON CONFLICT(id) DO UPDATE SET raw = excluded.raw, message_count = excluded.message_count
          WHERE sessions.status = 'pending'
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
      for (const session of target) {
        try {
          const content = await callLLM([
            {
              role: 'system',
              content: '你在整理用户与自己 AI 助手的工作对话。只输出一个 JSON 对象，不要任何解释或代码块标记。',
            },
            {
              role: 'user',
              content: `读下面的对话，提炼成一条记忆。不要复述原话，只写结论和方法。

输出 JSON，字段：
- title：这次主要做了什么，20 字以内，动词开头
- summary：分条写「做了什么 / 卡在哪 / 结论」，总共不超过 220 字，用换行分隔
- category：从 编程、运维、设计、论文、其他 里选一个
- project：如果明显属于某个项目（lingluan-blog 博客 / chaoxing-ai 超星 / neural-memory 记忆系统 / aurora 音频），写项目标识，否则空字符串
- pitfalls：这次踩过的坑，一到三条，每条一句话。没有就给空数组
- decisions：做过的取舍，零到两条。没有就给空数组

对话：
${session.raw.slice(0, 12000)}`,
            },
          ], { maxTokens: 900 });

          const jsonText = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
          const parsed = JSON.parse(jsonText);

          const nowIso = new Date().toISOString();
          db.prepare('UPDATE sessions SET status = ?, summary = ?, summarized_at = ? WHERE id = ?')
            .run('done', JSON.stringify(parsed), nowIso, session.id);

          // 落成 knowledge 条目，供 memory_load 读取
          const project = String(parsed.project || session.project || '').slice(0, 48);
          const cat = ['编程', '运维', '设计', '论文', '其他'].includes(parsed.category) ? parsed.category : '编程';
          upsertKnowledge.run(project, 'progress', String(parsed.title || session.title).slice(0, 120), String(parsed.summary || '').slice(0, 4000), JSON.stringify([cat]), 'done', nowIso, nowIso);
          for (const pit of (parsed.pitfalls || []).slice(0, 3)) {
            const text = String(pit || '').trim();
            if (!text) continue;
            upsertKnowledge.run(project, 'pitfall', text.slice(0, 100), text.slice(0, 2000), JSON.stringify([cat]), 'active', nowIso, nowIso);
          }
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
            });
          } catch (e) {
            // 神经元写入失败不该让整次总结失败
          }

          for (const dec of (parsed.decisions || []).slice(0, 2)) {
            const text = String(dec || '').trim();
            if (!text) continue;
            upsertKnowledge.run(project, 'decision', text.slice(0, 100), text.slice(0, 2000), JSON.stringify([cat]), 'active', nowIso, nowIso);
          }

          results.push({ id: session.id, ok: true, title: parsed.title, project, category: cat });
        } catch (err) {
          results.push({ id: session.id, ok: false, error: String(err.message).slice(0, 160) });
        }
      }

      sendJSON(res, 200, { ok: true, done: results.filter((r) => r.ok).length, results });
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
        upsertKnowledge.run(project, kind, title, body, JSON.stringify(tags), status, now, now);
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