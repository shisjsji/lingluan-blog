#!/usr/bin/env node
// 轻量博客后台：内容编辑 + 图片上传 + 一键发布
// 仅监听 127.0.0.1，由 nginx 反代到 /admin/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT || 3001);
const BLOG = process.env.BLOG_DIR || '/opt/blog';
const CONTENT_DIR = path.join(BLOG, 'src', 'content');
const UPLOAD_DIR = path.join(BLOG, 'public', 'images', 'gallery');
const SITE_FILE = path.join(CONTENT_DIR, 'site-content.json');
const GALLERY_FILE = path.join(CONTENT_DIR, 'gallery.json');
const SESSION_TTL = 1000 * 60 * 60 * 8;
const sessions = new Map();

// 登录失败限制：同一来源连续 5 次失败锁 10 分钟
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILS = 5;
const loginAttempts = new Map();

const PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();
const NEURAL_API = (process.env.NEURAL_API || 'http://127.0.0.1:3002/neural-api').trim();
const NEURAL_TOKEN = (process.env.NEURAL_TOKEN || '').trim();
if (!PASSWORD_HASH) {
  console.error('缺少环境变量 ADMIN_PASSWORD_HASH（密码的 sha256）');
  process.exit(1);
}

const publishState = { running: false, last: null, log: '' };

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  const sid = parseCookies(req).sid;
  const session = sid ? sessions.get(sid) : null;
  if (!session) return false;
  if (Date.now() - session.at > SESSION_TTL) {
    sessions.delete(sid);
    return false;
  }
  session.at = Date.now();
  return true;
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, code, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendFile(res, file, type) {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    sendJSON(res, 404, { ok: false, error: '文件不存在' });
  }
}

function runPublish() {
  if (publishState.running) return;
  publishState.running = true;
  publishState.log = '';
  const cmd = `cd ${BLOG} && pnpm build 2>&1 && rsync -a --delete dist/ /var/www/lingluan-blog/ 2>&1`;
  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    publishState.running = false;
    publishState.last = {
      ok: !err,
      at: new Date().toISOString(),
      output: (stdout + stderr).slice(-2000),
    };
    publishState.log = publishState.last.output;
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (p === '/' || p === '/admin' ) {
    res.writeHead(302, { Location: '/admin/' });
    res.end();
    return;
  }

  if (p === '/admin/' || p === '/admin/index.html') {
    sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (p === '/admin/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (rec && rec.until > now) {
      sendJSON(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' });
      return;
    }

    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { sendJSON(res, 400, { ok: false }); return; }
    const guess = String(payload.password || '');
    if (sha256(guess) === PASSWORD_HASH) {
      loginAttempts.delete(ip);
      const sid = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, { at: Date.now() });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `sid=${sid}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      const count = (rec ? rec.count : 0) + 1;
      loginAttempts.set(ip, { count, until: count >= MAX_LOGIN_FAILS ? now + LOGIN_LOCK_MS : 0 });
      sendJSON(res, 401, { ok: false, error: '密码不对' });
    }
    return;
  }

  if (p === '/admin/api/me') {
    sendJSON(res, isAuthed(req) ? 200 : 401, { ok: isAuthed(req) });
    return;
  }

  if (p === '/admin/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) sessions.delete(sid);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'sid=; Path=/admin; HttpOnly; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 以下接口需要登录
  if (!isAuthed(req)) {
    sendJSON(res, 401, { ok: false, error: '未登录' });
    return;
  }


  // ---- 留言管理：读到本服务，删除转发给神经 API ----
  if (p === '/admin/api/messages' && req.method === 'GET') {
    try {
      const r = await fetch(`${NEURAL_API}/messages?limit=100`);
      const d = await r.json();
      sendJSON(res, 200, d);
    } catch (err) {
      sendJSON(res, 502, { ok: false, error: '读不到留言：' + err.message });
    }
    return;
  }

  if (p.startsWith('/admin/api/messages/') && req.method === 'DELETE') {
    const id = Number(p.slice('/admin/api/messages/'.length));
    if (!Number.isInteger(id) || id <= 0) {
      sendJSON(res, 400, { ok: false, error: 'id 不对' });
      return;
    }
    if (!NEURAL_TOKEN) {
      sendJSON(res, 500, { ok: false, error: '服务端缺少 NEURAL_TOKEN' });
      return;
    }
    try {
      const r = await fetch(`${NEURAL_API}/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${NEURAL_TOKEN}` },
      });
      const d = await r.json();
      sendJSON(res, r.status, d);
    } catch (err) {
      sendJSON(res, 502, { ok: false, error: '删除失败：' + err.message });
    }
    return;
  }

  if (p === '/admin/api/content' && req.method === 'GET') {
    sendJSON(res, 200, {
      ok: true,
      site: readJSON(SITE_FILE, {}),
      gallery: readJSON(GALLERY_FILE, []),
    });
    return;
  }

  if (p === '/admin/api/content' && req.method === 'POST') {
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { sendJSON(res, 400, { ok: false, error: 'JSON 格式错误' }); return; }
    if (!payload.site || !payload.gallery) { sendJSON(res, 400, { ok: false, error: '缺少 site 或 gallery' }); return; }
    writeJSON(SITE_FILE, payload.site);
    writeJSON(GALLERY_FILE, payload.gallery);
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (p === '/admin/api/upload' && req.method === 'POST') {
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { sendJSON(res, 400, { ok: false }); return; }
    const name = String(payload.name || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (!/^[a-z0-9._-]+\.(jpg|jpeg|png|webp|gif)$/.test(name)) {
      sendJSON(res, 400, { ok: false, error: '文件名只允许小写字母数字和 .jpg/.png/.webp/.gif' });
      return;
    }
    const data = Buffer.from(String(payload.data || ''), 'base64');
    if (!data.length || data.length > 20 * 1024 * 1024) {
      sendJSON(res, 400, { ok: false, error: '图片为空或超过 20MB' });
      return;
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, name), data);
    sendJSON(res, 200, { ok: true, file: name });
    return;
  }

  if (p === '/admin/api/publish' && req.method === 'POST') {
    runPublish();
    sendJSON(res, 200, { ok: true, message: '已开始构建并发布' });
    return;
  }

  if (p === '/admin/api/publish/status') {
    sendJSON(res, 200, { ok: true, running: publishState.running, last: publishState.last });
    return;
  }

  sendJSON(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`admin listening on 127.0.0.1:${PORT}`);
});