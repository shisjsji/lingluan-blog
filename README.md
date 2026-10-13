# 凌乱的风& · Personal Blog

这是一个面向 GitHub Pages 的 Vite + React 个人博客设计稿，使用 `HashRouter` 保证静态托管下的多页路由可用。

## 本地运行

```bash
pnpm install
pnpm dev
```

## 设计排版

- 首页以头像和「你好，我是凌乱的风&」为第一视觉，下面依次是身份数据、近期动态、精选笔记与图库入口。
- 关于页用个人故事、技能分组和时间线建立完整人物信息，适合桌面双栏和移动单列阅读。
- 笔记页以可扫描的列表呈现学习记录，项目页用更紧凑的项目行承载作品链接，图库从首页的「进入图库」小入口进入。
- 视觉采用 Miuix 的轻量卡片、列表排布和顶栏语义：暖白背景、深墨文字、珊瑚橙强调色、8-14px 微圆角与低强度阴影。

## 组件核实与本站用途

以下组件名称与页面均已在官方文档核实；Miuix 仅借鉴设计语言，未在网页中直接复用 Android/Compose 代码。

| 来源 | 官方文档 | 本站用途 |
| --- | --- | --- |
| React Bits Profile Card | https://reactbits.dev/components/profile-card | 首页头像、姓名、身份和外部主页构成个人主视觉 |
| React Bits Masonry | https://reactbits.dev/components/masonry | 图库的错落瀑布流；官方组件依赖 GSAP |
| React Bits Split Text | https://reactbits.dev/text-animations/split-text | 首页姓名标题逐字出现；官方安装示例与 GSAP 依赖见安装页 https://reactbits.dev/get-started/installation |
| Miuix Card | https://compose-miuix-ui.github.io/miuix/zh_CN/components/card | 头像信息块、笔记与项目条目的边界和按压反馈 |
| Miuix TopAppBar | https://compose-miuix-ui.github.io/miuix/zh_CN/components/topappbar | 顶部导航的层级、留白与滚动时的轻量固定感 |
| Miuix NavigationBar | https://compose-miuix-ui.github.io/miuix/zh_CN/components/navigationbar | 移动端底部快捷导航的节奏参考 |
| Miuix IconButton | https://compose-miuix-ui.github.io/miuix/zh_CN/components/iconbutton | 菜单、返回、主题切换等紧凑工具按钮 |
| Miuix SmallTitle | https://compose-miuix-ui.github.io/miuix/zh_CN/components/smalltitle | 个人信息与时间线中的小标题层级 |

## GitHub Pages

网站已通过 GitHub Actions 发布到 https://shisjsji.github.io/lingluan-blog/ 。推送到 `master` 后会自动重新构建。

图库草稿使用风景照片并已保存到 `public/images/gallery`，后续可替换目录下的图片，并更新 `src/content/gallery.json`。
## 网站内容与互动管理

网站使用 GitHub Pages 托管。访客留言与图片投稿由 GitHub Issues 保存，笔记、Agent 文章和图库说明由仓库内容文件管理。

## 更新网站内容

- 笔记与 Agent 文章：编辑 `src/content/site-content.json`。
- 图库标题与简介：编辑 `src/content/gallery.json`。
- 自己上传的图片：上传到 `public/images/gallery/`，并在 `gallery.json` 中加入对应文件名、标题、简介和布局比例。
- 在 GitHub 网页提交修改后，Actions 会自动重新构建并发布 GitHub Pages。

## 访客投稿与留言

- 访客从图库的“提交照片”入口创建 GitHub Issue，再在评论区附上图片。投稿需要审核，审核通过后再复制到图库目录并更新清单。
- 留言保存在固定的 GitHub Issue 中。网站只读取公开评论，写留言会跳转到 GitHub。
- 访客需要 GitHub 账号；GitHub 用户名和评论内容会公开显示。请不要在留言或投稿中填写隐私信息。
