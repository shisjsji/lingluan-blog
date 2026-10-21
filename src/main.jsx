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
import siteContent from './content/site-content.json'
import galleryContent from './content/gallery.json'

const siteBase = typeof window !== 'undefined' && window.location.pathname.startsWith('/lingluan-blog')
  ? '/lingluan-blog/'
  : import.meta.env.BASE_URL
const asset = (path) => `${siteBase}${path.replace(/^\/+/, '')}`
const profile = asset('images/profile.jpg')

const { about, notes, agentPaper } = siteContent

const projects = [
  { name: 'AURORA-pro', type: 'Magisk · KernelSU', detail: '以设备原厂 Dolby XML 为基底的双扬声器调音模块，保留耳机、蓝牙与 USB 路线的原厂节点。', state: 'v5.7.0', icon: Layers3, tone: 'orange', url: 'https://github.com/shisjsji/AURORA-pro' },
  { name: 'ios_auto_brightness', type: 'Android 模块', detail: '把小米设备的自动亮度曲线改成更接近 iOS 的观感。', state: '已发布', icon: Sun, tone: 'green', url: 'https://github.com/shisjsji/ios_auto_brightness' },
  { name: 'Agent 学习日志', type: 'Personal experiment', detail: '把与 Codex、各类 agent 的协作过程整理成可复用的小实验。', state: '进行中', icon: Sparkles, tone: 'blue', url: 'https://github.com/shisjsji' },
]

const gallery = galleryContent.map((item) => ({ ...item, src: asset(`images/gallery/${item.file}`) }))
const guestbookIssueUrl = 'https://github.com/shisjsji/lingluan-blog/issues/1'
const editorUrl = (path) => `https://github.com/shisjsji/lingluan-blog/edit/master/${path}`
const galleryUploadUrl = 'https://github.com/shisjsji/lingluan-blog/upload/master/public/images/gallery'
const gallerySubmissionUrl = 'https://github.com/shisjsji/lingluan-blog/issues/new?template=gallery-submission.yml'

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
      <ScrollToTop />
      <DotGrid baseColor={dark ? '#454c50' : '#cbd5da'} activeColor={dark ? '#f08a68' : '#b54b35'} />
      <Header dark={dark} setDark={setDark} />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/gallery" element={<GalleryPage />} />
          <Route path="/guestbook" element={<GuestbookPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }) }, [pathname])
  return null
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
        <div className="eyebrow">信息安全技术 · 大一</div>
        <h1><AnimatedText>你好，我是<br /><em>凌乱的风&</em></AnimatedText></h1>
        <p className="hero-intro">18 岁，信息安全技术专业大一学生。喜欢把复杂问题拆开，也喜欢把一台旧电脑修到重新发光。</p>
        <div className="hero-actions">
          <Link to="/about" className="button button-primary">认识我 <ArrowUpRight size={16} /></Link>
          <a className="button button-quiet" href="https://github.com/shisjsji" target="_blank" rel="noreferrer">GitHub <ExternalLink size={14} /></a>
        </div>
      </div>
      <div className="hero-portrait-wrap">
        <div className="hero-portrait"><img src={profile} alt="凌乱的风& 的头像" /><span className="portrait-outline" /></div>
      </div>
    </section>

    <section className="stats-strip page-wrap">
      <div className="stat"><strong>18</strong><span>年龄</span></div><div className="stat"><strong>01</strong><span>大学年级</span></div><div className="stat"><strong>∞</strong><span>正在探索</span></div>
      <div className="stats-note"><span className="mono">CURRENTLY</span><span>信息安全技术 · 大一</span></div>
    </section>

    <div className="page-wrap home-contact"><ContactWidget /></div>

    <section className="home-guestbook page-wrap">
      <GuestbookWidget compact />
    </section>

    <section className="home-grid page-wrap">
      <Reveal className="section-heading"><h2>最近在做什么</h2><Link to="/about" className="text-link">更多关于我 <ArrowUpRight size={15} /></Link></Reveal>
      <div className="now-grid">
        <Reveal className="now-feature"><div className="feature-icon"><Sparkles size={20} /></div><div><h3>和 Codex 以及各 agent 一起学习</h3><p>把想法变成可以运行的东西，在每一次提问、验证和修正里建立自己的方法。</p></div><ArrowDownRight className="feature-arrow" size={20} /></Reveal>
        <Reveal className="now-list">
          <div className="now-row"><span className="row-number">02</span><div><p>把 Agent 协作整理成论文草稿</p><span>问题建模 / 实验记录 / 复盘</span></div><ChevronRight size={17} /></div>
          <div className="now-row"><span className="row-number">03</span><div><p>折腾电脑装机与疑难杂症</p><span>硬件 / 系统 / 现场解决</span></div><ChevronRight size={17} /></div>
          <div className="now-row"><span className="row-number">04</span><div><p>给信息安全打好基础</p><span>网络 / Linux / 基础实践</span></div><ChevronRight size={17} /></div>
          <div className="now-row"><span className="row-number">05</span><div><p>把值得留住的过程写下来</p><span>笔记 / 风景 / 小项目</span></div><ChevronRight size={17} /></div>
        </Reveal>
      </div>
    </section>

    <section className="home-grid notes-preview page-wrap">
      <Reveal className="section-heading"><h2>精选笔记</h2><Link to="/notes" className="text-link">查看全部 <ArrowUpRight size={15} /></Link></Reveal>
      <div className="note-list">{notes.map((note, index) => <NoteRow key={note.title} note={note} index={index} />)}</div>
    </section>

    <section className="gallery-entry page-wrap">
      <Reveal className="gallery-entry-inner"><h2>还有一些照片，<br /><em>放在别处。</em></h2><Link to="/gallery" className="circle-link" aria-label="进入图库"><ArrowUpRight size={22} /></Link></Reveal>
    </section>
  </>
}

