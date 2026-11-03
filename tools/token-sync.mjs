#!/usr/bin/env node
// Token 用量采集器
// 从 MiMo 数据库统计今日 / 本月 / 历史总消耗，推送到服务器供博客展示。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.USERPROFILE || process.env.HOME;
const DB_PATH = process.env.MIMO_DB || path.join(HOME, '.local/share/mimocode/mimocode.db');
const API = process.env.NEURAL_API || 'https://lingluandf.online/neural-api';
const TOKEN = process.env.NEURAL_TOKEN || (() => {
  try {
    return fs.readFileSync(path.join(HOME, '.neural-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();

const DRY = process.argv.includes('--dry');

if (!fs.existsSync(DB_PATH)) {
  console.error('找不到 MiMo 数据库:', DB_PATH);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

/**
 * 一次扫描算出所有维度。
 * message.data 里助手消息带 tokens 对象，用户消息没有，用 json_extract 过滤。
 */
const rows = db.prepare(`
  SELECT
    time_created,
    CAST(json_extract(data, '$.tokens.total') AS INTEGER)     AS total,
    CAST(json_extract(data, '$.tokens.input') AS INTEGER)     AS input,
    CAST(json_extract(data, '$.tokens.output') AS INTEGER)    AS output,
    CAST(json_extract(data, '$.tokens.reasoning') AS INTEGER) AS reasoning,
    CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) AS cacheRead,
    json_extract(data, '$.modelID') AS modelID
  FROM message
  WHERE json_extract(data, '$.tokens.total') IS NOT NULL
  ORDER BY time_created DESC
`).all();

const now = new Date();
const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

const acc = {
  today: { total: 0, input: 0, output: 0, cache: 0, calls: 0 },
  month: { total: 0, input: 0, output: 0, cache: 0, calls: 0 },
  all: { total: 0, input: 0, output: 0, cache: 0, calls: 0 },
};
const byModel = new Map();
const byDay = new Map();

for (const r of rows) {
  const t = r.total || (r.input || 0) + (r.output || 0) + (r.reasoning || 0);
  if (!t) continue;
  const ts = Number(r.time_created);
  const cache = r.cacheRead || 0;

  for (const [key, from] of [['today', startOfDay], ['month', startOfMonth], ['all', 0]]) {
    if (ts < from) continue;
    acc[key].total += t;
    acc[key].input += r.input || 0;
    acc[key].output += r.output || 0;
    acc[key].cache += cache;
    acc[key].calls += 1;
  }

  const model = r.modelID || 'unknown';
  byModel.set(model, (byModel.get(model) || 0) + t);

  const day = new Date(ts).toISOString().slice(0, 10);
  byDay.set(day, (byDay.get(day) || 0) + t);
}

const topModels = [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([model, tokens]) => ({ model, tokens }));
const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 30).map(([day, tokens]) => ({ day, tokens }));

const payload = {
  today: acc.today,
  month: acc.month,
  all: acc.all,
  topModels,
  days,
  updatedAt: new Date().toISOString(),
};

console.log('今日  ' + acc.today.total.toLocaleString() + ' tokens / ' + acc.today.calls + ' 次调用');
console.log('本月  ' + acc.month.total.toLocaleString() + ' tokens');
console.log('历史  ' + acc.all.total.toLocaleString() + ' tokens');
console.log('模型  ' + topModels.map((m) => `${m.model}:${m.tokens.toLocaleString()}`).join('  '));

if (DRY) process.exit(0);

if (!TOKEN) {
  console.error('缺少令牌，未能上传');
  process.exit(1);
}

const res = await fetch(`${API}/tokens`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(payload),
});

if (res.ok) {
  console.log('已上传');
} else {
  console.error('上传失败:', res.status, await res.text());
  process.exit(1);
}

db.close();