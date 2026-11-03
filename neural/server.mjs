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
`);

const insertNeuron = db.prepare(`
  INSERT INTO neurons (uid, session_id, title, summary, tags, kind, weight, heat, x, y, z, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  // 2) 标签重叠：挑最相近的几个历史节点连过去
  if (tags.length) {
    const wanted = new Set(tags.map((t) => t.toLowerCase()));
    const scored = [];
    for (const row of selectAll.all()) {
      if (row.uid === node.uid) continue;
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
  const kind = ['dialog', 'tool', 'note', 'insight'].includes(input.kind) ? input.kind : 'dialog';
  const weight = Math.min(3, Math.max(0.3, Number(input.weight) || 1));
  const createdAt = input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString();

  const uid = newUid();
  const pos = layoutFor(uid, tags, createdAt);
  const prev = sessionId ? selectSessionLast.get(sessionId) : null;
  insertNeuron.run(uid, sessionId, title, summary, JSON.stringify(tags), kind, weight, 1, pos.x, pos.y, pos.z, createdAt);

  const node = rowToNode(selectByUid.get(uid));
  const edges = weaveSynapses(node, tags, prev);

  broadcast('neuron', { node, edges });
  return { node, edges };
}

// ---------- HTTP ----------

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN.join(',') || '*');
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

function searchNeurons({ q, tag, from, to, limit = 20 }) {
  const clauses = [];
  const params = [];
  if (q) {
    clauses.push('(title LIKE ? OR summary LIKE ? OR tags LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
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
  const sql = `SELECT * FROM neurons ${where} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, Math.min(100, Math.max(1, Number(limit) || 20)));
  return rows.map(rowToNode);
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
      const nodes = selectAll.all().map(rowToNode);
      const edges = selectSynapses.all().map((e) => ({ source: e.source, target: e.target, kind: e.kind, weight: e.weight }));
      sendJSON(res, 200, { nodes, edges });
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