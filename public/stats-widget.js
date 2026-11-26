/* 站点统计小组件
 *
 * 三站共用一份。用 Shadow DOM 装起来，页面自己的 CSS 进不来，我的也出不去，
 * 这样既不会被站点样式改坏，也不会污染站点。
 *
 * 用法：
 *   <script src="https://lingluandf.online/stats-widget.js"
 *           data-site="blog|aurora|chaoxing"
 *           data-accent="#b4553f"
 *           defer></script>
 *
 * 接口挂了、脚本报错、网络断了，一律静默——页面上什么都不显示，不影响阅读。
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var SITE = script.getAttribute('data-site') || 'blog';
  var ACCENT = script.getAttribute('data-accent') || '#6b7280';
  var ACCENT_DARK = script.getAttribute('data-accent-dark') || ACCENT;
  // scope=total：博客是总入口，展示三站合计而不是自己那一格
  var SCOPE = script.getAttribute('data-scope') || 'site';
  var API = (script.src ? new URL(script.src).origin : location.origin) + '/neural-api';

  // ---------- 匿名访客号 ----------
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
      return ''; // 隐私模式下 localStorage 可能直接抛错，那就干脆不报
    }
  }

  var VID = visitorId();

  function report(type) {
    if (!VID) return;
    var body = JSON.stringify({ site: SITE, type: type, vid: VID, path: location.pathname });
    try {
      if (navigator.sendBeacon) {
        // 不带自定义头，避免触发预检；跨域也能发
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(API + '/stats/event', blob)) return;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      fetch(API + '/stats/event', { method: 'POST', body: body, keepalive: true, mode: 'cors' }).catch(function () {});
    } catch (e) { /* 静默 */ }
  }

  // ---------- 样式 ----------
  var CSS = [
    ':host{all:initial}',
    '.wrap{position:fixed;left:14px;bottom:14px;z-index:30;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
    '  font-size:11px;line-height:1;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:9px;',
    '  padding:8px 10px 7px;max-width:210px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(9px);box-shadow:0 4px 14px rgba(0,0,0,.05);',
    '  opacity:.9;transition:opacity .2s ease;user-select:none}',
    '.wrap:hover{opacity:1}',
    '.row{display:flex;gap:12px;align-items:flex-end}',
    '.cell{display:flex;flex-direction:column;gap:4px;min-width:40px}',
    '.k{font-size:9px;letter-spacing:.06em;color:var(--muted);white-space:nowrap}',
    '.v{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:var(--fg)}',
    '.v i{font-style:normal;color:var(--accent)}',
    '.foot{margin-top:7px;font-size:9px;color:var(--muted);display:flex;gap:6px;align-items:center}',
    '.dot{width:4px;height:4px;border-radius:50%;background:var(--accent);opacity:.75;flex:none}',
    '.x{position:absolute;top:2px;right:3px;width:15px;height:15px;border:0;background:transparent;color:var(--muted);',
    '  font-size:11px;line-height:1;cursor:pointer;padding:0;opacity:0;transition:opacity .15s}',
    '.wrap:hover .x{opacity:.7}',
    '.hide{display:none}',
    '@media(max-width:520px){.wrap{left:10px;bottom:10px;padding:7px 9px 6px}.row{gap:10px}.v{font-size:13px}.cell{min-width:34px}}',
  ].join('');

  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // ---------- 挂载 ----------
  var host = document.createElement('div');
  host.style.display = 'none'; // 有数据才显示，没数据宁可什么都不出现
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  var box = document.createElement('div');
  box.className = 'wrap';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-label', '访问与下载统计');
  root.appendChild(box);

  function paint() {
    var dark = isDark();
    box.style.setProperty('--fg', dark ? '#e7e9e7' : '#1f2933');
    box.style.setProperty('--muted', dark ? '#9aa0a6' : '#6b7280');
    box.style.setProperty('--bg', dark ? 'rgba(22,24,23,.9)' : 'rgba(255,255,255,.95)');
    box.style.setProperty('--line', dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.1)');
    box.style.setProperty('--accent', dark ? ACCENT_DARK : ACCENT);
    // 页面切主题时跟着变
    if (paint.prev !== dark) { paint.prev = dark; }
  }

  var state = { pv: 0, click: 0, dl: 0, todayPv: 0, at: null };

  function render() {
    var ago = state.at ? Math.max(1, Math.round((Date.now() - state.at) / 1000)) : 0;
    box.innerHTML = '';
    var x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.title = '不再显示';
    x.textContent = '×';
    x.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      host.style.display = 'none';
      try { localStorage.setItem('sw_hidden_v1', '1'); } catch (e) {}
    });
    box.appendChild(x);

    var row = document.createElement('div');
    row.className = 'row';
    [['首页点击', state.pv], ['下载点击', state.click], ['完成下载', state.dl]].forEach(function (pair) {
      var cell = document.createElement('div');
      cell.className = 'cell';
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = pair[0];
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = fmt(pair[1]);
      cell.appendChild(k);
      cell.appendChild(v);
      row.appendChild(cell);
    });
    box.appendChild(row);

    var foot = document.createElement('div');
    foot.className = 'foot';
    var dot = document.createElement('span');
    dot.className = 'dot';
    var txt = document.createElement('span');
    txt.textContent = state.todayPv ? '今日 ' + fmt(state.todayPv) + ' 次访问' : '今日暂无访问';
    foot.appendChild(dot);
    foot.appendChild(txt);
    box.appendChild(foot);
  }

  function load() {
    if (document.hidden) return;
    fetch(API + '/stats/summary', { mode: 'cors', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok || !d.sites || !d.sites[SITE]) return;
        var mine = SCOPE === 'total' ? d.total : d.sites[SITE];
        if (!mine) return;
        state.pv = (mine.total && mine.total.pv) || 0;
        state.click = (mine.total && mine.total.click) || 0;
        state.dl = (mine.total && mine.total.downloads) || 0;
        state.todayPv = (mine.today && mine.today.pv) || 0;
        state.at = Date.now();
        paint();
        render();
        host.style.display = '';
      })
      .catch(function () { /* 静默：接口不通就不显示 */ });
  }

  function boot() {
    try {
      if (localStorage.getItem('sw_hidden_v1') === '1') return;
    } catch (e) {}

    (document.body || document.documentElement).appendChild(host);

    // 一个会话只报一次浏览，避免来回切页把数字刷高
    try {
      if (!sessionStorage.getItem('sw_sent_v1')) {
        sessionStorage.setItem('sw_sent_v1', '1');
        report('view');
      }
    } catch (e) {
      report('view');
    }

    // 点下载链接时记一次点击（含从 GitHub/网盘跳走的，只要是包）
    document.addEventListener('click', function (ev) {
      var el = ev.target;
      while (el && el !== document.body) {
        if (el.tagName === 'A') {
          var href = el.getAttribute('href') || '';
          if (/\.(apk|zip)(\?|$)/i.test(href) || /\/dl\//.test(href) || /\/download\//.test(href)) {
            report('download_click');
          }
          break;
        }
        el = el.parentNode;
      }
    }, { passive: true });

    load();
    // 20 秒一次就够「实时」，又不至于把服务器和电量当回事
    setInterval(load, 20000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();