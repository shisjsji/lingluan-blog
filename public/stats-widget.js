/* 下载量徽标
 *
 * 贴在下载按钮旁边，显示历史累计下载次数，有真实装机数据的再加一个在用设备数。
 * 不做浮动面板，不遮挡页面内容。
 *
 * 用法：
 *   <script src="https://lingluandf.online/stats-widget.js" data-site="aurora" defer></script>
 *
 * 站点归属按链接判断：/dl/ 归超星，apk 与 /download/ 归 AURORA。
 * 也可以用 data-download-badge="aurora" 明确指定某一块显示哪个站的数
 * （博客的项目卡就是这么用的）。
 *
 * 接口不通、脚本报错、网络断掉，一律静默——页面上什么都不加。
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var DEFAULT_SITE = script.getAttribute('data-site') || '';
  var API = (script.src ? new URL(script.src).origin : location.origin) + '/neural-api';

  // ---------- 匿名访客号（保留浏览统计，只是不再展示点击数字）----------
  function visitorId() {
    try {
      var KEY = 'sw_vid_v1';
      var id = localStorage.getItem(KEY);
      if (!id || id.length < 8) {
        id = '';
        var bytes = new Uint8Array(9);
        (window.crypto || window.msCrypto).getRandomValues(bytes);
        for (var i = 0; i < bytes.length; i += 1) id += ('0' + bytes[i].toString(16)).slice(-2);
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (e) {
      return '';
    }
  }

  var VID = visitorId();

  function report(type) {
    if (!VID) return;
    var body = JSON.stringify({ site: DEFAULT_SITE || 'blog', type: type, vid: VID, path: location.pathname });
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(API + '/stats/event', blob)) return;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      fetch(API + '/stats/event', { method: 'POST', body: body, keepalive: true, mode: 'cors' }).catch(function () {});
    } catch (e) { /* 静默 */ }
  }

  // ---------- 数字格式 ----------
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 10000) {
      var w = n / 10000;
      return (w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')) + ' 万';
    }
    return String(n);
  }

  // ---------- 样式：跟着站点自己的字体和颜色走 ----------
  var CSS = [
    '.swb{display:inline-flex;align-items:baseline;gap:5px;margin-left:10px;',
    '  font:inherit;font-size:.82em;line-height:1.25;letter-spacing:.01em;white-space:nowrap;',
    '  color:inherit;opacity:.62;vertical-align:middle;font-variant-numeric:tabular-nums;',
    '  -webkit-font-smoothing:antialiased}',
    '.swb em{font-style:normal;font-weight:600;opacity:1}',
    '.swb .sep{opacity:.45}',
    '@media(max-width:600px){.swb{font-size:.78em;margin-left:8px}}',
  ].join('');

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // ---------- 找要贴徽标的元素 ----------
  function siteOfHref(href) {
    if (!href) return null;
    if (/\/dl\//.test(href)) return 'chaoxing';
    if (/\/download\//.test(href) || /\.apk(\?|$)/i.test(href) || /\/aurora\//.test(href)) return 'aurora';
    return null;
  }

  function targets() {
    var list = [];
    // 显式指定的块（博客项目卡之类）
    document.querySelectorAll('[data-download-badge]').forEach(function (el) {
      list.push({ el: el, site: el.getAttribute('data-download-badge') });
    });
    // 下载链接：跳过导航栏里的那个，那儿太挤
    document.querySelectorAll('a[href]').forEach(function (a) {
      if (a.closest('nav')) return;
      if (a.hasAttribute('data-download-badge')) return;
      var site = siteOfHref(a.getAttribute('href'));
      if (site) list.push({ el: a, site: site });
    });
    return list;
  }

  var nodes = [];

  function paint(stats) {
    targets().forEach(function (t) {
      if (!t.el || !t.el.parentNode) return;
      var s = stats[t.site];
      if (!s || !s.downloads) return;

      var badge = t.el.nextElementSibling;
      if (!badge || !badge.classList || !badge.classList.contains('swb')) {
        badge = document.createElement('span');
        badge.className = 'swb';
        t.el.insertAdjacentElement('afterend', badge);
      }

      var html = '已下载 <em>' + fmt(s.downloads) + '</em>';
      if (s.installs) html += '<span class="sep">·</span>在用 <em>' + fmt(s.installs) + '</em>';
      if (badge.innerHTML !== html) badge.innerHTML = html;
      nodes.push({ el: t.el, badge: badge });
    });
  }

  function load() {
    if (document.hidden) return;
    fetch(API + '/stats/summary', { mode: 'cors', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok || !d.sites) return;
        paint(d.sites);
      })
      .catch(function () { /* 静默 */ });
  }

  function boot() {
    // 浏览统计：一个会话一条，够用来算历史访问量
    try {
      if (!sessionStorage.getItem('sw_sent_v1')) {
        sessionStorage.setItem('sw_sent_v1', '1');
        report('view');
      }
    } catch (e) {
      report('view');
    }

    load();
    // 字体和布局可能后加载完，晚一点再补一次，避免漏贴
    setTimeout(load, 1200);
    setInterval(load, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();