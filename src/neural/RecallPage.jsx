import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, Radio } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const API = '/neural-api';

const KIND_LABEL = {
  preference: '习惯', pitfall: '坑', decision: '决定',
  insight: '经验', progress: '进度', output: '交付',
};

// 把召回结果摆成星云：分数决定半径（越靠中心越相关），类别决定角度
function layoutPoints(items) {
  const points = new Map();
  const byKind = new Map();
  items.forEach((it) => {
    if (!byKind.has(it.kind)) byKind.set(it.kind, []);
    byKind.get(it.kind).push(it);
  });
  const kinds = [...byKind.keys()];
  kinds.forEach((kind, ki) => {
    const group = byKind.get(kind);
    const baseAngle = (ki / Math.max(1, kinds.length)) * Math.PI * 2;
    group.forEach((it, i) => {
      const r = 0.06 + 0.42 * Math.pow(1 - Math.min(1, it.score), 1.6);
      const a = baseAngle + (i - (group.length - 1) / 2) * 0.22;
      points.set(it.id, {
        x: 0.5 + Math.cos(a) * r,
        y: 0.5 + Math.sin(a) * r * 0.92,
      });
    });
  });
  return points;
}

const ARM_ROWS = [
  ['lex', '词法', '#7fb6ff'],
  ['act', '激活', '#f0b46a'],
  ['graph', '图扩散', '#8fd6a8'],
  ['recency', '时效', '#c9a6f2'],
];

