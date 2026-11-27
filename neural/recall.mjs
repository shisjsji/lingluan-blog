// 四臂召回：词法 / 激活 / 图扩散 / 画像
//
// 移植自 yb-zhai/agent-memory 的 memory/recall.cjs（MIT），按本项目的知识库结构改写：
//   ① lexical    query 词元倒排 → 中文 bigram TF-IDF 余弦，取 top 40
//   ② activation A(v) = importance · exp(-Δt/S)，取 top 12
//   ③ graph      词法臂前若干条做 2 跳扩散，A(v) = MAX ∏(w^α · γ^hop) · seed，α=1.0、γ=0.55
//   ④ profile    preference 类（他的习惯）按 importance 恒入选
// 融合：final = 0.55·lexNorm + 0.30·actNorm + 0.15·recencyR
// 去冗余：token 重叠 MMR（λ=0.7，相似度 > 0.85 的后选者降权）
//
// 与原版差异（都在注释里写明原因）：
//   - 没有持久化的 importance 字段，按 kind 推导；preference 视作置顶永固（S=∞）。
//   - 没有显式边表，图扩散用「标签 Jaccard + 同项目弱边」现算，数据量在千条内足够。
//   - 只返回摘要级字段，不回正文，接口可以对外开放。

const WEIGHTS = Object.freeze({ lexical: 0.55, activation: 0.30, recency: 0.15 });

const PARAMS = Object.freeze({
  lexTop: 40,
  actTop: 12,
  graphSeeds: 8,
  graphTop: 24,
  profileTop: 3,
  hops: 2,
  alpha: 1.0,
  gamma: 0.55,
  mmrLambda: 0.7,
  mmrThreshold: 0.85,
  minEdge: 0.12,
});

// 按 kind 给的初始重要性和半衰期（天）。preference 是「他的习惯」，永不过期。
const KIND_TRAIT = Object.freeze({
  preference: { importance: 1.0, halfLife: Infinity },
  pitfall: { importance: 0.85, halfLife: 45 },
  decision: { importance: 0.80, halfLife: 60 },
  insight: { importance: 0.75, halfLife: 60 },
  progress: { importance: 0.52, halfLife: 14 },
  output: { importance: 0.50, halfLife: 30 },
});

const STOP = new Set('的了呢吗吧啊么什怎呀哦嗯这那哪个是不有要能会就都也还再去来对说着过把被给让从到和与及而但所以为如果很太更最'.split(''));

// 查询里的疑问/语气词先剥掉。中文没有分词器时，「怎么做的」会被切成「计怎/么做/做的」，
// 这些 bigram 会把「下载统计」这种真正的意图冲淡（实测过）。
const QUERY_NOISE = /(怎么|如何|为什么|为啥|什么|哪些|哪个|怎么弄|怎样|是不是|有没有|能不能|要不要|请问|帮我|一下|呢|吗|吧|啊|的|了)/g;

function cleanQuery(text) {
  return String(text || '').replace(QUERY_NOISE, ' ').replace(/\s+/g, ' ').trim();
}
// ---------- 分词：中文 bigram + 单字兜底 + ASCII 词 ----------
function tokenize(text, opts = {}) {
  const minCjk = opts.minCjk || 1;
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .toLowerCase();
  const out = new Map(); // token -> count

  const RE_CJK = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
  let m;
  while ((m = RE_CJK.exec(s)) !== null) {
    const run = m[0];
    if (run.length === 1) {
      if (!STOP.has(run) && minCjk <= 1) out.set(run, (out.get(run) || 0) + 1);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bi = run.slice(i, i + 2);
      // 两头都是虚词的 bigram 基本是噪音
      if (STOP.has(bi[0]) && STOP.has(bi[1])) continue;
      out.set(bi, (out.get(bi) || 0) + 1);
    }
    // 2~4 字整词命中更准，额外留一份
    if (run.length >= 2 && run.length <= 4) out.set(run, (out.get(run) || 0) + 1);
  }

  const ascii = s.replace(/[\u3400-\u4dbf\u4e00-\u9fff]+/g, ' ');
  for (const w of ascii.split(/[^a-z0-9_.+#-]+/)) {
    if (w.length >= 2) out.set(w, (out.get(w) || 0) + 1);
  }
  return out;
}

function docTokens(row) {
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
  // 标题权重通过重复计入实现；标签也计入
  const text = `${row.title || ''} ${row.title || ''} ${row.body || ''} ${tags.join(' ')} ${row.project || ''}`;
  return tokenize(text);
}

// ---------- 图：标签 Jaccard + 同项目弱边 ----------
function buildGraph(rows) {
  const tagsOf = new Map();
  for (const r of rows) {
    let t = [];
    try { t = JSON.parse(r.tags || '[]'); } catch { t = []; }
    tagsOf.set(r.id, new Set(t.map((x) => String(x).toLowerCase())));
  }
  const adj = new Map(rows.map((r) => [r.id, []]));
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      const ta = tagsOf.get(a.id);
      const tb = tagsOf.get(b.id);
      let w = 0;
      if (ta.size && tb.size) {
        let inter = 0;
        for (const t of ta) if (tb.has(t)) inter += 1;
        if (inter) w = inter / (ta.size + tb.size - inter); // Jaccard
      }
      if (!w && a.project && a.project === b.project) w = 0.12; // 同项目弱边
      if (w >= PARAMS.minEdge) {
        adj.get(a.id).push([b.id, w]);
        adj.get(b.id).push([a.id, w]);
      }
    }
  }
  return adj;
}

