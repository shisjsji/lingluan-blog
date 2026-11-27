// 公开稿独立保存。重新同步或总结原始会话不会改动已经发布的内容。
const initialEntries = [
  ['blog-paper', '个人博客', '2026-11-04', 'Agent 论文独立成页', '把个人学习中的 Agent 协作分成问题建模、分步执行和结果复盘三个部分。', ['Agent 协作'], '/#/paper'],
  ['blog-neural', '个人博客', '2026-11-04', '博客加入神经元星图', '将智能体协作中留下的项目记录放进一个可探索的星图。', ['Agent 协作'], '/#/neural'],
  ['blog-guestbook', '个人博客', '2026-11-05', '留言板开放免登录留言', '访客可以在博客直接留言，站长在后台管理公开留言。', ['访客互动'], '/#/guestbook'],
  ['aurora-listing', 'AURORA', '2026-11-09', '项目页更新 AURORA v1.2.3', '博客项目页记录了 AURORA v1.2.3。这个 Android 模块为正在播放的音轨叠加六段均衡。', ['Android 音频'], '/#/projects'],
  ['chaoxing-392', '超星学习通插件', '2026-11-26', '超星 AI 桌面客户端 3.9.2', '超星 AI 官网提供 Windows 3.9.2 安装包。项目包含自动播放、AI 答题与共享题库。', ['Windows 客户端', '共享题库'], 'https://chaoxingxxt.lingluandf.online/'],
];

export function atlasProject(project, title = '') {
  const value = project.trim();
  const learning = /^(?:学习通|超星(?:学习通)?|(?:超星)?学习通(?:学习)?插件|chaoxing[-_ ]?ai|xuexitong)$/iu;
  const generic = !value || /^(?:general|其他|杂项|未归类)$/iu.test(value);
  if (learning.test(value) || (generic && /学习通(?:学习)?插件|超星学习通|chaoxing-ai/iu.test(title))) return '超星学习通插件';
  if (/^lingluan-blog$/iu.test(value)) return '个人博客';
  if (/^aurora$/iu.test(value)) return 'AURORA';
  return generic ? '未归类' : value;
}

function toEntry(row) {
  return {
    id: row.id, project: row.project, date: row.event_date, title: row.title,
    summary: row.summary, topics: JSON.parse(row.topics), href: row.href,
  };
}

export function createAtlas(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS atlas_entries (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT '',
      project TEXT NOT NULL,
      event_date TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      topics TEXT NOT NULL,
      href TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 0
    );
  `);
  const seed = db.prepare(`
    INSERT OR IGNORE INTO atlas_entries (id, project, event_date, title, summary, topics, href, published)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const [id, project, date, title, summary, topics, href] of initialEntries) {
    seed.run(id, project, date, title, summary, JSON.stringify(topics), href);
  }

  const byId = db.prepare('SELECT * FROM atlas_entries WHERE id = ?');
  const save = db.prepare(`
    INSERT INTO atlas_entries (id, source, project, event_date, title, summary, topics, href, published)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET project = excluded.project, event_date = excluded.event_date,
      title = excluded.title, summary = excluded.summary, topics = excluded.topics,
      href = excluded.href, published = excluded.published
  `);

  return {
    published() {
      return db.prepare('SELECT * FROM atlas_entries WHERE published = 1 ORDER BY event_date DESC, id DESC').all().map(toEntry);
    },
    editorial() {
      const entries = db.prepare('SELECT * FROM atlas_entries ORDER BY event_date DESC, id DESC').all()
        .map(row => ({ ...toEntry(row), source: row.source, published: Boolean(row.published) }));
      const candidates = db.prepare(`
        SELECT 'knowledge:' || id AS source, project, title, body AS summary, updated_at AS recorded_at,
          kind, status FROM knowledge
        UNION ALL
        SELECT 'neuron:' || uid, project, title, summary, created_at, kind, '' FROM neurons
        ORDER BY recorded_at DESC
      `).all().map(({ source, project, title, summary, recorded_at, kind, status }) => ({
        source, project: atlasProject(project, title), title, summary, recordedAt: recorded_at, kind, status,
      }));
      return { entries, candidates };
    },
    save(input) {
      const clean = (key, max) => typeof input?.[key] === 'string' ? input[key].trim().slice(0, max) : '';
      const id = clean('id', 64);
      const existing = byId.get(id);
      if (!existing && !/^atlas_[0-9a-f-]{36}$/iu.test(id)) return '记录编号无效';
      const title = clean('title', 100);
      const summary = clean('summary', 1000);
      const project = clean('project', 48);
      if (!title || !summary || !project) return '请填写项目、标题和公开摘要';
      const date = clean('date', 16);
      const timestamp = Date.parse(date);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return '请填写有效的事项日期';
      const href = clean('href', 240);
      const localLink = /^\/#\/(?:about|notes|paper|projects|gallery|guestbook|neural)$/u.test(href);
      const projectLink = /^https:\/\/(?:aurora|chaoxingxxt)\.lingluandf\.online\/$/u.test(href);
      if (href && !localLink && !projectLink) return '请选用博客页面或项目官网作为出处';
      const topics = [...new Set(clean('topics', 180).split(/[,，、]/u).map(value => value.trim().slice(0, 24)).filter(Boolean))].slice(0, 6);
      save.run(id, existing?.source ?? clean('source', 100), atlasProject(project, title), date, title, summary,
        JSON.stringify(topics), href, Number(input.published === true));
      return null;
    },
  };
}
