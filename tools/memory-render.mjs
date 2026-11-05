#!/usr/bin/env node
// 把服务器上的项目记忆渲染进 MiMo 的项目记忆文件
//
// 这是整套东西的关键一环：MCP 工具不会被自动调用，但 MEMORY.md 每次对话都会
// 被读进上下文。所以真正的"AI 有记忆"靠的是这个文件，不是靠模型主动查。
//
// 只写标记块内部，块外内容（MiMo 自己记的）原样保留。
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
const API = process.env.NEURAL_API || 'https://lingluandf.online/neural-api';
const TOKEN = process.env.NEURAL_TOKEN || (() => {
  try { return fs.readFileSync(path.join(HOME, '.neural-token'), 'utf8').trim(); } catch { return ''; }
})();

// 要同步进上下文的目标文件。
// 分两种：
//   full  —— 完整记忆，给对应项目的会话用
//   prefs —— 只放「他的习惯」和「可复用的经验」，这两类跟项目无关，放全局，
//            这样不管开哪个项目的对话，他一上来就是认识的人
const TARGETS = [
  {
    file: path.join(HOME, '.local/share/mimocode/memory/projects/da2ed82c-a748-4d00-9bf6-f6a411445a38/MEMORY.md'),
    projects: ['lingluan-blog', 'neural-memory', 'general'],
    title: '个人博客与记忆系统',
    mode: 'full',
  },
  {
    file: path.join(HOME, '.local/share/mimocode/memory/global/MEMORY.md'),
    projects: '*',
    title: '凌乱的风',
    mode: 'prefs',
  },
];

