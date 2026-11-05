#!/usr/bin/env node
// 自动总结。没有这一步，所谓「AI 自主学习」就是假的——每场对话都得手动去后台点一下。
//
// 每次最多处理 2 场：一轮 20 分钟，避免堆积时一次性烧掉大量 token。
// 重复跑不会重复花钱，服务端的 llm_cache 会挡掉相同输入的调用。
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
const API = process.env.NEURAL_API || 'https://lingluandf.online/neural-api';
const TOKEN = process.env.NEURAL_TOKEN || (() => {
  try { return fs.readFileSync(path.join(HOME, '.neural-token'), 'utf8').trim(); } catch { return ''; }
})();

const BATCH = 2;
const TIMEOUT = 900000; // 长会话要分块，给足时间

async function call(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  if (!TOKEN) { console.error('缺少令牌'); process.exit(1); }

  const list = await call(`${API}/sessions?limit=50`);
  const pending = list.pending || 0;
  if (!pending) { console.log('没有待总结的会话'); return; }

  console.log(`待总结 ${pending} 场，本次处理 ${Math.min(BATCH, pending)} 场`);
  const result = await call(`${API}/summarize`, {
    method: 'POST',
    body: JSON.stringify({ limit: BATCH }),
  });

  for (const item of result.results || []) {
    if (item.ok) {
      const tag = item.cached ? `（命中缓存 ${item.cached} 次）` : '';
      console.log(`  完成：${item.title} ${tag}`);
    } else {
      console.error(`  失败：${item.id} ${item.error}`);
    }
  }
  console.log(`本轮完成 ${result.done} 场`);

  // 总结会替换星图节点，节点上的边也跟着重建，这里整体重织一次
  if (result.done) {
    try {
      const rebuilt = await call(`${API}/synapses/rebuild`, { method: 'POST' });
      console.log(`  星图重建：${rebuilt.nodes} 个节点，${rebuilt.edges} 条边`);
    } catch (err) {
      console.error(`  星图重建失败：${err.message}`);
    }
  }
}

main().catch((err) => { console.error('失败:', err.message); process.exit(1); });