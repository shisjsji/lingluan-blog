#!/usr/bin/env node
// MiMo 记忆同步器
// 从 mimocode.db 读取对话，按「一次用户请求 + 后续处理」切成记忆片段，
// 提炼成摘要，落成 .md 文件，并同步进神经元网络。
//
// 用法：
//   node neural-sync.mjs            增量同步
//   node neural-sync.mjs --full     全量重扫
//   node neural-sync.mjs --dry      只打印，不写文件不上传
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.USERPROFILE || process.env.HOME;
const DB_PATH = process.env.MIMO_DB || path.join(HOME, '.local/share/mimocode/mimocode.db');
const MD_DIR = process.env.MEMORY_MD_DIR || path.join(HOME, '.local/share/mimocode/neural-memory');
const STATE_PATH = path.join(MD_DIR, '.sync-state.json');
const API = process.env.NEURAL_API || 'https://lingluandf.online/neural-api';
const TOKEN = process.env.NEURAL_TOKEN || '';

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const DRY = args.includes('--dry');

// 关键词表：用于给片段打标签并驱动神经元成簇
const TAG_LEXICON = [
  ['超星', ['超星', '学习通', 'xuexitong', '刷课', '答题']],
  ['GitHub', ['github', '仓库', 'repo', 'commit', 'push', 'actions']],
  ['服务器', ['服务器', 'nginx', '阿里云', 'ecs', '部署', 'ubuntu', 'systemd', 'ssh']],
  ['音频', ['音频', 'dolby', '调音', '扬声器', 'eq', 'aurora']],
  ['亮度', ['亮度', 'brightness', 'aod', '色温']],
  ['PPT', ['ppt', '幻灯片', '演示文稿', '排版', '动效', 'cyberppt']],
  ['Android', ['android', 'magisk', 'kernelsu', 'xposed', 'apk', 'miui']],
  ['Python', ['python', 'pip', 'pyinstaller', '.py']],
  ['逆向', ['逆向', '反编译', '二进制', 'ida', 'ghidra', 'hopper', 'pe 文件']],
  ['设计', ['ui', '界面', '视觉', '配色', '排版', '字体', '样式', 'css']],
  ['博客', ['博客', '站点', '页面', '路由', 'react', 'vite']],
  ['Agent', ['agent', '智能体', 'mcp', 'prompt', '提示词', 'skill', '技能']],
  ['办公', ['word', 'excel', 'docx', 'xlsx', 'office']],
  ['机器人', ['qq', '机器人', 'astrbot', 'bot', '消息']],
  ['安全', ['证书', 'https', '加密', '密钥', '漏洞', '防火墙']],
  ['数据', ['sqlite', '数据库', 'json', 'csv', '数据']],
];

function detectTags(text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const [tag, words] of TAG_LEXICON) {
    if (words.some((w) => lower.includes(w))) hits.push(tag);
  }
  return hits.slice(0, 4);
}

// 从工作目录判断项目归属
const PROJECT_RULES = [
  ['个人博客', /个人博客|lingluan|blog/i],
  ['音频模块', /音频模块|aurora|dolby/i],
  ['学习通', /学习通|chaoxing|xuexitong/i],
  ['Atlas', /atlas|win11|25h2/i],
];

function detectProject(directory, title) {
  const hay = `${directory || ''} ${title || ''}`;
  for (const [name, re] of PROJECT_RULES) {
    if (re.test(hay)) return name;
  }
  return '';
}

// 大类只有两类：属于技术项目的算「编程」，独立文书写作算「论文」
function detectCategory(project, title, summary) {
  if (project) return '编程';
  const hay = `${title} ${summary}`;
  if (/论[文述]|演讲|竞选|答辩|文书|研究|综述|写作|口语化|讲稿/.test(hay)) return '论文';
  return '编程';
}

