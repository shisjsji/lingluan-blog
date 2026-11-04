import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Activity, CircleDot, GitBranch, Pause, Play, RotateCcw, X } from 'lucide-react';
import { NeuronScene } from './NeuronScene';
import './neural.css';

const API = '/neural-api';

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function NeuralPage() {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const wrapRef = useRef(null);

  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [stats, setStats] = useState(null);
  const [scope, setScope] = useState(null);
  const [view, setView] = useState({ category: '编程', project: '学习通' });
  // SSE 回调在 effect 里注册，闭包会拿到旧的 view，用 ref 保持最新
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [hovered, setHovered] = useState(null);
  const [selectedUid, setSelectedUid] = useState(null);
  const selected = useMemo(() => graph.nodes.find((n) => n.uid === selectedUid) || null, [graph.nodes, selectedUid]);
  const [status, setStatus] = useState('loading');
  const [dark, setDark] = useState(() => (document.documentElement.dataset.theme || 'light') === 'dark');

  const [timeValue, setTimeValue] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);

  const range = useMemo(() => {
    if (!graph.nodes.length) return { start: Date.now() - 86400000, end: Date.now() };
    const times = graph.nodes.map((n) => Date.parse(n.createdAt));
    return { start: Math.min(...times), end: Math.max(...times) };
  }, [graph.nodes]);

  const cursorTs = useMemo(() => {
    const span = range.end - range.start || 1;
    return range.start + span * timeValue;
  }, [range, timeValue]);

  // 主题跟随博客
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark((target.dataset.theme || 'light') === 'dark');
    });
    observer.observe(target, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // 先取分类与项目，再按当前视图拉图
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const sc = await fetch(`${API}/scope`).then((r) => r.json());
        if (!alive) return;
        setScope(sc);
        const first = sc.categories?.[0];
        const proj = first?.projects?.[0]?.name || '';
        setView((v) => (v.project || v.category ? v : { category: first?.category || '编程', project: proj }));
        setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 视图切换时重新拉取，一次只渲染一个项目
  useEffect(() => {
    if (status !== 'ready') return undefined;
    let alive = true;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (view.project) params.set('project', view.project);
        else if (view.category) params.set('category', view.category);
        params.set('limit', '600');
        const [g, s] = await Promise.all([
          fetch(`${API}/graph?${params}`).then((r) => r.json()),
          fetch(`${API}/stats`).then((r) => r.json()),
        ]);
        if (!alive) return;
        setGraph(g);
        setStats(s);
        setTimeValue(1);
        setSelectedUid(null);
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [view, status]);

  // 初始化场景（只在就绪时建一次）
  useEffect(() => {
    if (status !== 'ready' || !canvasRef.current) return undefined;
    const scene = new NeuronScene(canvasRef.current, {
      onHover: (node) => setHovered(node),
      onSelect: (uid) => setSelectedUid(uid),
    });
    sceneRef.current = scene;
    scene.setTheme(dark);
    if (graph.nodes.length) scene.setData(graph.nodes, graph.edges);

    const ro = new ResizeObserver(() => scene.resize());
    if (wrapRef.current) ro.observe(wrapRef.current);

    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // 数据变化只更新网络，不重建场景
  useEffect(() => {
    sceneRef.current?.setData(graph.nodes, graph.edges);
  }, [graph]);

  useEffect(() => {
    sceneRef.current?.setTheme(dark);
  }, [dark]);

  // 时间轴
  useEffect(() => {
    if (!sceneRef.current || status !== 'ready') return;
    const ts = playing || scrubbing ? cursorTs : range.end;
    sceneRef.current.setTimeFilter(ts);
  }, [cursorTs, playing, scrubbing, range.end, status]);

  // 回放
  useEffect(() => {
    if (!playing) return undefined;
    let raf;
    let last = performance.now();
    const step = (now) => {
      const dt = now - last;
      last = now;
      setTimeValue((v) => {
        const next = v + dt / 14000;
        if (next >= 1) {
          setPlaying(false);
          return 1;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 实时流
  useEffect(() => {
    if (status !== 'ready') return undefined;
    let es;
    try {
      es = new EventSource(`${API}/stream`);
      es.addEventListener('neuron', (ev) => {
        const payload = JSON.parse(ev.data);
        const cur = viewRef.current;
        const node = payload.node;
        // 只接收当前视图范围内的节点，否则看博客时会冒出学习通的记忆
        const inScope = cur.project
          ? node.project === cur.project
          : cur.category
            ? node.category === cur.category
            : true;
        if (!inScope) return;
        setGraph((prev) => {
          if (prev.nodes.some((n) => n.uid === node.uid)) return prev;
          const known = new Set(prev.nodes.map((n) => n.uid));
          known.add(node.uid);
          const edges = payload.edges.filter((e) => known.has(e.source) && known.has(e.target));
          return { nodes: [...prev.nodes, node], edges: [...prev.edges, ...edges] };
        });
        setStats((prev) => (prev ? { ...prev, total: prev.total + 1, today: prev.today + 1, edges: prev.edges + payload.edges.length } : prev));
      });
      es.onerror = () => {
        es.close();
      };
    } catch {
      /* 实时流不可用时静默降级 */
    }
    return () => es?.close();
  }, [status]);

  const visibleCount = useMemo(
    () => graph.nodes.filter((n) => Date.parse(n.createdAt) <= cursorTs).length,
    [graph.nodes, cursorTs]
  );

  const recent = useMemo(
    () => graph.nodes.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 7),
    [graph.nodes]
  );

  const timelineMarks = useMemo(() => {
    const span = range.end - range.start;
    if (!span) return [];
    const marks = [];
    const steps = 4;
    for (let i = 0; i <= steps; i += 1) {
      const ts = range.start + (span * i) / steps;
      marks.push({ pos: i / steps, label: formatDate(new Date(ts).toISOString()) });
    }
    return marks;
  }, [range]);

  return (
    <div className={`neural-page ${dark ? 'is-dark' : 'is-light'}`}>
      <header className="neural-head">
        <div className="neural-head-left">
          <Link to="/" className="neural-back">
            <ArrowLeft size={15} /> 返回
          </Link>
          <div className="neural-title">
            <h1>神经元</h1>
            <span className="neural-sub">AGENT NEURAL MAP</span>
          </div>
        </div>
        <div className="neural-head-right">
          <span className={`neural-live ${status === 'ready' ? 'is-on' : ''}`}>
            <i /> {status === 'ready' ? '实时连接' : status === 'error' ? '连接失败' : '连接中'}
          </span>
          <button className="neural-ghost" onClick={() => sceneRef.current?.resetView()} title="复位视角">
            <RotateCcw size={15} />
          </button>
        </div>
      </header>

      <div className="neural-scope">
        {scope?.categories?.map((cat) => (
          <button
            key={cat.category}
            className={`neural-cat ${view.category === cat.category ? 'is-on' : ''}`}
            onClick={() => setView({ category: cat.category, project: cat.projects?.[0]?.name || '' })}
          >
            {cat.category}
            <i>{cat.total}</i>
          </button>
        ))}
        <span className="neural-scope-sep" />
        {(scope?.categories?.find((c) => c.category === view.category)?.projects || []).map((p) => (
          <button
            key={p.name}
            className={`neural-proj ${view.project === p.name ? 'is-on' : ''}`}
            onClick={() => setView({ category: view.category, project: p.name })}
          >
            {p.name}
            <i>{p.count}</i>
          </button>
        ))}
      </div>

      <div className="neural-body">
        <aside className="neural-panel neural-stats">
          <div className="neural-stat">
            <span className="neural-stat-label">神经元</span>
            <strong>{stats ? stats.total : '—'}</strong>
          </div>
          <div className="neural-stat">
            <span className="neural-stat-label">突触</span>
            <strong>{stats ? stats.edges : '—'}</strong>
          </div>
          <div className="neural-stat">
            <span className="neural-stat-label">今日新增</span>
            <strong className="is-warm">{stats ? `+${stats.today}` : '—'}</strong>
          </div>
          <div className="neural-stat">
            <span className="neural-stat-label">会话</span>
            <strong>{stats ? stats.sessions : '—'}</strong>
          </div>
          <div className="neural-tags">
            <span className="neural-stat-label">活跃标签</span>
            <div className="neural-tag-list">
              {stats?.topTags?.map((tag) => (
                <span key={tag.name} className="neural-tag">
                  {tag.name}
                  <i>{tag.count}</i>
                </span>
              ))}
            </div>
          </div>
        </aside>

        <div className="neural-stage" ref={wrapRef}>
          <canvas ref={canvasRef} className="neural-canvas" />
          {status === 'loading' && <div className="neural-hint">正在接入神经网络…</div>}
          {status === 'error' && <div className="neural-hint is-error">神经服务暂时不可达</div>}
          {hovered && (
            <div className="neural-tooltip">
              <span className="neural-tooltip-date">{formatDate(hovered.createdAt)}</span>
              <strong>{hovered.title}</strong>
              {hovered.summary && <p>{hovered.summary}</p>}
              <div className="neural-tooltip-tags">
                {hovered.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
          )}
          {selected && (
            <div className="neural-detail">
              <button className="neural-detail-close" onClick={() => setSelectedUid(null)} aria-label="关闭">
                <X size={15} />
              </button>
              <span className="neural-detail-date">{formatDateTime(selected.createdAt)}</span>
              <h2>{selected.title}</h2>
              {selected.summary && <p>{selected.summary}</p>}
              <div className="neural-detail-tags">
                {selected.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <dl className="neural-detail-meta">
                <div>
                  <dt>会话</dt>
                  <dd>{selected.sessionId || '—'}</dd>
                </div>
                <div>
                  <dt>类型</dt>
                  <dd>{selected.kind}</dd>
                </div>
                <div>
                  <dt>权重</dt>
                  <dd>{selected.weight.toFixed(2)}</dd>
                </div>
              </dl>
              <button className="neural-focus" onClick={() => sceneRef.current?.focusOn(selected.uid)}>
                聚焦这个神经元
              </button>
            </div>
          )}
        </div>

        <aside className="neural-panel neural-stream">
          <div className="neural-stream-head">
            <Activity size={14} />
            <span>最近活动</span>
          </div>
          <ul className="neural-stream-list">
            {recent.map((node) => (
              <li key={node.uid} onClick={() => sceneRef.current?.focusOn(node.uid)}>
                <span className="neural-stream-date">{formatDate(node.createdAt)}</span>
                <strong>{node.title}</strong>
                <div className="neural-stream-tags">
                  {node.tags.slice(0, 2).map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div className="neural-stream-foot">
            <CircleDot size={12} />
            <span>由 MiMo 智能体实时写入</span>
          </div>
        </aside>
      </div>

      <footer className="neural-timeline">
        <div className="neural-timeline-head">
          <span className="neural-timeline-label">
            <GitBranch size={13} /> 生长时间线
          </span>
          <span className="neural-timeline-count">{visibleCount} / {graph.nodes.length}</span>
          <button
            className="neural-play"
            onClick={() => {
              if (timeValue >= 1) setTimeValue(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? <Pause size={13} /> : <Play size={13} />}
            {playing ? '暂停' : '回放生长'}
          </button>
        </div>
        <div className="neural-track" data-playing={playing}>
          <div className="neural-track-rail" />
          <div className="neural-track-fill" style={{ width: `${timeValue * 100}%` }} />
          {timelineMarks.map((mark) => (
            <span key={mark.label} className="neural-mark" style={{ left: `${mark.pos * 100}%` }}>
              <i />
              <em>{mark.label}</em>
            </span>
          ))}
          <div className="neural-needle" style={{ left: `${timeValue * 100}%` }}>
            <b />
            <span>{formatDateTime(new Date(cursorTs).toISOString())}</span>
          </div>
          <input
            className="neural-range"
            type="range"
            min="0"
            max="1000"
            value={Math.round(timeValue * 1000)}
            onChange={(e) => {
              setPlaying(false);
              setScrubbing(true);
              setTimeValue(Number(e.target.value) / 1000);
            }}
            onPointerUp={() => setScrubbing(false)}
            onBlur={() => setScrubbing(false)}
            aria-label="时间轴"
          />
        </div>
      </footer>
    </div>
  );
}