export default function RecallPage() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [live, setLive] = useState(null);
  const [error, setError] = useState('');

  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const spaceRef = useRef(null);
  const space3d = useRef(null);
  const labelsRef = useRef(new Map());
  const [mode, setMode] = useState('loading');

  const items = data?.items || [];
  const points = useMemo(() => layoutPoints(items), [items]);

  const run = useCallback(async (q) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/recall?q=${encodeURIComponent(q)}&limit=14`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`接口返回 ${res.status}`);
      const json = await res.json().catch(() => null);
      if (!json || !json.ok) throw new Error((json && json.error) || '召回失败');
      setData(json);
      setSelectedId(json.items?.[0]?.id ?? null);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { run(''); }, [run]);

  // 3D 星云：复用 /neural 那套渲染，失败自动退回平面布局
  // 自带的 3D 星云：不依赖 /neural 正在重构的渲染模块，避免互相牵连。
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return undefined;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch {
      setMode('flat');
      return undefined;
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#080d1d');
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 600);
    camera.position.set(0, 42, 118);
    const controls = new OrbitControls(camera, canvas);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.minDistance = 60;
    controls.maxDistance = 260;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

    // 背景星尘
    const dustGeo = new THREE.BufferGeometry();
    const dust = new Float32Array(1400 * 3);
    for (let i = 0; i < 1400; i += 1) {
      const r = 140 + Math.random() * 180;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      dust[i * 3] = r * Math.sin(p) * Math.cos(t);
      dust[i * 3 + 1] = r * Math.cos(p) * 0.45;
      dust[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3));
    scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: '#4b5d8a', size: 1.2, sizeAttenuation: true, transparent: true, opacity: .7 })));

    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const nodeMat = new THREE.PointsMaterial({ color: '#a8c6ff', size: 6.5, sizeAttenuation: true, transparent: true, opacity: .95 });
    const nodes = new THREE.Points(nodeGeo, nodeMat);
    scene.add(nodes);

    const linkGeo = new THREE.BufferGeometry();
    const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: '#f0b46a', transparent: true, opacity: .55 }));
    scene.add(links);

    let frame = 0;
    let W = 1;
    let H = 1;
    const current = new Map(); // id -> Vector3

    function draw() {
      frame = 0;
      controls.update();
      renderer.render(scene, camera);
      const v = new THREE.Vector3();
      for (const [id, vec] of current) {
        v.copy(vec).project(camera);
        const el = labelsRef.current.get(id);
        if (!el) continue;
        const x = (v.x + 1) * W / 2;
        const y = (1 - v.y) * H / 2;
        const visible = v.z > -1 && v.z < 1 && x > 10 && y > 10 && x < W - 10 && y < H - 10;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.visibility = visible ? 'visible' : 'hidden';
      }
    }
    const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

    const ro = new ResizeObserver(([entry]) => {
      W = Math.max(1, entry.contentRect.width);
      H = Math.max(1, entry.contentRect.height);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      renderer.setSize(W, H, false);
      redraw();
    });
    ro.observe(stage);
    controls.addEventListener('change', redraw);
    redraw();
    setMode('3d');

    space3d.current = {
      update(list, pts, selId) {
        current.clear();
        const pos = [];
        const colors = [];
        const palette = { preference: '#f0b46a', pitfall: '#ff8f8f', decision: '#a8c6ff', insight: '#8fd6a8', progress: '#c9a6f2', output: '#7fd6d6' };
        const c = new THREE.Color();
        for (const it of list) {
          const p = pts.get(it.id);
          if (!p) continue;
          const x = (p.x - .5) * 150;
          const z = (p.y - .5) * 132;
          const y = Math.sin(x * .05 + z * .04) * 5;
          const vec = new THREE.Vector3(x, y, z);
          current.set(it.id, vec);
          pos.push(x, y, z);
          c.set(palette[it.kind] || '#a8c6ff');
          const k = 0.45 + it.score * 0.75;
          colors.push(c.r * k, c.g * k, c.b * k);
        }
        nodeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        nodeGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        nodeMat.vertexColors = true;
        nodeMat.needsUpdate = true;
        const from = current.get(selId);
        const seg = [];
        if (from) {
          for (const it of list.slice(0, 7)) {
            const to = current.get(it.id);
            if (!to || it.id === selId) continue;
            seg.push(from.x, from.y, from.z, to.x, to.y, to.z);
          }
        }
        linkGeo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
        redraw();
      },
    };

    return () => {
      ro.disconnect();
      controls.removeEventListener('change', redraw);
      controls.dispose();
      cancelAnimationFrame(frame);
      nodeGeo.dispose(); nodeMat.dispose(); dustGeo.dispose(); linkGeo.dispose();
      scene.traverse((o) => { if (o.material && o.material.dispose) o.material.dispose(); });
      renderer.dispose();
      space3d.current = null;
    };
  }, []);

  // 数据变了就同步到星云
  useEffect(() => {
    if (mode !== '3d' || !items.length) return;
    const selected = items.find((it) => it.id === selectedId) || items[0];
    space3d.current?.update(items, points, selected.id);
  }, [items, points, selectedId, mode]);
  // 知识库变更：订阅公开流，变了就重新召回
  useEffect(() => {
    let es;
    try {
      es = new EventSource(`${API}/stream-public`);
      es.addEventListener('knowledge', (ev) => {
        let action = 'updated';
        try { action = JSON.parse(ev.data).action || 'updated'; } catch { /* 保持默认 */ }
        setLive({ action, at: Date.now() });
        run(query);
      });
    } catch {
      es = null;
    }
    return () => es?.close();
  }, [query, run]);

  const selected = items.find((it) => it.id === selectedId) || items[0] || null;
  const trace = data?.trace;

  return (
    <div className="rc-page">
      <style>{`
        .rc-page{padding:96px 0 70px;min-height:100vh}
        .rc-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap}
        .rc-kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
        .rc-title{font-size:clamp(1.9rem,4vw,2.8rem);line-height:1.15;margin:10px 0 0}
        .rc-title em{font-style:normal;color:var(--accent)}
        .rc-legend{display:flex;align-items:center;gap:14px;font-size:11px;color:var(--muted)}
        .rc-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
        .rc-form{display:flex;gap:10px;margin:22px 0 16px}
        .rc-input{flex:1;min-width:0;height:44px;padding:0 14px;border-radius:11px;border:1px solid var(--line);
          background:var(--panel);color:var(--text);font-size:14px}
        .rc-input:focus{outline:none;border-color:var(--accent)}
        .rc-btn{height:44px;padding:0 18px;border-radius:11px;border:1px solid var(--line);background:var(--panel);
          color:var(--text);font-size:13px;display:inline-flex;align-items:center;gap:7px;cursor:pointer}
        .rc-btn:hover{border-color:var(--accent);color:var(--accent)}
        .rc-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,1fr);gap:18px;align-items:start}
        @media(max-width:900px){.rc-grid{grid-template-columns:1fr}}
        .rc-stage{position:relative;height:min(66vh,520px);border-radius:16px;overflow:hidden;
          background:#080d1d;border:1px solid var(--line)}
        .rc-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
        .rc-star{position:absolute;transform:translate(-50%,-50%);font-size:10.5px;line-height:1.25;
          color:#cfd8ff;text-shadow:0 1px 4px rgba(0,0,0,.8);white-space:nowrap;cursor:pointer;
          padding:2px 6px;border-radius:6px;max-width:190px;overflow:hidden;text-overflow:ellipsis}
        .rc-star[data-selected="1"]{color:#fff;background:rgba(90,130,255,.28);box-shadow:0 0 0 1px rgba(140,175,255,.5)}
        .rc-flat{position:absolute;inset:0;padding:16px;overflow:auto;display:flex;flex-direction:column;gap:8px}
        .rc-card{border:1px solid var(--line);border-radius:12px;padding:12px 13px;background:var(--panel)}
        .rc-card h3{font-size:13.5px;line-height:1.45;margin:0 0 6px}
        .rc-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--muted);flex-wrap:wrap}
        .rc-pill{border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:10.5px}
        .rc-arms{display:grid;gap:6px;margin-top:10px}
        .rc-arm{display:grid;grid-template-columns:52px 1fr 42px;gap:8px;align-items:center;font-size:10.5px;color:var(--muted)}
        .rc-bar{height:5px;border-radius:3px;background:var(--panel-soft);overflow:hidden}
        .rc-bar i{display:block;height:100%;border-radius:3px;transition:width .35s ease}
        .rc-rank{font-variant-numeric:tabular-nums}
        .rc-trace{margin-top:14px;font-size:11px;color:var(--muted);line-height:1.9}
        .rc-trace b{color:var(--text);font-weight:600}
        .rc-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--green)}
        .rc-err{margin-top:10px;font-size:12px;color:#c2410c}
        .rc-tip{margin-top:10px;font-size:11px;color:var(--muted)}
      `}</style>

      <div className="page-wrap">
        <header className="rc-head">
          <div>
            <p className="rc-kicker">RECALL CONSOLE</p>
            <h1 className="rc-title">记忆<em>召回台</em></h1>
          </div>
          <div className="rc-legend">
            <span><i className="rc-dot" style={{ background: '#7fb6ff' }} />词法</span>
            <span><i className="rc-dot" style={{ background: '#f0b46a' }} />激活</span>
            <span><i className="rc-dot" style={{ background: '#8fd6a8' }} />图扩散</span>
            {live && <span className="rc-live"><Radio size={11} />知识库刚更新</span>}
          </div>
        </header>

        <form className="rc-form" onSubmit={(e) => { e.preventDefault(); run(query); }}>
          <input
            className="rc-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="问一句，看四臂怎么挑：比如「我当时为什么不用 MCP」"
          />
          <button className="rc-btn" type="submit" disabled={loading}>
            {loading ? <Loader2 size={14} className="rc-spin" /> : <Search size={14} />}
            {loading ? '召回中' : '召回'}
          </button>
        </form>

        {error && <p className="rc-err">召回失败：{error}</p>}

        <div className="rc-grid">
          <section className="rc-stage" ref={stageRef}>
            <canvas className="rc-canvas" ref={canvasRef} />
            {mode === 'flat' && (
              <div className="rc-flat">
                {items.map((it) => (
                  <article key={it.id} className="rc-card" onClick={() => setSelectedId(it.id)}>
                    <h3>{it.rank}. {it.title}</h3>
                    <div className="rc-meta">
                      <span className="rc-pill">{KIND_LABEL[it.kind] || it.kind}</span>
                      <span className="rc-rank">{it.score.toFixed(3)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {mode === '3d' && items.map((it) => (
              <span
                key={it.id}
                className="rc-star"
                data-selected={it.id === selected?.id ? '1' : '0'}
                ref={(el) => { if (el) labelsRef.current.set(it.id, el); else labelsRef.current.delete(it.id); }}
                onClick={() => setSelectedId(it.id)}
                title={it.title}
              >
                {it.title}
              </span>
            ))}
          </section>

          <aside>
            <div className="rc-card">
              <h3>{selected ? selected.title : '还没有结果'}</h3>
              {selected && (
                <>
                  <div className="rc-meta">
                    <span className="rc-pill">{KIND_LABEL[selected.kind] || selected.kind}</span>
                    {selected.project && <span className="rc-pill">{selected.project}</span>}
                    <span className="rc-rank">总分 {selected.score.toFixed(3)}</span>
                  </div>
                  <div className="rc-arms">
                    {ARM_ROWS.map(([key, label, color]) => {
                      const v = selected.arms?.[key] ?? 0;
                      return (
                        <div className="rc-arm" key={key}>
                          <span>{label}</span>
                          <span className="rc-bar"><i style={{ width: `${Math.round(v * 100)}%`, background: color }} /></span>
                          <span className="rc-rank">{v.toFixed(2)}</span>
                        </div>
                      );
                    })}
                  </div>
                  {selected.arms?.matched?.length > 0 && (
                    <p className="rc-tip">命中词元：{selected.arms.matched.join(' / ')}</p>
                  )}
                  {selected.arms?.hop && (
                    <p className="rc-tip">来自图扩散第 {selected.arms.hop} 跳</p>
                  )}
                </>
              )}
            </div>

            {trace && (
              <div className="rc-trace">
                语料 <b>{trace.counts.corpus}</b> 条 · 词法候选 <b>{trace.counts.lexical}</b> ·
                激活 <b>{trace.counts.activation}</b> · 图扩散 <b>{trace.counts.graph}</b> ·
                画像 <b>{trace.counts.profile}</b><br />
                融合权重 词法 <b>{trace.weights.lexical}</b> · 激活 <b>{trace.weights.activation}</b> ·
                时效 <b>{trace.weights.recency}</b>　耗时 <b>{trace.ms}ms</b>
                {trace.cleaned && <><br />查询清洗为「<b>{trace.cleaned}</b>」</>}
                {trace.counts.droppedByMmr > 0 && <><br />MMR 去掉重复 <b>{trace.counts.droppedByMrr ?? trace.counts.droppedByMmr}</b> 条</>}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
