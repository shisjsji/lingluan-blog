# 个人博客 + 阿里云服务器 · CONTEXT

一句话摘要：一个「内容存 JSON 的 Vite+React 纯静态站 + 自建 Node 后台 + GitHub Actions rsync 到阿里云香港 ECS nginx」的自托管博客，本机还挂着一个 MiMoCode 定时任务痕迹。

元信息：本文由本地仓库 `C:\Users\lldf\XiaomiMiMoProjects\个人博客` 静态阅读得出（master @ `40cc266`，工作区干净）；**未连接服务器、未执行 SSH/rsync/构建**，服务器上的实际状态一律未核实，凡涉及线上真实情况均在「待确认」列出。

---

## 1. 目标

- 做一个**纯静态**个人博客，构建后发布到自有服务器，而不是托管在 GitHub Pages：README 明写「这是一个 Vite + React 个人博客，构建为静态站点后发布到自有服务器，使用 `HashRouter` 保证静态托管下的多页路由可用」（证据：`README.md` — "构建为静态站点后发布到自有服务器"）。GitHub Pages 已废弃（证据：`README.md` — "GitHub Pages 已停用"；`git log` — `e983b03 Deploy to own server instead of GitHub Pages`）。
- 内容与代码分离：正文全部来自仓库内的 JSON 数据文件，构建时打进 bundle（证据：`src/main.jsx` — `import siteContent from './content/site-content.json'`；`src/content/site-content.json` 内含 `about/notes/agentPaper`）。
- 自己造一个轻量后台，能改内容、传图、一键发布，不引入 CMS（证据：`admin/server.js` — "轻量博客后台：内容编辑 + 图片上传 + 一键发布"）。
- 这台服务器同时是「后面要部署的后端服务和数据库」的落脚点（证据：`AGENTS.md` — "这台服务器托管本站，以及后续要部署的后端服务和数据库"）。
- 访客留言与图库投稿不落在博客自己的数据库上，而是借 GitHub Issues（证据：`README.md` — "访客留言与图片投稿由 GitHub Issues 保存"；`src/main.jsx` — `fetch('https://api.github.com/repos/shisjsji/lingluan-blog/issues/1/comments?per_page=8'`）。
- 主人自述该项目当前**缺监控、缺备份**（来源：本次任务背景陈述，非仓库证据）；仓库里确实不存在任何监控/备份相关文件（证据：全仓库文件清单仅 `src/`、`admin/`、`public/`、`.github/`、`.mimocode/` 与 5 个根文件）。

## 2. 已完成

- 前端 7 条路由全部落地：`/`、`/about`、`/notes`、`/projects`、`/gallery`、`/guestbook`、`*` 兜底 404（证据：`src/main.jsx` — `<Route path="/guestbook" element={<GuestbookPage />} />`）。
- 视觉与交互：Miuix 风格卡片/顶栏、明暗主题（写 `localStorage` 的 `feng-theme`）、移动端抽屉导航、DotGrid 动态背景、图库 lightbox（证据：`README.md` — "视觉采用 Miuix 的轻量卡片、列表排布和顶栏语义"；`src/main.jsx` — `document.documentElement.dataset.theme = dark ? 'dark' : 'light'`）。
- 后台后端已成型，路由齐全：`/admin/api/login`、`/me`、`/logout`、`/content`(GET/POST)、`/upload`、`/publish`、`/publish/status`（证据：`admin/server.js` — `if (p === '/admin/api/publish/status')` 等分支）。
- 后台前端单页已成型，五个页签覆盖内容全貌：笔记列表、关于我、图库、Agent 文章（证据：`admin/public/index.html` — `id="tab-notes"`、`id="tab-about"`、`id="tab-gallery"`、`id="tab-paper"`；"技能（JSON 数组）" 等字段以 textarea 直编 JSON）。
- 一键发布已实现为服务器本机构建 + 同步：`cd /opt/blog && pnpm build && rsync -a --delete dist/ /var/www/lingluan-blog/`，带 300s 超时与结果日志（证据：`admin/server.js` — `const cmd = \`cd ${BLOG} && pnpm build 2>&1 && rsync -a --delete dist/ /var/www/lingluan-blog/ 2>&1\``）。
- CI/CD 自动部署已接：push master/main 或手动触发，Node 24 + pnpm 9，构建后 rsync 到 `/var/www/lingluan-blog/`（证据：`.github/workflows/deploy.yml` — `branches: [master, main]`、`node-version: 24`、`dist/ root@47.238.233.55:/var/www/lingluan-blog/`）。
- 域名与 HTTPS 已完成：`lingluandf.online`，Let's Encrypt 自动续期（证据：`README.md` — "HTTPS 由 Let's Encrypt 签发并自动续期"；`AGENTS.md` — "certbot 定时任务自动续期"）。
- 443 端口分流已完成：TLS → nginx `127.0.0.1:8443`，非 TLS → `127.0.0.1:22` sshd（证据：`AGENTS.md` — "TLS 流量（ClientHello）→ `127.0.0.1:8443`"；`git log` — `dbd5f30 Also listen SSH on port 443`、`f79bfa9 Enable HTTPS on custom domain`）。
- 图库素材已入库 6 张 + 头像，清单与文件对得上（证据：`src/content/gallery.json` 6 条记录；`public/images/gallery/` 下 `coast/forest/lake/mountains/valley/waterfall.jpg`）。
- 访客投稿模板已建（证据：`.github/ISSUE_TEMPLATE/gallery-submission.yml` — `title: "照片投稿："`）。
- 本地存在一次构建产物（证据：`dist/assets/index-A5SPmI2D.js`、`dist/assets/index-NAwxCAPR.css`、`dist/index.html`）。
- 部署约定文档已写给 agent 读（证据：`AGENTS.md` — "服务器部署说明（给协助部署的 agent 阅读）"）。