function NoteRow({ note, index }) {
  return <Link to="/notes" className="note-row"><span className={`note-bullet ${note.accent}`} /> <span className="note-index">0{index + 1}</span><div className="note-main"><h3>{note.title}</h3><p>{note.excerpt}</p></div><div className="note-detail"><span>{note.category}</span><small>{note.date} · {note.read}</small></div><ArrowUpRight className="note-arrow" size={17} /></Link>
}

function AboutPage() {
  const skillIcons = { security: ShieldCheck, terminal: TerminalSquare, agent: Sparkles }
  return <div className="page-wrap inner-page"><PageIntro kicker="关于我" title={<>关于 <em>凌乱的风&</em></>} intro="我还在长成自己的样子。这里放下已经知道的，也放下正在学会的。" />
    <div className="about-layout"><aside className="sticky-aside"><span className="aside-label">PROFILE / 2008-NOW</span><div className="mini-profile"><img src={profile} alt="凌乱的风&" /><div><strong>凌乱的风&</strong><span>信息安全技术 · 大一</span></div></div><p>{about.summary}</p></aside><div className="about-content">
      <div className="content-admin-row about-admin-row"><span>个人介绍、技能与成长记录保存在 GitHub。</span><a href={editorUrl('src/content/site-content.json')} target="_blank" rel="noreferrer">在线编辑关于我 <ExternalLink size={14} /></a></div>
      <section className="prose-block"><h2>{about.heading}</h2>{about.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</section>
      <ContactWidget />
      <div className="about-guestbook-link"><Link to="/guestbook" className="text-link">看看访客留言 <ArrowUpRight size={15} /></Link></div>
      <section className="skills-block"><h2>我正在积累的能力</h2><div className="skills-list">{about.skills.map((skill) => <Skill key={skill.title} title={skill.title} detail={skill.detail} icon={skillIcons[skill.icon] || Sparkles} />)}</div></section>
      <section className="timeline-block"><h2>成长记录</h2><div className="timeline">{about.timeline.map((item) => <TimelineItem key={`${item.year}-${item.title}`} {...item} />)}</div></section>
    </div></div>
  </div>
}

function Skill({ title, detail, icon: Icon }) { return <div className="skill-row"><div className="skill-icon"><Icon size={19} /></div><div><h3>{title}</h3><p>{detail}</p></div><Check size={16} className="skill-check" /></div> }
function TimelineItem({ year, title, detail, active }) { return <div className={`timeline-item ${active ? 'active' : ''}`}><span className="timeline-dot" /><span className="timeline-year">{year}</span><div><h3>{title}</h3><p>{detail}</p></div></div> }

function PageIntro({ kicker, title, intro }) { return <Reveal className="page-intro"><span className="section-kicker">{kicker}</span><h1>{title}</h1><p>{intro}</p></Reveal> }

function ContactWidget() {
  return <section className="contact-widget" aria-label="联系方式">
    <div className="contact-widget-heading"><h3>联系方式</h3></div>
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
  return <div className="page-wrap inner-page"><PageIntro kicker="笔记" title={<>一些正在成形的<em>想法。</em></>} intro="不追求每天更新，只留下下一次还会想打开的东西。" />
    <div className="content-admin-row"><span>内容保存在 GitHub，提交后自动更新网站。</span><a href={editorUrl('src/content/site-content.json')} target="_blank" rel="noreferrer">在线编辑笔记与记录 <ExternalLink size={14} /></a></div>
    <section className="notes-toolbar"><div className="filter-tabs">{categories.map((category) => <button key={category} className={active === category ? 'filter-tab active' : 'filter-tab'} onClick={() => setActive(category)}>{category}</button>)}</div><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记" /></label></section>
    <section className="notes-page-list">{filtered.length ? filtered.map((note, index) => <NoteRow key={note.title} note={note} index={index} />) : <div className="empty-state"><ListFilter size={20} /><p>还没有找到这条记录。</p></div>}</section>
    <article className="agent-paper"><h2>{agentPaper.title}</h2><p className="agent-paper-lead">{agentPaper.lead}</p><div className="agent-paper-grid">{agentPaper.sections.map((section, index) => <div key={section.title}><span>0{index + 1} / STUDY</span><h3>{section.title}</h3><p>{section.body}</p></div>)}</div><p className="agent-paper-conclusion"><strong>结论。</strong> {agentPaper.conclusion}</p></article>
    <div className="notes-footnote"><Command size={15} />更多笔记正在路上 <span>·</span> 最后更新于 2026.09</div>
  </div>
}

function ProjectsPage() {
  return <div className="page-wrap inner-page"><PageIntro kicker="项目" title={<>把好奇心，<em>做成东西。</em></>} intro="一些还在生长的小项目。它们不一定完整，但都有清楚的起点。" /><section className="projects-list">{projects.map((project, index) => <a href={project.url} target="_blank" rel="noreferrer" className="project-row" key={project.name}><span className="project-number">0{index + 1}</span><div className={`project-icon ${project.tone}`}><project.icon size={21} /></div><div className="project-copy"><div className="project-title"><h2>{project.name}</h2><span>{project.type}</span></div><p>{project.detail}</p></div><span className="project-state"><span className="status-dot" />{project.state}</span><ArrowUpRight className="project-arrow" size={18} /></a>)}</section><section className="project-cta"><div><h2>有一个问题，<br /><em>想一起拆开吗？</em></h2></div><a href="https://github.com/shisjsji" target="_blank" rel="noreferrer" className="button button-primary">联系我 <ArrowUpRight size={16} /></a></section></div>
}

function GalleryPage() {
  const [selected, setSelected] = useState(null)
  useEffect(() => { const onKey = (event) => { if (event.key === 'Escape') setSelected(null) }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [])
  return <div className="page-wrap inner-page gallery-page"><Link to="/" className="back-link"><ArrowLeft size={16} /> 回到首页</Link><PageIntro kicker="图库" title={<>一些<em>生活切片。</em></>} intro="风景和日常的草稿集。访客可以提交照片与简介；审核通过后，我会把照片整理进这里。" /><div className="gallery-actions"><a className="button button-primary" href={gallerySubmissionUrl} target="_blank" rel="noreferrer">提交照片 <ArrowUpRight size={15} /></a><a className="button button-quiet" href={galleryUploadUrl} target="_blank" rel="noreferrer">上传我的照片 <ExternalLink size={14} /></a><a className="gallery-edit-link" href={editorUrl('src/content/gallery.json')} target="_blank" rel="noreferrer">编辑标题与简介 <ExternalLink size={13} /></a></div><div className="gallery-grid">{gallery.map((item, index) => <button className={`gallery-card ${item.ratio}`} key={`${item.title}-${index}`} onClick={() => setSelected(item)}><img src={item.src} alt={item.title} /><span className="gallery-card-overlay"><small>{item.title}</small><strong>{item.note}</strong><ArrowUpRight size={17} /></span></button>)}</div>{selected && <div className="lightbox" role="dialog" aria-modal="true" aria-label={selected.title} onClick={() => setSelected(null)}><button className="lightbox-close" onClick={() => setSelected(null)} aria-label="关闭"><X size={20} /></button><div className="lightbox-image" onClick={(event) => event.stopPropagation()}><img src={selected.src} alt={selected.title} /><div><span>{selected.title}</span><small>{selected.note}</small></div></div></div>}</div>
}

function GuestbookPage() {
  return <div className="page-wrap inner-page guestbook-page"><Link to="/" className="back-link"><ArrowLeft size={16} /> 回到首页</Link><PageIntro kicker="访客留言" title={<>留下一句<em>想说的话。</em></>} intro="留言通过 GitHub 保存和展示。发布时会公开你的 GitHub 用户名与留言内容，请不要填写个人隐私。" /><GuestbookWidget /></div>
}

function GuestbookWidget({ compact = false }) {
  const [comments, setComments] = useState([])
  const [status, setStatus] = useState('loading')
  useEffect(() => {
    const controller = new AbortController()
    fetch('https://api.github.com/repos/shisjsji/lingluan-blog/issues/1/comments?per_page=8', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) throw new Error('留言暂时无法读取')
      return response.json()
    }).then((items) => {
      setComments(items
        .filter((item) => item.body?.trim() && item.user?.login)
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
        .slice(0, 8))
      setStatus('ready')
    }).catch((error) => {
      if (error.name !== 'AbortError') setStatus('error')
    })
    return () => controller.abort()
  }, [])
  return <section className={`guestbook-widget ${compact ? 'is-compact' : ''}`}>
    <div className="guestbook-heading"><div><span className="section-kicker">OPEN NOTES</span><h2>访客留言</h2></div><a className="button button-quiet" href={`${guestbookIssueUrl}#new_comment_field`} target="_blank" rel="noreferrer">写一句话 <ExternalLink size={14} /></a></div>
    <p className="guestbook-disclaimer">留言公开显示 GitHub 用户名与内容，请勿填写隐私信息。</p>
    {status === 'loading' && <div className="guestbook-state">正在读取留言…</div>}
    {status === 'error' && <div className="guestbook-state">暂时无法读取留言。<a href={guestbookIssueUrl} target="_blank" rel="noreferrer">前往 GitHub 查看和留言 <ArrowUpRight size={14} /></a></div>}
    {status === 'ready' && comments.length === 0 && <div className="guestbook-state">还没有留言，来写下第一句吧。</div>}
    {status === 'ready' && comments.length > 0 && <div className="guestbook-list">{comments.map((comment) => <article className="guestbook-entry" key={comment.id}><div className="guestbook-entry-meta"><a href={`https://github.com/${encodeURIComponent(comment.user.login)}`} target="_blank" rel="noreferrer">@{comment.user.login}</a><time dateTime={comment.created_at}>{new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(comment.created_at))}</time></div><p>{comment.body.length > 700 ? `${comment.body.slice(0, 700)}…` : comment.body}</p></article>)}</div>}
  </section>
}

