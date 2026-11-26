// 从 nginx 日志统计真实下载量。
//
// 为什么不数「点下载按钮」：点了不等于传完。这里的数字来自 nginx 自己记的 body_bytes_sent，
// 是唯一可信的「服务器确实传出去多少」。没有真实 IP，无法把断点续传的多条 Range 请求
// 合并成「一次下载」，所以只累加字节，由服务端按 字节 ÷ 包大小 折算成整包。
//
// 首次运行会把已有的历史日志（含 .gz 归档）全量补一遍，之后只读新增部分，
// 靠 download_state 里的偏移量保证幂等。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH || '/opt/apps/neural/data/neural.db';
const db = new DatabaseSync(DB_PATH);

const LOGS = [
  '/var/log/nginx/lingluan-blog.access.log',
  '/var/log/nginx/aurora-site.access.log',
  '/var/log/nginx/chaoxing-site.access.log',
];

const FILE_ROOTS = {
  '/dl/': { root: '/opt/apps/chaoxing-lib/releases/', site: 'chaoxing' },
  '/download/': { root: '/opt/apps/aurora/releases/', site: 'aurora' },
  '/aurora/': { root: '/opt/apps/aurora/releases/', site: 'aurora' },
};

function classify(urlPath) {
  const clean = urlPath.split('?')[0];
  if (!/\.(apk|zip)$/i.test(clean)) return null;
  for (const [prefix, info] of Object.entries(FILE_ROOTS)) {
    if (!clean.startsWith(prefix)) continue;
    const name = clean.slice(prefix.length);
    if (!name || name.includes('/')) return null;
    return { site: info.site, file: name, diskPath: path.join(info.root, name) };
  }
  return null;
}

const getState = db.prepare('SELECT offset, inode FROM download_state WHERE logfile = ?');
const putState = db.prepare(`
  INSERT INTO download_state (logfile, offset, inode) VALUES (?, ?, ?)
  ON CONFLICT(logfile) DO UPDATE SET offset = excluded.offset, inode = excluded.inode
`);
const upsertFact = db.prepare(`
  INSERT INTO download_facts (site, file, size, bytes, requests, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(site, file) DO UPDATE SET
    size = CASE WHEN excluded.size > 0 THEN excluded.size ELSE download_facts.size END,
    bytes = download_facts.bytes + excluded.bytes,
    requests = download_facts.requests + excluded.requests,
    updated_at = excluded.updated_at
`);

const now = new Date().toISOString();
let scanned = 0;
let counted = 0;

// 把 nginx 的整形字节数（- 表示 0）转成数字
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function consume(text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    scanned += 1;
    const m = line.match(/"\S+ (\S+) \S+" (\d{3}) (\d+)/);
    if (!m) continue;
    const status = Number(m[2]);
    if (status !== 200 && status !== 206) continue;
    const bytes = toNum(m[3]);
    if (!bytes) continue;
    const info = classify(m[1]);
    if (!info) continue;

    let size = 0;
    try { size = fs.statSync(info.diskPath).size; } catch { size = 0; }

    upsertFact.run(info.site, info.file, size, bytes, 1, now);
    counted += 1;
  }
}

// 找同一个日志的归档：access.log -> access.log.1, access.log.2.gz ...
function rotatedFiles(base) {
  const dir = path.dirname(base);
  const name = path.basename(base);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const siblings = entries
    .filter((f) => f === name || f.startsWith(name + '.'))
    .map((f) => {
      const m = f.match(/\.(\d+)(\.gz)?$/);
      // 当前文件权重最高，编号越大越旧
      const order = f === name ? 9999 : Number(m ? m[1] : 0);
      return { file: path.join(dir, f), order };
    })
    .sort((a, b) => a.order - b.order); // 旧的先读
  return siblings.map((x) => x.file);
}

for (const base of LOGS) {
  let stat;
  try { stat = fs.statSync(base); } catch { continue; }

  const prev = getState.get(base);

  if (!prev) {
    // 首次：把历史全部补进来，然后从当前文件末尾继续
    let backfilled = 0;
    for (const f of rotatedFiles(base)) {
      try {
        if (f.endsWith('.gz')) {
          consume(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
        } else if (f === base) {
          consume(fs.readFileSync(f).toString('utf8'));
        }
      } catch {
        // 单个归档读坏了就跳过，不影响其它
      }
      backfilled += 1;
    }
    putState.run(base, stat.size, String(stat.ino));
    console.log(`${path.basename(base)}: 首次接入，回补 ${backfilled} 个日志文件`);
    continue;
  }

  let offset = Number(prev.offset);
  if (String(prev.inode) !== String(stat.ino) || stat.size < offset) offset = 0;
  if (stat.size <= offset) continue;

  const fd = fs.openSync(base, 'r');
  const length = stat.size - offset;
  const buf = Buffer.allocUnsafe(length);
  const read = fs.readSync(fd, buf, 0, length, offset);
  fs.closeSync(fd);

  const text = buf.subarray(0, read).toString('utf8');
  const lastBreak = text.lastIndexOf('\n');
  if (lastBreak === -1) continue; // 最后一行还没写完
  consume(text.slice(0, lastBreak + 1));
  putState.run(base, offset + read, String(stat.ino));
}

const totals = db.prepare('SELECT site, SUM(bytes) AS b, SUM(requests) AS r FROM download_facts GROUP BY site').all();
console.log(`扫描 ${scanned} 行，计入 ${counted} 条下载请求`);
for (const t of totals) console.log(`  ${t.site}: ${(t.b / 1048576).toFixed(1)} MB, ${t.r} 次请求`);
db.close();