## 3. 关键决策

- **HashRouter 而非 BrowserRouter**：静态 nginx 下免去 `try_files` 回退配置，深链接不会 404（证据：`README.md` — "使用 `HashRouter` 保证静态托管下的多页路由可用"；`src/main.jsx` — `export default function Root() { return <HashRouter><App /></HashRouter> }`）。
- **相对资源路径**：`base: './'` 让产物可在任意子路径前缀下工作（证据：`vite.config.js` — `base: './'`）。
- **单文件页面组件**：23KB 的 `main.jsx` 一把梭，只有 DotGrid 拆成独立组件（证据：`src/main.jsx` 23138 字节；`src/components/DotGrid.jsx` 为唯一组件目录文件）。
- **后台零依赖**：只用 Node 内置 `http/fs/path/crypto/child_process`，`admin/package.json` 连 dependencies 字段都没有（证据：`admin/package.json` — `{"name":"blog-admin","private":true,"type":"commonjs"}`）。
- **鉴权用 sha256 口令 + 内存 session**：密码哈希走环境变量，session 存进程内 Map、TTL 8h、cookie `HttpOnly; SameSite=Strict`（证据：`admin/server.js` — `const PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim()`、`Set-Cookie: sid=${sid}; Path=/admin; HttpOnly; SameSite=Strict`）。**该 env 文件含密钥，不展开**（证据：`AGENTS.md` — 禁止读改 `/etc/blog-admin/env`）。
- **服务只监听回环，由 nginx 反代暴露**：`server.listen(PORT, '127.0.0.1', ...)`，`/admin/` 对外走反代（证据：`admin/server.js` — "仅监听 127.0.0.1，由 nginx 反代到 /admin/"；`AGENTS.md` — "`blog-admin`：监听 `127.0.0.1:3001`，博客后台，仅本机访问"）。
- **两条内容更新通道并存**：GitHub 网页改 JSON 触发 Actions，或登录后台改后点发布（证据：`README.md` — "也可以登录后台 `https://lingluandf.online/admin/` 直接编辑内容并发布"）。
- **新软件统一放 `/opt/apps/<项目名>`，端口必须放行 ufw + 阿里云安全组两层**（证据：`AGENTS.md` — "**新增端口必须放行两层**：服务器上的 ufw 和阿里云控制台的安全组"）。

## 4. 踩过的坑

