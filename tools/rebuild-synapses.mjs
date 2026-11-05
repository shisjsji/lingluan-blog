#!/usr/bin/env node
// 让服务端按标签重叠重新织一遍星图的 semantic 边。
// 重新总结会先删旧节点再建新的，它原来那些边也跟着没了，所以每次总结之后要重织一次，
// 否则同一件事被反复总结几次，星图就会越来越稀。
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
const API = process.env.NEURAL_API || 'https://lingluandf.online/neural-api';
const TOKEN = process.env.NEURAL_TOKEN || (() => {
  try { return fs.readFileSync(path.join(HOME, '.neural-token'), 'utf8').trim(); } catch { return ''; }
})();

if (!TOKEN) { console.error('缺少令牌'); process.exit(1); }

const res = await fetch(`${API}/synapses/rebuild`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  signal: AbortSignal.timeout(30000),
});
if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
const data = await res.json();
console.log(`星图重建：${data.nodes} 个节点，${data.edges} 条边`);