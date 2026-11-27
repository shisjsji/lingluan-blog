import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { atlasProject, createAtlas } from './atlas.mjs';

test('学习通别名归到同一项目', () => {
  for (const name of ['学习通', '超星学习通学习插件', 'chaoxing-ai', 'xuexitong']) {
    assert.equal(atlasProject(name), '超星学习通插件');
  }
  assert.equal(atlasProject('general', '完善学习通插件'), '超星学习通插件');
  assert.equal(atlasProject('AURORA', '另一次讨论中提到学习通插件'), 'AURORA');
});

test('公开稿和旧记录独立，撤下和重复发布可安全重试', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE knowledge (id INTEGER, project TEXT, title TEXT, body TEXT, updated_at TEXT, kind TEXT, status TEXT);
      CREATE TABLE neurons (uid TEXT, project TEXT, title TEXT, summary TEXT, created_at TEXT, kind TEXT);
      INSERT INTO knowledge VALUES (1, 'chaoxing-ai', '项目原记录', '私有摘要', '2026-11-12', 'progress', 'active');
      INSERT INTO neurons VALUES ('n_1', '学习通', '旧星点', '另一份私有摘要', '2026-11-09', 'insight');
    `);
    const atlas = createAtlas(db);
    const { entries, candidates } = atlas.editorial();
    assert.equal(entries.length, 5);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(item => item.project === '超星学习通插件'));
    const draft = {
      id: 'atlas_12345678-1234-4321-8765-123456789012', source: 'knowledge:1',
      project: '学习通', date: '2026-11-12', title: '公开记录', summary: '编辑后的摘要', topics: '联调，联调',
    };
    assert.ok(atlas.save({ ...draft, date: '2026-02-30' }));
    assert.equal(atlas.save(draft), null);
    assert.ok(!atlas.published().some(entry => entry.id === draft.id));

    const published = { ...draft, published: true };
    assert.equal(atlas.save(published), null);
    assert.equal(atlas.save(published), null);
    const matches = atlas.published().filter(entry => entry.id === draft.id);
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].topics, ['联调']);
    assert.ok(!('source' in matches[0]));
    assert.ok(!JSON.stringify(atlas.published()).includes('私有摘要'));

    assert.equal(atlas.save(draft), null);
    assert.ok(!createAtlas(db).published().some(entry => entry.id === draft.id));
    assert.deepEqual(atlas.editorial().candidates, candidates);
  } finally {
    db.close();
  }
});
