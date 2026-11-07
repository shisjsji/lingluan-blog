#!/usr/bin/env node
// 会话上传器
//
// 早先这个脚本用正则把对话切成碎片、截断用户原话当标题，产出的是聊天记录而不是总结。
// 现在它只做一件事：把每个会话整理成一段完整对话文本，传给服务器，由云端模型总结。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.USERPROFILE || process.env.HOME;
const DB_PATH = process.env.MIMO_DB || path.join(HOME, '.local/share/mimocode/mimocode.db');
const API = process.env.NEURAL_API || 'https://lingluandf.online/neural-api';
const STATE_PATH = path.join(HOME, '.local/share/mimocode/upload-state.json');
const TOKEN = process.env.NEURAL_TOKEN || (() => {
  try { return fs.readFileSync(path.join(HOME, '.neural-token'), 'utf8').trim(); } catch { return ''; }
})();

const PROJECT_RULES = [
  ['lingluan-blog', /个人博客|lingluan|blog/i],
  ['chaoxing-ai', /学习通|chaoxing|xuexitong|超星/i],
  ['aurora', /音频模块|aurora|dolby/i],
  ['neural-memory', /记忆|神经元|neural/i],
];

function detectProject(directory, title) {
  const hay = `${directory || ''} ${title || ''}`;
  for (const [id, re] of PROJECT_RULES) if (re.test(hay)) return id;
  return '';
}

function clean(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<inbox[\s\S]*?<\/inbox>/gi, '')
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/\s+/g, ' ')
    .trim();
}

if (!fs.existsSync(DB_PATH)) { console.error('找不到数据库:', DB_PATH); process.exit(1); }

// 只截开头会把长对话的结论整段丢掉，而结论正是要记的东西。
// 超长时留开头加结尾，中间省略——开头是最初的目标，结尾是最后成立的结论。
const MAX_RAW = 60000;
const HEAD_CHARS = 16000;

function excerpt(text) {
  if (text.length <= MAX_RAW) return text;
  const tailChars = MAX_RAW - HEAD_CHARS - 40;
  const skipped = Math.round((text.length - HEAD_CHARS - tailChars) / 1000);
  return `${text.slice(0, HEAD_CHARS)}\n\n[中间省略约 ${skipped}k 字]\n\n${text.slice(-tailChars)}`;
}

let state = {};
if (fs.existsSync(STATE_PATH)) {
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { state = {}; }
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const sessions = db.prepare('SELECT id, title, directory, time_created FROM session ORDER BY time_created ASC').all();
const msgStmt = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC');
const partStmt = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC');

const payloads = [];

for (const session of sessions) {
  const messages = msgStmt.all(session.id);
  if (messages.length < 2) continue;

  const roles = new Map();
  for (const m of messages) {
    try { roles.set(m.id, JSON.parse(m.data).role || 'unknown'); } catch { roles.set(m.id, 'unknown'); }
  }

  const partsByMessage = new Map();
  for (const part of partStmt.all(session.id)) {
    let data;
    try { data = JSON.parse(part.data); } catch { continue; }
    if (data.type !== 'text' || !data.text) continue;
    if (!partsByMessage.has(part.message_id)) partsByMessage.set(part.message_id, []);
    partsByMessage.get(part.message_id).push(data.text);
  }

  const lines = [];
  for (const m of messages) {
    const role = roles.get(m.id);
    if (role !== 'user' && role !== 'assistant') continue;
    const said = (partsByMessage.get(m.id) || []).map(clean).filter((t) => t.length > 2).join(' ');
    if (!said) continue;
    lines.push(`${role === 'user' ? '用户' : '助手'}：${said.slice(0, 1200)}`);
  }

  const raw = lines.join('\n\n');
  if (raw.length < 200) continue; // 寒暄太短的会话不值得总结

  const signature = String(messages.length) + ':' + raw.length;
  if (state[session.id] === signature) continue; // 没有新内容，跳过

  payloads.push({
    id: session.id,
    title: session.title || '',
    project: detectProject(session.directory, session.title),
    raw: excerpt(raw),
    messageCount: messages.length,
    signature,
  });
}

db.close();

console.log(`会话 ${sessions.length} 场，需要上传 ${payloads.length} 场`);
if (!payloads.length) process.exit(0);
if (!TOKEN) { console.error('缺少令牌'); process.exit(1); }

// 分批，避免单次请求过大
const BATCH = 3;
let uploaded = 0;
for (let i = 0; i < payloads.length; i += BATCH) {
  const batch = payloads.slice(i, i + BATCH);
  try {
    const res = await fetch(`${API}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(batch.map(({ signature, ...rest }) => rest)),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (data.ok) {
      uploaded += data.saved || 0;
      for (const item of batch) state[item.id] = item.signature;
    } else {
      console.error('上传被拒:', data.error);
    }
  } catch (err) {
    console.error('上传失败:', err.message);
  }
}

fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1), 'utf8');
console.log(`已上传 ${uploaded} 场，等待服务器用模型总结`);