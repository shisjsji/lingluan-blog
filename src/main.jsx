import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  CircleDot,
  Command,
  ExternalLink,
  Heart,
  Home,
  Layers3,
  ListFilter,
  Menu,
  Moon,
  MoveUpRight,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
  X,
} from 'lucide-react'
import './styles.css'
import DotGrid from './components/DotGrid'

const asset = (path) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`
const profile = asset('images/profile.jpg')

const notes = [
  { title: '把一台旧电脑重新装好的晚上', excerpt: '从拆机、清灰到系统重装，记录一套不依赖运气的排障流程。', category: '装机排障', date: '2026.09.28', read: '6 min', accent: 'orange' },
  { title: '面向个人学习的 Agent 协作方法研究', excerpt: '摘要：将上下文建模、任务分解、工具验证与结果复盘组织为可重复的协作流程，并讨论它在自学场景中的边界。', category: 'Agent', date: '2026.09.16', read: '12 min', accent: 'blue' },
]

const projects = [
  { name: 'Agent 学习日志', type: 'Personal experiment', detail: '把与 Codex、各类 agent 的协作过程整理成可复用的小实验。', state: '进行中', icon: Sparkles, tone: 'blue' },
]

const gallery = [
  { src: asset('images/gallery/valley.jpg'), title: '山谷 · 01', note: '风从山脊经过', ratio: 'portrait' },
  { src: asset('images/gallery/lake.jpg'), title: '湖泊 · 02', note: '把视线放远一点', ratio: 'wide' },
  { src: asset('images/gallery/mountains.jpg'), title: '群山 · 03', note: '留给以后的一次出发', ratio: 'square' },
  { src: asset('images/gallery/forest.jpg'), title: '森林 · 04', note: '安静地走一段路', ratio: 'wide' },
  { src: asset('images/gallery/waterfall.jpg'), title: '瀑布 · 05', note: '保持一点流动', ratio: 'portrait' },
  { src: asset('images/gallery/coast.jpg'), title: '海岸 · 06', note: '在潮汐里放松', ratio: 'square' },
]

function AnimatedText({ children, className = '' }) {
  return <span className={`animated-text ${className}`}>{children}</span>
}

function Reveal({ children, className = '' }) {
  return <div className={`reveal ${className}`}>{children}</div>
}

function App() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try { localStorage.setItem('feng-theme', dark ? 'dark' : 'light') } catch { /* storage is optional on static previews */ }
  }, [dark])
  return (
    <div className="site-shell">
      <DotGrid baseColor={dark ? '#454841' : '#c8c9c1'} activeColor={dark ? '#e8916e' : '#e67851'} />
      <Header dark={dark} setDark={setDark} />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/gallery" element={<GalleryPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

function Header({ dark, setDark }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  useEffect(() => setMenuOpen(false), [location.pathname])
  const nav = [
    { to: '/', label: '首页', icon: Home },
    { to: '/about', label: '关于我', icon: CircleDot },
    { to: '/notes', label: '笔记', icon: BookOpen },
    { to: '/projects', label: '项目', icon: BriefcaseBusiness },
  ]
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/" className="brand" aria-label="回到首页">
          <span className="brand-mark"><span /></span>
          <span>凌乱的风<span className="ampersand">&</span></span>
        </Link>
        <nav className={`desktop-nav ${menuOpen ? 'is-open' : ''}`} aria-label="主导航">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              <Icon size={15} strokeWidth={1.8} />{label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-actions">
          <button className="icon-button theme-toggle" onClick={() => setDark((value) => !value)} aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button className="icon-button menu-button" onClick={() => setMenuOpen((value) => !value)} aria-label="打开菜单">
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {menuOpen && <div className="mobile-nav">{nav.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} className="mobile-nav-link"><Icon size={17} />{label}<ChevronRight size={15} /></NavLink>)}</div>}
    </header>
  )
}

function HomePage() {
  return <>
    <section className="hero page-wrap">
      <div className="hero-copy">
        <div className="eyebrow"><span className="status-dot" />现在在线，正在学习与创造</div>
        <h1><AnimatedText>你好，我是<br /><em>凌乱的风&</em></AnimatedText></h1>
        <p className="hero-intro">18 岁，信息安全技术专业大一学生。喜欢把复杂问题拆开，也喜欢把一台旧电脑修到重新发光。</p>
        <div className="hero-actions">
          <Link to="/about" className="button button-primary">认识我 <ArrowUpRight size={16} /></Link>
          <a className="button button-quiet" href="https://github.com/shisjsji" target="_blank" rel="noreferrer">GitHub <ExternalLink size={14} /></a>
        </div>
        <div className="hero-meta"><span>在校学习</span><span className="meta-separator" /><span>常驻互联网</span><span className="meta-separator" /><span>保持好奇</span></div>
        <ContactWidget />
      </div>
      <div className="hero-portrait-wrap">
        <div className="portrait-note note-top"><span>01</span><span>about me</span></div>
        <div className="hero-portrait"><img src={profile} alt="凌乱的风& 的头像" /><span className="portrait-outline" /></div>
        <div className="portrait-note note-bottom"><Heart size={14} fill="currentColor" /><span>把喜欢的事做好</span></div>
      </div>
    </section>

    <section className="stats-strip page-wrap">
      <div className="stat"><strong>18</strong><span>年龄</span></div><div className="stat"><strong>01</strong><span>大学年级</span></div><div className="stat"><strong>∞</strong><span>正在探索</span></div>
      <div className="stats-note"><span className="mono">CURRENTLY</span><span>信息安全技术 · 大一</span></div>
    </section>

    <section className="home-grid page-wrap">
      <Reveal className="section-heading"><div><span className="section-kicker">01 / NOW</span><h2>最近在做什么</h2></div><Link to="/about" className="text-link">更多关于我 <ArrowUpRight size={15} /></Link></Reveal>
      <div className="now-grid">
        <Reveal className="now-feature"><div className="feature-icon"><Sparkles size={20} /></div><div><p className="card-label">LEARNING / 01</p><h3>和 Codex 以及各 agent 一起学习</h3><p>把想法变成可以运行的东西，在每一次提问、验证和修正里建立自己的方法。</p></div><ArrowDownRight className="feature-arrow" size={20} /></Reveal>
        <Reveal className="now-list">
          <div className="now-row"><span className="row-number">02</span><div><p>把 Agent 协作整理成论文草稿</p><span>问题建模 / 实验记录 / 复盘</span></div><ChevronRight size={17} /></div>
          <div className="now-row"><span className="row-number">03</span><div><p>折腾电脑装机与疑难杂症</p><span>硬件 / 系统 / 现场解决</span></div><ChevronRight size={17} /></div>
          <div className="now-row"><span className="row-number">04</span><div><p>给信息安全打好基础</p><span>网络 / Linux / 基础实践</span></div><ChevronRight size={17} /></div>
          <div className="now-row"><span className="row-number">05</span><div><p>把值得留住的过程写下来</p><span>笔记 / 风景 / 小项目</span></div><ChevronRight size={17} /></div>
        </Reveal>
      </div>
    </section>

    <section className="home-grid notes-preview page-wrap">
      <Reveal className="section-heading"><div><span className="section-kicker">02 / NOTES</span><h2>精选笔记</h2></div><Link to="/notes" className="text-link">查看全部 <ArrowUpRight size={15} /></Link></Reveal>
      <div className="note-list">{notes.map((note, index) => <NoteRow key={note.title} note={note} index={index} />)}</div>
    </section>

    <section className="gallery-entry page-wrap">
      <Reveal className="gallery-entry-inner"><div><span className="section-kicker">A SMALL CORNER</span><h2>还有一些照片，<br /><em>放在别处。</em></h2></div><Link to="/gallery" className="circle-link" aria-label="进入图库"><ArrowUpRight size={22} /></Link></Reveal>
    </section>
  </>
}

function NoteRow({ note, index }) {
  return <Link to="/notes" className="note-row"><span className={`note-bullet ${note.accent}`} /> <span className="note-index">0{index + 1}</span><div className="note-main"><h3>{note.title}</h3><p>{note.excerpt}</p></div><div className="note-detail"><span>{note.category}</span><small>{note.date} · {note.read}</small></div><ArrowUpRight className="note-arrow" size={17} /></Link>
}

function AboutPage() {
  return <div className="page-wrap inner-page"><PageIntro kicker="ABOUT ME / 01" title={<>关于 <em>凌乱的风&</em></>} intro="我还在长成自己的样子。这里放下已经知道的，也放下正在学会的。" />
    <div className="about-layout"><aside className="sticky-aside"><span className="aside-label">PROFILE / 2008—NOW</span><div className="mini-profile"><img src={profile} alt="凌乱的风&" /><div><strong>凌乱的风&</strong><span>信息安全技术 · 大一</span></div></div><p>一个喜欢拆解问题、修电脑，并且对新工具保持好奇的人。</p></aside><div className="about-content">
      <section className="prose-block"><span className="section-kicker">01 / THE SHORT VERSION</span><h2>先从一台电脑开始，<br />再走远一点。</h2><p>我出生于 2008 年，现在是一名信息安全技术专业的大一学生。比起把自己定义成“擅长什么”，我更愿意记录自己正在如何变得更好。</p><p>我会自己装机，处理那些看起来很麻烦的电脑问题；也在自学 Codex 和各类 agent，试着把它们变成可靠的思考伙伴。</p></section>
      <ContactWidget />
      <section className="skills-block"><span className="section-kicker">02 / THINGS I DO</span><div className="skills-list"><Skill title="信息安全学习" detail="网络基础 · Linux · 继续补齐知识地图" icon={ShieldCheck} /><Skill title="装机与排障" detail="硬件组装 · 系统重装 · 疑难杂症处理" icon={TerminalSquare} /><Skill title="Codex & Agent" detail="拆解问题 · 快速验证 · 记录方法" icon={Sparkles} /></div></section>
      <section className="timeline-block"><span className="section-kicker">03 / TIMELINE</span><div className="timeline"><TimelineItem year="2008" title="出生" detail="开始一段很长的探索。" /><TimelineItem year="2025" title="遇见更多工具" detail="开始认真接触 Codex、agent 与更大的互联网。" /><TimelineItem year="2026" title="大一 · 信息安全技术" detail="在课堂之外，把基础知识变成自己的能力。" active /></div></section>
    </div></div>
  </div>
}

function Skill({ title, detail, icon: Icon }) { return <div className="skill-row"><div className="skill-icon"><Icon size={19} /></div><div><h3>{title}</h3><p>{detail}</p></div><Check size={16} className="skill-check" /></div> }
function TimelineItem({ year, title, detail, active }) { return <div className={`timeline-item ${active ? 'active' : ''}`}><span className="timeline-dot" /><span className="timeline-year">{year}</span><div><h3>{title}</h3><p>{detail}</p></div></div> }

function PageIntro({ kicker, title, intro }) { return <Reveal className="page-intro"><span className="section-kicker">{kicker}</span><h1>{title}</h1><p>{intro}</p></Reveal> }

function ContactWidget() {
  return <section className="contact-widget" aria-label="联系方式">
    <div className="contact-widget-heading"><span className="section-kicker">CONTACT / 04</span><h3>联系方式</h3></div>
    <div className="contact-links">
      <a className="contact-item" href="https://github.com/shisjsji" target="_blank" rel="noreferrer"><span className="contact-label">GitHub</span><span className="contact-value">@shisjsji <ExternalLink size={13} /></span></a>
      <a className="contact-item" href="https://www.coolapk.com/u/30432128" target="_blank" rel="noreferrer"><span className="contact-label">酷安</span><span className="contact-value">30432128 <ExternalLink size={13} /></span></a>
      <div className="contact-item contact-wechat"><span className="contact-label">微信号码</span><span className="contact-value">XovoeH_Jun13 · x080814OwO</span></div>
    </div>
  </section>
}

function NotesPage() {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState('全部')
  const categories = ['全部', '装机排障', 'Agent']
  const filtered = useMemo(() => notes.filter((note) => (active === '全部' || note.category === active) && `${note.title}${note.excerpt}`.toLowerCase().includes(query.toLowerCase())), [active, query])
  return <div className="page-wrap inner-page"><PageIntro kicker="NOTES / 02" title={<>一些正在成形的<em>想法。</em></>} intro="不追求每天更新，只留下下一次还会想打开的东西。" />
    <section className="notes-toolbar"><div className="filter-tabs">{categories.map((category) => <button key={category} className={active === category ? 'filter-tab active' : 'filter-tab'} onClick={() => setActive(category)}>{category}</button>)}</div><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记" /></label></section>
    <section className="notes-page-list">{filtered.length ? filtered.map((note, index) => <NoteRow key={note.title} note={note} index={index} />) : <div className="empty-state"><ListFilter size={20} /><p>还没有找到这条记录。</p></div>}</section>
    <article className="agent-paper"><span className="section-kicker">AGENT / FIELD PAPER</span><h2>面向个人学习的 Agent 协作方法研究</h2><p className="agent-paper-lead">摘要：本文以个人学习中的真实问题为对象，尝试建立一套由问题建模、上下文准备、分步执行、证据核验和结果复盘组成的 Agent 协作流程。实践表明，Agent 的价值不在于替代思考，而在于降低验证成本，让学习者更快获得可检查的中间结果。</p><div className="agent-paper-grid"><div><span>01</span><h3>问题建模</h3><p>先明确目标、限制条件与完成标准，把“帮我做点什么”改写成可验证的问题。</p></div><div><span>02</span><h3>分步执行</h3><p>让 Agent 先探索再修改，每一步都保留输入、输出和依据，避免结果变成无法解释的黑箱。</p></div><div><span>03</span><h3>结果复盘</h3><p>通过运行结果、文档来源与失败记录交叉检查，沉淀下一次可以复用的提示与流程。</p></div></div><p className="agent-paper-conclusion"><strong>结论。</strong> 对个人学习而言，稳定的协作节奏比一次性生成完整答案更重要。Agent 应该成为可追问、可校验、可修正的实验伙伴。</p></article>
    <div className="notes-footnote"><Command size={15} />更多笔记正在路上 <span>·</span> 最后更新于 2026.09</div>
  </div>
}

function ProjectsPage() {
  return <div className="page-wrap inner-page"><PageIntro kicker="PROJECTS / 03" title={<>把好奇心，<em>做成东西。</em></>} intro="一些还在生长的小项目。它们不一定完整，但都有清楚的起点。" /><section className="projects-list">{projects.map((project, index) => <a href="https://github.com/shisjsji" target="_blank" rel="noreferrer" className="project-row" key={project.name}><span className="project-number">0{index + 1}</span><div className={`project-icon ${project.tone}`}><project.icon size={21} /></div><div className="project-copy"><div className="project-title"><h2>{project.name}</h2><span>{project.type}</span></div><p>{project.detail}</p></div><span className="project-state"><span className="status-dot" />{project.state}</span><ArrowUpRight className="project-arrow" size={18} /></a>)}</section><section className="project-cta"><div><span className="section-kicker">COLLABORATION</span><h2>有一个问题，<br /><em>想一起拆开吗？</em></h2></div><a href="https://github.com/shisjsji" target="_blank" rel="noreferrer" className="button button-primary">联系我 <ArrowUpRight size={16} /></a></section></div>
}

function GalleryPage() {
  const [selected, setSelected] = useState(null)
  useEffect(() => { const onKey = (event) => { if (event.key === 'Escape') setSelected(null) }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [])
  return <div className="page-wrap inner-page gallery-page"><Link to="/" className="back-link"><ArrowLeft size={16} /> 回到首页</Link><PageIntro kicker="GALLERY / A SMALL CORNER" title={<>一些<em>生活切片。</em></>} intro="这是一个小小的草稿入口。以后会放更多照片、路过的风景，以及值得留住的瞬间。" /><div className="gallery-grid">{gallery.map((item, index) => <button className={`gallery-card ${item.ratio}`} key={`${item.title}-${index}`} onClick={() => setSelected(item)}><img src={item.src} alt={item.title} /><span className="gallery-card-overlay"><small>{item.title}</small><strong>{item.note}</strong><ArrowUpRight size={17} /></span></button>)}</div>{selected && <div className="lightbox" role="dialog" aria-modal="true" aria-label={selected.title} onClick={() => setSelected(null)}><button className="lightbox-close" onClick={() => setSelected(null)} aria-label="关闭"><X size={20} /></button><div className="lightbox-image" onClick={(event) => event.stopPropagation()}><img src={selected.src} alt={selected.title} /><div><span>{selected.title}</span><small>{selected.note}</small></div></div></div>}</div>
}

function NotFoundPage() { const navigate = useNavigate(); return <div className="not-found page-wrap"><span className="section-kicker">404 / LOST IN THE WIND</span><h1>这页还没有<br /><em>被写出来。</em></h1><p>也许它正在某个草稿里等待下一次打开。</p><button className="button button-primary" onClick={() => navigate('/')}>回到首页 <ArrowUpRight size={16} /></button></div> }

function Footer() { return <footer className="footer page-wrap"><div className="footer-brand"><span className="brand-mark"><span /></span><div><strong>凌乱的风<span className="ampersand">&</span></strong><span>记录正在发生的事。</span></div></div><div className="footer-links"><a href="https://github.com/shisjsji" target="_blank" rel="noreferrer" aria-label="GitHub" className="social-mark">GH</a><a href="https://www.coolapk.com/u/30432128" target="_blank" rel="noreferrer" aria-label="酷安"><Layers3 size={17} /></a><Link to="/gallery" className="footer-gallery">图库 · 其他角落 <ArrowUpRight size={14} /></Link></div><span className="footer-copy">© 2026 · Made with curiosity</span></footer> }

export default function Root() { return <HashRouter><App /></HashRouter> }

createRoot(document.getElementById('root')).render(<Root />)