- **443 不只归 nginx，SSH 也在 443**：容易在改 nginx 时切断自己的 shell（证据：`AGENTS.md` — "所以 SSH 和网站共用 443，不要以为 443 只归 nginx"；`git log` — `dbd5f30 Also listen SSH on port 443`）。
- **22 端口从国内访问被链路干扰**，曾开 2222 兜底（证据：`AGENTS.md` — "22 端口从国内访问会被链路干扰，443 是唯一稳定通道"；`git log` — `ea1cb5f Open SSH port 2222 for fallback access`）。
- **`rsync --delete` 会清掉手工放进站点目录的文件**，所以不能改产物只能改源码（证据：`AGENTS.md` — "注意 `--delete` 会清掉站点目录里不在 `dist` 中的文件，这是预期行为"；同文禁止事项 "在 `/var/www/lingluan-blog` 里手工放文件"）。
- **连不上不等于服务器坏了**：代理软件 TUN 模式会劫持 SSH，ping 通但端口不通是链路问题；明确规定不许因此重启或改 sshd（证据：`AGENTS.md` — "**不要**因为连不上就重启服务器或修改 sshd 配置"）。
- **头像被浏览器缓存遮住**，靠改文件名破缓存（证据：`git log` — `c896fe8 Rename avatar file so the new icon is not masked by image cache`）。
- **GitHub Pages 时代的路径包袱还在**：代码里保留着 `/lingluan-blog` 前缀判断分支（证据：`src/main.jsx` — `window.location.pathname.startsWith('/lingluan-blog') ? '/lingluan-blog/' : import.meta.env.BASE_URL`），回看历史对应 `e017901 Handle Pages deep link asset paths`、`22eaa29 Fix GitHub Pages asset paths`。
- **Actions 的 rsync 走默认 22 端口，与「22 不稳定、443 唯一稳定」的约定相冲突**：`deploy.yml` 只做了 `ssh-keyscan -H 47.238.233.55`，`rsync -e` 未带 `-p`（证据：`.github/workflows/deploy.yml` — `-e "ssh -i ~/.ssh/deploy_key -o UserKnownHostsFile=~/.ssh/known_hosts"`，无端口参数），而 `AGENTS.md` 要求端口 443。(推断) GitHub runner 出网正常时未必受影响，但这是两处文档口径不一致处。
- **后台发布是同步阻塞式 shell**，构建失败只留在 `publishState.last.output` 末尾 2000 字符里，没有告警（证据：`admin/server.js` — `output: (stdout + stderr).slice(-2000)`）。(推断) 线上挂了不会有人被通知。
- **Node 大版本被钉死在 24**，本地/CI/服务器三处版本漂移会炸（证据：`.github/workflows/deploy.yml` — `node-version: 24`；`git log` — `2aa2b18 Pin dependency versions and build on Node 24`）。

## 5. 当前待办

**仓库里已确认存在的（事实）**

- 后台缺少健康检查/自检端点：`server.js` 路由表里没有 `/health`、`/healthz`、`/admin/api/health` 一类入口（证据：`admin/server.js` 全部 `if (p === ...)` 分支中无健康检查路径）。
- CI 只做「构建 + 同步」，没有任何部署后验证步骤（证据：`.github/workflows/deploy.yml` 仅 Checkout → pnpm → Node → Install → Build → SSH → rsync 七步）。
- 仓库内不存在任何 systemd unit、cron、备份脚本、监控配置；`.mimocode/` 里只有一个 pid 锁和一个只写忽略规则的 `.gitignore`（证据：`.mimocode/.cron-lock` — `{"pid":6520,"startedAt":1793345001194}`；`.mimocode/.gitignore` 忽略 `scheduled_tasks.json`）。(推断) 本机跑过 MiMoCode 定时任务，但任务定义没入库也读不到。
- 本机待处理：`.mimocode/.cron-lock` 残留 pid，若进程已退出属陈旧锁（推断）。

**建议新增的（我的建议，仓库里没有）**

- CI 加一步「部署后断言」：`curl -fsS https://lingluandf.online/ | grep -q '凌乱的风'` + 证书到期天数检查，失败即 job 红。
- `blog-admin` 加 `GET /admin/api/health`，返回 uptime、`/opt/blog` 的 HEAD commit、`/var/www` 最后修改时间、磁盘余量；供外部探活调用。
- 服务器侧 systemd timer 做备份：`/opt/blog`（git 仓库，可直接 `git bundle`）+ `/var/www/lingluan-blog` + `/etc/nginx` + `/etc/blog-admin/env`（**含密钥，必须加密后再出机**）；按 AGENTS.md 的禁止清单，读 env 要先问主人。
- nginx 侧接 `access.log/error.log` + logrotate + 简单的 5xx 计数脚本；证书到期用 `certbot certificates` 或 openssl 自查而不只依赖自动续期。
- 因为博客与 AstrBot QQ 机器人同机（**来源：任务背景陈述，仓库未记载**），任何重启/部署动作都要先确认不会连带打断机器人——这与仓库已有的「不要停止 nginx、blog-admin」属于同类风险。

