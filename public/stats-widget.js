/* 下载量行内徽标
 *
 * 贴在真实下载入口旁边，显示历史累计下载次数；有真实去重装机数据的站点再补一个在用数。
 * 不做独立面板，不做今日/月报，不显示浏览或点击数字。
 *
 * 口径：
 *   「N 已下载」永远来自服务器上的真实传输统计（下载日志折算），点击不参与累加。
 *   点下载的瞬间只给一个临时的「+1 下载中」提示，等接口确认总数上涨后它自动消失，
 *   超时没等到就变成「+1 待确认」并淡出。它不改变 N，也不做任何加成。
 *
 * 用法：
 *   <script src=".../stats-widget.js?v=3" data-site="aurora" defer></script>
 *   <a href="...apk" data-download-badge="aurora">下载 APK</a>
 *
 * 归属只认两种来源：显式标注 data-download-badge，或经过 host/path 校验的真实包链接。
 * 接口不通、脚本报错、网络断掉，一律静默——页面照常，徽标留空而不是显示 0。
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var DEFAULT_SITE = script.getAttribute('data-site') || '';
  var ORIGIN = script.src ? new URL(script.src).origin : location.origin;
  var API = ORIGIN + '/neural-api';

  var SLOW_POLL = 60000;   // 平时 60 秒对齐一次
  var FAST_POLL = 5000;    // 点过下载之后加快，等确认
  var FAST_WINDOW = 90000;
  var PENDING_TO_WAIT = 15000;  // 这么久没确认就改口「待确认」
  var PENDING_TTL = 120000;     // 再久就淡出

  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var stats = null;        // 最后一次确认的响应
  var reqSeq = 0;
  var fastUntil = 0;
  var slowTimer = null;
  var fastTimer = null;

  // ---------- 站点归属 ----------
  function inferSite(href) {
    if (!href) return null;
    var u;
    try { u = new URL(href, location.href); } catch (e) { return null; }
    // 只认官方域名，避免把 GitHub、导航、外链误当成下载
    var host = u.hostname;
    var official = host === 'lingluandf.online' || host === 'www.lingluandf.online' ||
                   host === 'aurora.lingluandf.online' || host === 'chaoxingxxt.lingluandf.online';
    if (!official) return null;
    if (u.pathname.indexOf('/dl/') === 0 && /\.(exe|zip|apk)$/i.test(u.pathname)) return 'chaoxing';
    if (u.pathname.indexOf('/download/') === 0 && /\.apk$/i.test(u.pathname)) return 'aurora';
    if (u.pathname.indexOf('/aurora/') === 0 && /\.apk$/i.test(u.pathname)) return 'aurora';
    return null;
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

  // ---------- 机械翻页：上半片翻出、下半片翻入 ----------
  function flip(el, text, half) {
    if (!el) return;
    if (!reduceMotion || reduceMotion.matches || typeof el.animate !== 'function') {
      el.textContent = text;
      return;
    }
    if (el._flipping) {
      el.textContent = text;
      return;
    }
    el._flipping = true;
    var out = el.animate(
      [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(-90deg)' }],
      { duration: half, easing: 'cubic-bezier(.4,0,.9,.6)' }
    );
    out.onfinish = function () {
      el.textContent = text;
      var back = el.animate(
        [{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(0deg)' }],
        { duration: half, easing: 'cubic-bezier(.1,.6,.4,1)' }
      );
      back.onfinish = function () { el._flipping = false; };
    };
  }

  // ---------- 样式 ----------
  var CSS = [
    '.swb{display:inline-flex;align-items:baseline;gap:6px;margin-left:10px;',
    '  font:inherit;font-size:.95em;line-height:1.25;letter-spacing:.01em;white-space:nowrap;',
    '  color:var(--swb-fg,rgba(0,0,0,.7));vertical-align:middle;font-variant-numeric:tabular-nums}',
    '.swb-n{color:var(--swb-fg-strong,currentColor)}',
    '.swb-row{display:flex;align-items:center}',
    '.swb-flip{display:inline-block;perspective:240px;transform-style:preserve-3d}',
    '.swb-n{display:inline-block;font-weight:650;transform-origin:50% 50%;backface-visibility:hidden;',
    '  will-change:transform}',
    '.swb-u{font-size:.92em;opacity:.85}',
    '.swb-plus{display:inline-block;font-size:.85em;font-weight:600;color:var(--swb-plus,#b45309);',
    '  opacity:0;transform:translateY(1px);transition:opacity .16s ease;margin-left:2px}',
    '.swb-plus[data-on="1"]{opacity:1}',
    '.swb[data-empty="1"]{display:none}',
    '@media(max-width:600px){.swb{font-size:.9em;margin-left:8px}}',
    '@media(prefers-reduced-motion:reduce){.swb-plus{transition:none}}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-swb', '1');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ---------- 徽标构建 ----------
  function buildBadge(anchor, site) {
    var badge = document.createElement('span');
    badge.className = 'swb';
    badge.setAttribute('data-site', site);
    badge.setAttribute('data-empty', '1');
    // 字号跟按钮本身走，而不是父容器的字号
    var anchorSize = parseFloat(window.getComputedStyle(anchor).fontSize);
    if (anchorSize) badge.style.fontSize = (anchorSize * 0.95).toFixed(1) + 'px';

    var numWrap = document.createElement('span');
    numWrap.className = 'swb-flip';
    var num = document.createElement('span');
    num.className = 'swb-n';
    numWrap.appendChild(num);
    badge.appendChild(numWrap);

    var unit = document.createElement('span');
    unit.className = 'swb-u';
    unit.textContent = '已下载';
    badge.appendChild(unit);

    var plus = document.createElement('span');
    plus.className = 'swb-plus';
    badge.appendChild(plus);

    anchor.insertAdjacentElement('afterend', badge);
    return { badge: badge, num: num, unit: unit, plus: plus };
  }

  // 按徽标背后的底色选深浅：深色区块上不能再用深色字
  function pickInk(el, alpha) {
    var node = el.parentElement;
    while (node && node !== document.documentElement) {
      var cs = window.getComputedStyle(node);
      var m = (cs.backgroundColor || "").match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s\/]+([\d.]+))?\s*\)/);
      if (!m || (m[4] !== undefined && parseFloat(m[4]) <= 0.4)) {
        // 渐变底（例如 linear-gradient(160deg, rgb(11,11,15), …)）取它的第一个色标
        m = (cs.backgroundImage || "").match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s\/]+([\d.]+))?\s*\)/);
      }
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.4)) {
        var lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
        return "rgba(" + (lum > 0.55 ? "0,0,0" : "255,255,255") + "," + alpha + ")";
      }
      node = node.parentElement;
    }
    return null;
  }

  // 有的站把按钮放在纵向 flex 里，徽标插进去会被挤到下一行。
  // 那就把按钮和徽标包成一行；其它情况保持原结构不动。
  function fit(anchor, badge) {
    if (!anchor.isConnected || !badge.isConnected) return;

    if (!anchor.dataset.swbInk) {
      var fg = pickInk(badge, 0.72);
      if (fg) {
        badge.style.setProperty('--swb-fg', fg);
        badge.style.setProperty('--swb-fg-strong', fg.replace(/[^,]*\)$/, '0.94)'));
        anchor.dataset.swbInk = '1';
      }
    }

    if (anchor.parentElement && anchor.parentElement.classList.contains('swb-row')) return;

    var parent = anchor.parentElement;
    if (!parent) return;
    var pcs = window.getComputedStyle(parent);
    var stacks = (pcs.display.indexOf('flex') !== -1 && pcs.flexDirection.indexOf('column') === 0) ||
                 pcs.display.indexOf('grid') !== -1;
    if (!stacks) return;

    var ar = anchor.getBoundingClientRect();
    var br = badge.getBoundingClientRect();
    if (!ar.height || !br.height) return;
    if (Math.abs(br.top - ar.top) <= ar.height / 2) return;   // 同一行，不用动

    // 连同紧跟其后的徽标（比如「在用」）一起挪进包装层
    var following = [];
    var sib = badge.nextElementSibling;
    while (sib && sib.classList && sib.classList.contains('swb')) { following.push(sib); sib = sib.nextElementSibling; }

    var wasStretched = ar.width >= parent.clientWidth - 2;
    var wrap = document.createElement('span');
    wrap.className = 'swb-row';
    parent.insertBefore(wrap, anchor);
    wrap.appendChild(anchor);
    wrap.appendChild(badge);
    following.forEach(function (n) { wrap.appendChild(n); });
    if (wasStretched) anchor.style.flex = '1 1 auto';
  }

  // 在用数单独一个徽标，只有真实去重数据才出现
  function buildInstallBadge(prevBadge, site) {
    var badge = document.createElement('span');
    badge.className = 'swb';
    badge.setAttribute('data-site', site);
    badge.setAttribute('data-kind', 'installs');

    var numWrap = document.createElement('span');
    numWrap.className = 'swb-flip';
    var num = document.createElement('span');
    num.className = 'swb-n';
    numWrap.appendChild(num);
    badge.appendChild(numWrap);

    var unit = document.createElement('span');
    unit.className = 'swb-u';
    unit.textContent = '在用';
    badge.appendChild(unit);

    prevBadge.insertAdjacentElement('afterend', badge);
    return { badge: badge, num: num, unit: unit };
  }

  var parts = [];  // {anchor, site, dl:{...}, inst:{...}}

  function ensureParts(anchor, site) {
    var entry = null;
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].anchor === anchor) { entry = parts[i]; break; }
    }
    if (entry) return entry;

    entry = { anchor: anchor, site: site, dl: null, inst: null };
    parts.push(entry);
    return entry;
  }

  function targets() {
    var out = [];
    var seen = [];
    function push(el, site) {
      if (!el || seen.indexOf(el) !== -1) return;
      seen.push(el);
      out.push({ el: el, site: site });
    }

    // 1) 显式标注
    var marked = document.querySelectorAll('[data-download-badge]');
    for (var i = 0; i < marked.length; i += 1) {
      var el = marked[i];
      var site = el.getAttribute('data-download-badge');
      if (site === 'auto') site = inferSite(el.getAttribute('href'));
      if (site) push(el, site);
    }

    // 2) 经过 host/path 校验的真实包链接，跳过导航栏
    var anchors = document.querySelectorAll('a[href]');
    for (var j = 0; j < anchors.length; j += 1) {
      var a = anchors[j];
      if (a.hasAttribute('data-download-badge')) continue;
      if (a.closest && a.closest('nav')) continue;
      var inferred = inferSite(a.getAttribute('href'));
      if (inferred) push(a, inferred);
    }
    return out;
  }

  function siteStats(site) {
    if (!stats || !stats.sites) return null;
    var s = stats.sites[site];
    if (!s || !s.total) return null;
    return s;
  }

  // ---------- 渲染 ----------
  function paint() {
    if (!stats) return;

    var list = targets();
    for (var i = 0; i < list.length; i += 1) {
      var t = list[i];
      var entry = ensureParts(t.el, t.site);
      var s = siteStats(t.site);
      if (!s) continue;

      var total = typeof s.total.downloads === 'number' ? s.total.downloads : null;

      if (!entry.dl) {
        entry.dl = buildBadge(t.el, t.site);
        scheduleFit(t.el, entry.dl.badge);
      }

      if (total === null) {
        entry.dl.badge.setAttribute('data-empty', '1');
      } else {
        entry.dl.badge.removeAttribute('data-empty');
        var text = fmt(total);
        if (entry.dl.num.textContent !== text) {
          flip(entry.dl.num, text, 130);   // 260ms 一翻
        }
        // 总数涨了，说明刚才那次下载已被服务器确认
        if (entry.pending && entry.pending.base !== null && total > entry.pending.base) {
          clearPending(entry);
        }
        entry.lastTotal = total;
      }

      // 在用数：只有接口给得出真实去重值时才显示
      var inst = typeof s.installs === 'number' ? s.installs : null;
      if (inst !== null) {
        if (!entry.inst) {
          entry.inst = buildInstallBadge(entry.dl.badge, t.site);
          scheduleFit(entry.dl.badge, entry.inst.badge);
        }
        var itext = fmt(inst);
        if (entry.inst.num.textContent !== itext) flip(entry.inst.num, itext, 130);
      }
    }
  }

  // ---------- 点击后的临时反馈（不参与累加）----------
  function clearPending(entry) {
    if (!entry || !entry.pending) return;
    clearTimeout(entry.pending.waitTimer);
    clearTimeout(entry.pending.killTimer);
    entry.pending = null;
    if (entry.dl && entry.dl.plus) {
      var plus = entry.dl.plus;
      plus.setAttribute('data-on', '0');
      setTimeout(function () {
        if (plus.getAttribute('data-on') === '0') plus.textContent = '';
      }, 200);
    }
  }

  function showPending(entry) {
    if (!entry || !entry.dl) return;
    var plus = entry.dl.plus;
    // 基线取点击这一刻接口给的值；拿不到就不按数值判断，只等超时
    var clickStats = siteStats(entry.site);
    var base = (clickStats && clickStats.total && typeof clickStats.total.downloads === 'number')
      ? clickStats.total.downloads
      : null;

    if (entry.pending) {
      // 连点：不叠加，只把计时器续上
      clearTimeout(entry.pending.killTimer);
      entry.pending.killTimer = setTimeout(function () { clearPending(entry); }, PENDING_TTL);
      return;
    }

    entry.pending = { base: base, waitTimer: null, killTimer: null };
    plus.textContent = '+1 下载中';
    plus.setAttribute('data-on', '1');
    if (!reduceMotion || !reduceMotion.matches) {
      // 从 0 翻到 +1 的那一下
      plus.animate(
        [{ transform: 'rotateX(-90deg)', opacity: 0 }, { transform: 'rotateX(0deg)', opacity: 1 }],
        { duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)' }
      );
    }

    entry.pending.waitTimer = setTimeout(function () {
      if (entry.pending && plus.getAttribute('data-on') === '1') plus.textContent = '+1 待确认';
    }, PENDING_TO_WAIT);

    entry.pending.killTimer = setTimeout(function () { clearPending(entry); }, PENDING_TTL);

    // 这段时间里多问几次，确认后就能及时翻到新数字
    fastUntil = Date.now() + FAST_WINDOW;
    scheduleFast();
  }

  function bindClick(el, site) {
    if (el.dataset.swbBound === '1') return;
    el.dataset.swbBound = '1';
    el.addEventListener('click', function () {
      var entry = ensureParts(el, site);
      showPending(entry);
      // 不 preventDefault、不拦截、不等待：浏览器照常发起下载
    }, { passive: true });
  }

  function scheduleFit(anchor, badge) {
    requestAnimationFrame(function () { fit(anchor, badge); });
  }

  // ---------- 取数 ----------
  function load() {
    if (document.hidden && stats) return;
    var mySeq = ++reqSeq;
    fetch(API + '/stats/summary', { mode: 'cors', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (mySeq !== reqSeq) return;     // 晚到的旧响应直接丢掉
        if (!d || !d.ok || !d.sites) return;  // 失败保留上一次确认值，不写 0
        stats = d;
        paint();
      })
      .catch(function () { /* 静默：保留已有确认值 */ });
  }

  function scheduleFast() {
    if (fastTimer) return;
    fastTimer = setInterval(function () {
      if (Date.now() > fastUntil) {
        clearInterval(fastTimer);
        fastTimer = null;
        return;
      }
      load();
    }, FAST_POLL);
  }

  // ---------- 扫描：路由切换、异步渲染都要能补上 ----------
  var scanTimer = null;
  function scan() {
    var list = targets();
    for (var i = 0; i < list.length; i += 1) bindClick(list[i].el, list[i].site);
    if (stats) paint();
    else load();
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 120);
  }

  function boot() {
    scan();
    slowTimer = setInterval(load, SLOW_POLL);

    if (window.MutationObserver) {
      var mo = new MutationObserver(scheduleScan);
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
    // 字体/布局晚到，补扫一次
    setTimeout(scheduleScan, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