// ---------- 2 跳扩散：A(v) = MAX over paths ∏(w^α · γ^hop) · seed ----------
function spread(adj, seeds) {
  const best = new Map();
  let frontier = seeds;
  for (let hop = 1; hop <= PARAMS.hops; hop += 1) {
    const next = new Map();
    for (const [id, act] of frontier) {
      for (const [neighbor, w] of adj.get(id) || []) {
        if (seeds.has(neighbor)) continue;
        const gain = act * Math.pow(w, PARAMS.alpha) * Math.pow(PARAMS.gamma, hop);
        if (!best.has(neighbor) || best.get(neighbor).act < gain) {
          best.set(neighbor, { act: gain, hop, via: id, seed: seeds.get(id) || act });
        }
        if (!next.has(neighbor) || next.get(neighbor) < gain) next.set(neighbor, gain);
      }
    }
    frontier = next;
    if (!frontier.size) break;
  }
  return best;
}

function daysSince(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 999;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function norm(map) {
  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  const out = new Map();
  for (const [k, v] of map) out.set(k, max > 0 ? v / max : 0);
  return out;
}

/**
 * @param {Array} rows  knowledge 表行（status != dropped）
 * @param {string} query
 * @param {object} [opts]
 * @returns {{items:Array, trace:object}}
 */
export function recall(rows, query, opts = {}) {
  const weights = { ...WEIGHTS, ...(opts.weights || {}) };
  const started = process.hrtime.bigint();
  const q = String(query || '').trim();

  const byId = new Map(rows.map((r) => [r.id, r]));
  const tokens = rows.map((r) => ({ id: r.id, tf: docTokens(r) }));

  // ---- ① 词法臂 ----
  const df = new Map();
  for (const { tf } of tokens) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = tokens.length || 1;
  const idf = (t) => Math.log(1 + N / (df.get(t) || 1));

  const qClean = cleanQuery(q);
  const qTokens = tokenize(qClean, { minCjk: 2 });
  const lexAll = new Map();
  const lexHits = new Map(); // id -> 命中的词
  if (qTokens.size) {
    let qWeight = 0;
    for (const [t, c] of qTokens) qWeight += (1 + Math.log(c)) * idf(t);
    for (const { id, tf } of tokens) {
      let dot = 0;
      let docWeight = 0;
      const hits = [];
      for (const [t, c] of tf) {
        const w = (1 + Math.log(c)) * idf(t);
        docWeight += w * w;
        if (qTokens.has(t)) {
          dot += w * (1 + Math.log(qTokens.get(t))) * idf(t);
          hits.push(t);
        }
      }
      if (dot > 0) {
        // 覆盖率：命中的查询词元比例。短中文查询里单个虚词就能把余弦顶满，
        // 按覆盖率打折后，「只擦到一个边」的条目不会再排第一（实测「做」「不用」都踩过）。
        const coverage = hits.length / qTokens.size;
        const score = (dot / (Math.sqrt(docWeight) * Math.sqrt(qWeight) || 1)) * Math.pow(coverage, 0.6);
        lexAll.set(id, score);
        lexHits.set(id, hits);
      }
    }
  }
  const lexTop = [...lexAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, PARAMS.lexTop);

  // ---- ② 激活臂 ----
  const actAll = new Map();
  for (const r of rows) {
    const trait = KIND_TRAIT[r.kind] || { importance: 0.5, halfLife: 30 };
    const dt = daysSince(r.updated_at || r.created_at);
    const rho = trait.halfLife === Infinity ? 1 : Math.pow(0.5, dt / trait.halfLife);
    actAll.set(r.id, trait.importance * rho);
  }
  const actTop = [...actAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, PARAMS.actTop);

  // ---- ③ 图扩散臂 ----
  const adj = buildGraph(rows);
  const seeds = new Map(lexTop.slice(0, PARAMS.graphSeeds).map(([id, s]) => [id, s]));
  const graphAll = spread(adj, seeds);
  const graphTop = [...graphAll.entries()].sort((a, b) => b[1].act - a[1].act).slice(0, PARAMS.graphTop);

  // ---- ④ 画像臂：他的习惯恒定入选 ----
  const profile = rows
    .filter((r) => r.kind === 'preference')
    .map((r) => [r.id, actAll.get(r.id) || 1])
    .sort((a, b) => b[1] - a[1])
    .slice(0, PARAMS.profileTop);

  // ---- 融合 ----
  // 注意：激活臂不能归一化。原版 A(v)=importance·exp(-Δt/S) 本身就是 0..1 的绝对量，
  // 归一化会让「importance=1 的偏好」恒定拿满分，把真正的词法命中压下去（实测过）。
  // 词法分用饱和映射：raw/(raw+0.12)。既不像「按最大值归一」那样把弱匹配顶到 1.0，
  // 也不像原始余弦那样小到（0.02~0.1）被 0.45 的偏好项全面盖住。
  const lexN = new Map(lexTop.map(([id, raw]) => [id, raw / (raw + 0.12)]));
  const graphN = norm(new Map(graphTop.map(([id, v]) => [id, v.act])));
  const recencyN = norm(new Map(rows.map((r) => [r.id, Math.exp(-daysSince(r.updated_at || r.created_at) / 60)])));

  const final = new Map();
  const arms = new Map();
  const consider = new Set([
    ...lexTop.map(([id]) => id),
    ...actTop.map(([id]) => id),
    ...graphTop.map(([id]) => id),
    ...profile.map(([id]) => id),
  ]);
  for (const id of consider) {
    const lex = lexN.get(id) || 0;
    const act = actAll.get(id) || 0;          // 绝对激活量，不归一
    const graph = graphN.get(id) || 0;
    const rec = recencyN.get(id) || 0;
    // 图臂并入激活臂：扩散到的节点按自身 importance 打折，避免无关节点凭空得高分
    const trait = KIND_TRAIT[byId.get(id)?.kind] || { importance: 0.5 };
    const actCombined = Math.max(act, graph * trait.importance);
    const score = weights.lexical * lex + weights.activation * actCombined + weights.recency * rec;
    final.set(id, score);
    arms.set(id, {
      lex: Number(lex.toFixed(4)),
      act: Number(act.toFixed(4)),
      graph: Number(graph.toFixed(4)),
      recency: Number(rec.toFixed(4)),
      hop: graphAll.get(id)?.hop ?? null,
      via: graphAll.get(id)?.via ?? null,
      seeds: lexHits.get(id) || [],
      matched: (lexHits.get(id) || []).slice(0, 8),
    });
  }
  // 画像臂的条目保证上榜
  for (const [id] of profile) if (!final.has(id)) final.set(id, 0.2);

  // ---- MMR 去冗余 ----
  const picked = [];
  const dropped = [];
  const pool = [...final.entries()].sort((a, b) => b[1] - a[1]);
  for (const [id, score] of pool) {
    if (picked.length >= (opts.limit || 12)) break;
    const tf = tokens.find((t) => t.id === id)?.tf;
    let redundant = false;
    for (const p of picked) {
      const prev = tokens.find((t) => t.id === p.id)?.tf;
      if (!tf || !prev) continue;
      let inter = 0;
      for (const t of tf.keys()) if (prev.has(t)) inter += 1;
      const union = tf.size + prev.size - inter;
      const sim = union ? inter / union : 0;
      if (sim > PARAMS.mmrThreshold) { redundant = true; break; }
    }
    if (redundant) { dropped.push({ id, score: Number(score.toFixed(4)) }); continue; }
    picked.push({ id, score });
  }

  const items = picked.map(({ id, score }, index) => {
    const r = byId.get(id);
    return {
      id,
      rank: index + 1,
      score: Number(score.toFixed(4)),
      title: r.title,
      kind: r.kind,
      project: r.project || '',
      tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
      updatedAt: r.updated_at,
      arms: arms.get(id) || null,
    };
  });

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    items,
    trace: {
      query: q,
      cleaned: qClean,
      tokens: [...qTokens.keys()].slice(0, 30),
      weights,
      params: { lexTop: PARAMS.lexTop, actTop: PARAMS.actTop, graphSeeds: PARAMS.graphSeeds, graphTop: PARAMS.graphTop, hops: PARAMS.hops, gamma: PARAMS.gamma, mmrLambda: PARAMS.mmrLambda },
      counts: {
        corpus: rows.length,
        lexical: lexTop.length,
        activation: actTop.length,
        graph: graphTop.length,
        profile: profile.length,
        considered: consider.size,
        returned: items.length,
        droppedByMmr: dropped.length,
      },
      dropped,
      ms: Number(ms.toFixed(2)),
    },
  };
}

export const RECALL_META = { WEIGHTS, PARAMS, KIND_TRAIT };
