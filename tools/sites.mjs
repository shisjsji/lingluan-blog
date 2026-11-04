#!/usr/bin/env node
// 站点清单：数据存 sites.json，渲染成桌面上的 TXT 供人直接看
//
//   node tools/sites.mjs render              重新生成桌面清单
//   node tools/sites.mjs list                在终端列出所有站点
//   node tools/sites.mjs add                 交互式追加（也可直接编辑 json）
//
// 新增站点后一定要跑一次 render，否则桌面的 TXT 不会更新。
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
const DATA = process.env.SITES_JSON || path.join(HOME, '.local/share/mimocode/sites.json');
const OUT = process.env.SITES_TXT || path.join(HOME, 'Desktop', '网站清单.txt');

function load() {
  if (!fs.existsSync(DATA)) {
    console.error('找不到数据文件:', DATA);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function render() {
  const { sites, updatedAt } = load();
  const now = updatedAt ? fmtTime(updatedAt) : fmtTime(new Date().toISOString());
  const line = '='.repeat(52);
  const rows = [];

  rows.push(line);
  rows.push('  凌乱的风 · 网站与账号清单');
  rows.push(`  最后更新：${now}`);
  rows.push(line);
  rows.push('');
  rows.push('  这个文件里有密码，别发给别人，也别放进公共网盘。');
  rows.push('  加新站点：编辑 sites.json 后运行 node tools/sites.mjs render');
  rows.push('');

  sites.forEach((site, i) => {
    rows.push('─'.repeat(52));
    rows.push(`${String(i + 1).padStart(2, '0')}. ${site.name}`);
    rows.push('─'.repeat(52));
    rows.push(`  地址：${site.url}`);
    if (site.what) rows.push(`  说明：${site.what}`);
    for (const extra of site.extras || []) {
      rows.push(`  ${extra.label}：${extra.value}`);
    }
    if (site.tags?.length) rows.push(`  标签：${site.tags.join(' · ')}`);
    rows.push('');
  });

  rows.push(line);
  rows.push(`  共 ${sites.length} 项`);
  rows.push(line);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rows.join('\r\n'), 'utf8');
  console.log(`已生成 ${OUT}（${sites.length} 项）`);
}

function list() {
  const { sites } = load();
  for (const site of sites) {
    console.log(`${site.name.padEnd(18)} ${site.url}`);
    const pw = (site.extras || []).find((e) => e.label.includes('密码'));
    if (pw) console.log(`${''.padEnd(18)} 密码：${pw.value}`);
  }
}

const cmd = process.argv[2] || 'render';
if (cmd === 'render') render();
else if (cmd === 'list') list();
else {
  console.log('用法：node tools/sites.mjs [render|list]');
  process.exit(1);
}