function NotFoundPage() { const navigate = useNavigate(); return <div className="not-found page-wrap"><span className="section-kicker">404 / LOST IN THE WIND</span><h1>这页还没有<br /><em>被写出来。</em></h1><p>也许它正在某个草稿里等待下一次打开。</p><button className="button button-primary" onClick={() => navigate('/')}>回到首页 <ArrowUpRight size={16} /></button></div> }

function Footer() { return <footer className="footer page-wrap"><div className="footer-brand"><span className="brand-mark"><span /></span><div><strong>凌乱的风<span className="ampersand">&</span></strong><span>记录正在发生的事。</span></div></div><div className="footer-links"><a href="https://github.com/shisjsji" target="_blank" rel="noreferrer" aria-label="GitHub" className="social-mark">GH</a><a href="https://www.coolapk.com/u/30432128" target="_blank" rel="noreferrer" aria-label="酷安"><Layers3 size={17} /></a><Link to="/gallery" className="footer-gallery">图库 <ArrowUpRight size={14} /></Link><Link to="/guestbook" className="footer-gallery">访客留言 <ArrowUpRight size={14} /></Link></div><span className="footer-copy">© 2026 · Made with curiosity</span></footer> }

export default function Root() { return <HashRouter><App /></HashRouter> }

createRoot(document.getElementById('root')).render(<Root />)