## 6. 相关文件路径

| 路径 | 作用 |
| --- | --- |
| `README.md` | 站点定位、设计说明、部署方式、内容更新方式 |
| `AGENTS.md` | **最重要**：服务器连接方式、目录布局、服务清单、部署命令、禁止事项 |
| `.github/workflows/deploy.yml` | 唯一 CI：构建 + rsync 部署 |
| `.github/ISSUE_TEMPLATE/gallery-submission.yml` | 图库投稿 Issue 表单 |
| `admin/server.js` | 后台全部后端逻辑（登录/内容/上传/发布） |
| `admin/public/index.html` | 后台单页 UI，`fetch('/admin/api' + path)` 调用后端 |
| `admin/package.json` | 仅声明 commonjs，无依赖 |
| `src/main.jsx` | 全部页面与组件（23000+ 字节单文件） |
| `src/content/site-content.json` | 关于我 / 笔记 / Agent 文章正文 |
| `src/content/gallery.json` | 图库清单（file/title/note/ratio） |
| `src/components/DotGrid.jsx` | 唯一独立组件，动态点阵背景 |
| `src/styles.css`、`src/refine.css` | 主样式与细化样式 |
| `vite.config.js` | `base: './'` + react 插件 |
| `package.json` | 脚本 `dev/build/preview`，React 19 + react-router 7 + gsap |
| `public/images/avatar.jpg`、`public/images/gallery/*.jpg` | 静态图片资源 |
| `dist/` | 本地构建产物（`index.html` + `assets/index-*.js|css` + images） |
| `.mimocode/` | 本机 MiMoCode 定时任务痕迹（锁文件 + 忽略规则） |

## 待确认

1. **服务器上 `/opt/blog` 当前停在哪个 commit**，是否等于本地 master `40cc266` —— 未连服务器，无法核实。
2. **`/var/www/lingluan-blog` 的线上内容**是否与某次 `dist` 一致，Actions 与后台发布谁最后动过。
3. **Actions 的 rsync 走 22 端口是否真的能连通**：`deploy.yml` 未带 `-p 443`，与 `AGENTS.md`「22 被干扰、443 唯一稳定」口径冲突；最近的部署是成功还是失败，仓库里看不出来。
4. **`secrets.DEPLOY_SSH_KEY` 用的是哪把密钥**（是否就是 `~/.ssh/id_ed25519_agents`）、是否仍在 `authorized_keys` 中 —— 属凭据，未读也未验证。
5. **`blog-admin` 的实际运行状态**：systemd unit 是否 enabled、`/etc/blog-admin/env` 是否存在（不读内容）、server 是否还在 3001。
6. **nginx 实际配置**：`/etc/nginx/sites-available/lingluan-blog` 的 root/location、`/etc/nginx/stream-ssh-https.conf` 的分流规则是否仍如文档所述。
7. **HTTPS 证书到期日与 certbot timer 是否 active**；续期是否真跑过。
8. **服务器资源现状**：2 核 4G / 40G 系统盘还剩多少，磁盘水位决定备份能不能落在本机。
9. **AstrBot 是否确实在这台机器上**、用哪个端口、是否与博客争资源 —— 任务背景说同机，仓库里完全没有它的痕迹。
10. **是否已有外部监控**（阿里云云监控、拨测、OSS 备份）在跑；主人说的「缺监控、缺备份」是完全没有，还是只缺自建部分。
11. **备份目标与 RPO/RTO**：放本地盘、OSS 还是异地；多久一次；密钥文件是否纳入备份（涉及 `/etc/blog-admin/env`，需主人拍板）。
12. **`.mimocode` 的定时任务内容**：`scheduled_tasks.json` 被 `.gitignore` 排除，本地未见，`.cron-lock` 里 pid `6520` 是否还活着未知。
13. **admin 后台密码哈希有过几次轮换**、session 是否会因重启全部失效（内存 Map，重启即登出，属预期但需确认是否可接受）。