// 过滤掉粘贴进来的提示词、文档结构和无实质内容的片段
function isJunk(text) {
  const u = String(text || '');
  if (clean(u).length < 8) return true;
  if (/^\s*(name|description|license|allowed-tools|version)\s*:/im.test(u)) return true;
  if (/SKILL\.md|frontmatter|---\s*\n\s*name:/i.test(u)) return true;
  const structureMarks = (u.match(/^\s*[#|>]/gm) || []).length;
  if (structureMarks >= 6) return true;
  if ((u.match(/[`]{3}/g) || []).length >= 2) return true;
  return false;
}

function clean(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<inbox[\s\S]*?<\/inbox>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]{0,200}`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[desktop-send\]/gi, ' ')
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text, max = 46) {
  const t = clean(text);
  if (!t) return '';
  // 跳过以符号或代码开头的碎片，找第一句像人话的
  const pieces = t.split(/[。！？\n.!?；;]/).map((s) => s.trim()).filter(Boolean);
  const usable = pieces.find((s) => s.length > 5 && /[\u4e00-\u9fa5a-zA-Z]/.test(s)) || pieces[0] || t;
  const s = usable.replace(/^(帮我|请|能不能|可以|麻烦)[，,\s]*/g, '');
  const out = s.length > max ? s.slice(0, max) + '…' : s;
  return out || t.slice(0, max);
}

function condense(text, max = 180) {
  const t = clean(text);
  if (!t) return '';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// 从助手的多段回复里挑出最像「结论」的那一句
function keySentence(texts, max = 160) {
  if (!texts.length) return '';
  const all = clean(texts.join(' '));
  const sentences = all
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10 && /[\u4e00-\u9fa5a-zA-Z]/.test(s));
  if (!sentences.length) return condense(all, max);

  const scored = sentences.map((s) => {
    let score = 0;
    if (/完成|搞定|已(经)?(配置|部署|安装|修复|改好|上线|生效)|结论|结果是|总结|现在可以|这样一来|关键(在|是)/.test(s)) score += 4;
    if (/问题(在|出在)|原因(是|在于)|原来是/.test(s)) score += 3;
    if (/失败|报错|不行|错误/.test(s)) score += 1;
    score += Math.min(2, s.length / 70);
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].s;
  return best.length > max ? best.slice(0, max) + '…' : best;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

// ---------- 读取 ----------

if (!fs.existsSync(DB_PATH)) {
  console.error('找不到 MiMo 数据库:', DB_PATH);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

let state = { lastAck: {}, synced: [] };
if (fs.existsSync(STATE_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch { /* 从空状态开始 */ }
}
const syncedSet = new Set(state.synced || []);

const sessions = db.prepare('SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_created ASC').all();
console.log(`会话 ${sessions.length} 场`);

const partStmt = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC');
const msgStmt = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC');

const episodes = [];

for (const session of sessions) {
  const messages = msgStmt.all(session.id);
  const roleById = new Map();
  for (const m of messages) {
    let role = 'unknown';
    try {
      role = JSON.parse(m.data).role || 'unknown';
    } catch { /* ignore */ }
    roleById.set(m.id, role);
  }

  const parts = partStmt.all(session.id);
  // 把片段按消息归组，保留顺序
  const byMessage = new Map();
  for (const p of parts) {
    let data;
    try {
      data = JSON.parse(p.data);
    } catch {
      continue;
    }
    if (!byMessage.has(p.message_id)) byMessage.set(p.message_id, []);
    byMessage.get(p.message_id).push(data);
  }

  let current = null;
  for (const m of messages) {
    const role = roleById.get(m.id);
    const chunks = byMessage.get(m.id) || [];
    const texts = chunks.filter((c) => c.type === 'text' && c.text).map((c) => c.text);
    const tools = chunks.filter((c) => c.type === 'tool' || c.tool).map((c) => c.tool || c.name || 'tool');

    if (role === 'user') {
      if (current) episodes.push(current);
      const said = texts.map(clean).filter((t) => t.length > 2).join(' ');
      current = {
        sessionId: session.id,
        sessionTitle: session.title,
        sessionDir: session.directory,
        startedAt: m.id ? Date.parse(String(m.id).slice(4, 17)) || session.time_created : session.time_created,
        userText: said,
        assistantTexts: [],
        tools: new Set(),
        messageId: m.id,
      };
    } else if (current) {
      for (const t of texts) {
        const c = clean(t);
        if (c.length > 20) current.assistantTexts.push(c);
      }
      for (const t of tools) current.tools.add(String(t));
    }
  }
  if (current) episodes.push(current);
}

console.log(`切出 ${episodes.length} 个记忆片段`);

// ---------- 提炼 ----------

function buildEpisode(ep) {
  const userText = ep.userText || '';
  if (isJunk(userText)) return null; // 粘贴的提示词、文档结构不算记忆

  const title = firstSentence(userText, 34) || ep.sessionTitle || '未命名片段';
  const lastAssistant = ep.assistantTexts.length ? ep.assistantTexts[ep.assistantTexts.length - 1] : '';
  const summary = keySentence(ep.assistantTexts) || condense(userText, 150);
  // 标签只从标题和摘要判断，避免整段关键词造成误判
  let tags = detectTags(`${title} ${summary.slice(0, 200)}`);
  if (!tags.length) tags = detectTags(ep.sessionTitle || '');
  if (!tags.length) tags = ['日常'];

  const project = detectProject(ep.sessionDir, ep.sessionTitle);
  const category = detectCategory(project, title, summary);

  const toolList = [...ep.tools].slice(0, 8);
  const weight = Math.min(2.6, 0.6 + Math.log1p(userText.length) / 3 + (toolList.length ? 0.3 : 0));

  return {
    uidHint: ep.messageId,
    title,
    summary,
    tags,
    category,
    project,
    sessionId: ep.sessionId,
    sessionTitle: ep.sessionTitle,
    tools: toolList,
    createdAt: new Date(ep.startedAt || Date.now()).toISOString(),
    weight: Number(weight.toFixed(2)),
    userText: condense(userText, 600),
    assistantText: condense(lastAssistant, 600),
  };
}

const built = episodes.map(buildEpisode).filter(Boolean);
const fresh = built.filter((e) => FULL || !syncedSet.has(e.uidHint));
console.log(`待同步 ${fresh.length} 条（已同步 ${built.length - fresh.length} 条）`);

if (DRY) {
  for (const e of fresh.slice(0, 10)) {
    console.log(`\n[${e.createdAt.slice(0, 10)}] ${e.title}`);
    console.log(`  标签: ${e.tags.join('、')}  工具: ${e.tools.join(', ') || '—'}`);
    console.log(`  摘要: ${e.summary.slice(0, 90)}`);
  }
  if (fresh.length > 10) console.log(`\n…… 还有 ${fresh.length - 10} 条`);
  process.exit(0);
}

// ---------- 落盘 ----------

fs.mkdirSync(MD_DIR, { recursive: true });

function toMarkdown(e) {
  const lines = [
    `# ${e.title}`,
    '',
    `- 时间：${fmtTime(Date.parse(e.createdAt))}`,
    `- 分类：${e.category}${e.project ? ' · ' + e.project : ''}`,
    `- 会话：${e.sessionTitle || e.sessionId}`,
    `- 标签：${e.tags.join('、')}`,
    `- 权重：${e.weight}`,
    '',
    '## 当时想要什么',
    '',
    e.userText || '（无）',
    '',
    '## 最后的结果',
    '',
    e.assistantText || '（无）',
  ];
  if (e.tools.length) {
    lines.push('', '## 用到的工具', '', e.tools.map((t) => `- ${t}`).join('\n'));
  }
  lines.push('', '---', '', `<!-- neuron:${e.uidHint} session:${e.sessionId} -->`, '');
  return lines.join('\n');
}

const sessionFile = new Map();
let written = 0;
for (const e of fresh) {
  const dir = path.join(MD_DIR, safeName(e.category), safeName(e.project || '未归类'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = fmtTime(Date.parse(e.createdAt)).replace(/[: ]/g, '-');
  const file = path.join(dir, `${stamp}-${safeName(e.title).slice(0, 24)}.md`);
  fs.writeFileSync(file, toMarkdown(e), 'utf8');
  written += 1;
  if (!sessionFile.has(e.sessionId)) sessionFile.set(e.sessionId, []);
  sessionFile.get(e.sessionId).push(path.basename(file));
}
console.log(`写入 ${written} 个 .md 文件到 ${MD_DIR}`);

// ---------- 同步到神经元 ----------

if (TOKEN) {
  let ok = 0;
  let fail = 0;
  for (const e of fresh) {
    try {
      const res = await fetch(`${API}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          title: e.title,
          summary: e.summary,
          tags: e.tags,
          category: e.category,
          project: e.project,
          sessionId: e.sessionId,
          kind: e.tools.length ? 'tool' : 'dialog',
          weight: e.weight,
          createdAt: e.createdAt,
        }),
      });
      if (res.ok) {
        ok += 1;
        syncedSet.add(e.uidHint);
      } else fail += 1;
    } catch {
      fail += 1;
    }
  }
  console.log(`同步成功 ${ok} 条，失败 ${fail} 条`);

  state.synced = [...syncedSet];
  state.lastSync = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
} else {
  console.log('未设置 NEURAL_TOKEN，仅生成 md 文件');
}

db.close();