const BEGIN = '<!-- auto-memory:begin -->';
const END = '<!-- auto-memory:end -->';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function fetchBrief(project) {
  const res = await fetch(`${API}/brief?project=${encodeURIComponent(project)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`读取 ${project} 失败：${res.status}`);
  return res.json();
}

async function listProjects() {
  const res = await fetch(`${API}/projects`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`读取项目列表失败：${res.status}`);
  const data = await res.json();
  return (data.projects || []).map((p) => p.project).filter(Boolean);
}

// 标题和正文相同时只渲染一次，避免「A：A」
function line(item, limit) {
  const title = String(item.title || '').trim();
  const body = String(item.body || '').replace(/\s+/g, ' ').trim();
  if (!body || body === title) return `- **${title}**`;
  const cut = body.length > limit ? body.slice(0, limit) + '…' : body;
  return `- **${title}**：${cut}`;
}

// 不同会话会把同一件事各写一遍（「改代码前先评估影响」vs「改代码前先评估影响，别修东墙补西墙」），
// 全塞进去就是重复。保留信息量最大的那条，短的和它重复的丢掉。
function dedupeByTitle(items) {
  const key = (s) => String(s || '').toLowerCase().replace(/[\s，。、（）()「」"']/g, '');
  const sorted = [...items].sort((a, b) => String(b.title || '').length - String(a.title || '').length);
  const kept = [];
  for (const item of sorted) {
    const k = key(item.title);
    if (!k) continue;
    if (kept.some((x) => x.k.includes(k) || k.includes(x.k))) continue;
    kept.push({ ...item, k });
  }
  return kept;
}

function renderBlock(title, briefs, mode = 'full') {
  const lines = [];
  const total = briefs.reduce((sum, b) => sum + (b.total || 0), 0);
  if (!total) return null;
  const full = mode === 'full';

  lines.push(BEGIN);
  lines.push(full ? `# ${title}的记忆（自动同步，块内勿手改）` : `# 关于${title}（自动同步，块内勿手改）`);
  lines.push('');
  if (full) {
    lines.push('> 这份内容由守护进程从服务器知识库同步而来，每 20 分钟刷新一次。');
    lines.push('> 它记录的是「做到哪、踩过什么坑、做过什么决定」，用来避免重复踩坑和重复解释。');
  } else {
    lines.push('> 这是他的个人习惯和踩坑经验，跨项目通用，由守护进程每 20 分钟自动同步。');
    lines.push('> 这些不是建议，是已经确认过的要求，照做就行，不用再问一遍。');
  }
  lines.push('');

  // 习惯排最前：它决定该怎么配合，比「做过什么」更重要。
// 全局那份只收打了「手写」标记的：模型总结出来的偏好经常是某个项目的界面需求
// （「底栏要完整移植」「日志要分章节」），放进跨项目的记忆里就是噪音。
  const rawPrefs = briefs.flatMap((b) => (b.preference || []).filter((x) => x.status !== 'dropped'));
  const prefs = dedupeByTitle(full ? rawPrefs : rawPrefs.filter((x) => (x.tags || []).includes('手写')));
  if (prefs.length) {
    lines.push('## 他的习惯（照这个来）');
    for (const pref of prefs.slice(0, 12)) lines.push(line(pref, 160));
    lines.push('');
  }

  // 坑优先：这是最省时间的一块
  const pitfalls = briefs.flatMap((b) => (b.pitfall || []).filter((x) => x.status !== 'dropped').map((x) => ({ ...x, project: b.project })));
  if (full && pitfalls.length) {
    lines.push('## 踩过的坑（别重复踩）');
    for (const pit of pitfalls.slice(0, 12)) lines.push(line(pit, 180));
    lines.push('');
  }

  const decisions = briefs.flatMap((b) => (b.decision || []).filter((x) => x.status !== 'dropped'));
  if (full && decisions.length) {
    lines.push('## 做过的决定（别再推翻）');
    for (const dec of decisions.slice(0, 8)) lines.push(line(dec, 140));
    lines.push('');
  }

  const progress = briefs
    .flatMap((b) => (b.progress || []).filter((x) => x.status !== 'dropped').map((x) => ({ ...x, project: b.project })))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (full && progress.length) {
    lines.push('## 最近在做');
    for (const p of progress.slice(0, 10)) {
      const body = String(p.body || '').replace(/\s+/g, ' ').trim();
      const flag = p.status === 'done' ? '（已完成）' : '';
      const cut = body && body !== p.title ? `：${body.slice(0, 150)}${body.length > 150 ? '…' : ''}` : '';
      lines.push(`- ${fmtDate(p.updatedAt)} ${p.title}${flag}${cut}`);
    }
    lines.push('');
  }

  const insights = dedupeByTitle(briefs.flatMap((b) => b.insight || []));
  if (insights.length) {
    lines.push('## 可复用的经验');
    for (const ins of insights.slice(0, full ? 6 : 8)) lines.push(line(ins, 150));
    lines.push('');
  }

  const outputs = briefs.flatMap((b) => (b.output || []).filter((x) => x.status !== 'dropped'));
  if (full && outputs.length) {
    lines.push('## 东西放在哪');
    for (const out of outputs.slice(0, 6)) lines.push(line(out, 120));
    lines.push('');
  }

  lines.push(END);
  return lines.join('\n');
}

function mergeIntoFile(file, block) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* 新文件 */ }

  const startIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END);

  let out;
  if (startIdx !== -1 && endIdx !== -1) {
    out = existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length);
  } else if (existing.trim()) {
    out = existing.trimEnd() + '\n\n' + block + '\n';
  } else {
    out = block + '\n';
  }
  fs.writeFileSync(file, out, 'utf8');
}

async function main() {
  if (!TOKEN) { console.error('缺少令牌'); process.exit(1); }

  let all = [];
  try {
    all = await listProjects();
  } catch (err) {
    console.error(`  项目列表读取失败：${err.message}`);
  }

  for (const target of TARGETS) {
    const wanted = target.projects === '*' ? ['general', ...all] : target.projects;
    if (!wanted.length) continue;
    const briefs = [];
    for (const project of [...new Set(wanted)]) {
      try {
        const brief = await fetchBrief(project);
        if (brief.total) briefs.push(brief);
      } catch (err) {
        console.error(`  ${project}: ${err.message}`);
      }
    }
    const block = renderBlock(target.title, briefs, target.mode);
    if (!block) { console.log(`${target.title}：暂无记忆，跳过`); continue; }
    mergeIntoFile(target.file, block);
    const kb = Math.round(Buffer.byteLength(block, 'utf8') / 1024 * 10) / 10;
    console.log(`${target.title}：已写入 ${target.file.replace(HOME, '~')}（${kb}KB，${briefs.length} 个项目）`);
  }
}

main().catch((err) => { console.error('失败:', err.message); process.exit(1); });