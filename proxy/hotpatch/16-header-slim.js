/* 16-header-slim.js —— 标题栏瘦身（结构方案 A+B）
 *
 * A) 标题栏只留 ⋯ 与侧栏两个图标；把「智能体团队」「展开底部面板」折进 ⋯ 菜单
 *    （做法：原按钮 display:none 但保留实例，菜单里注入等效菜单项 → 功能不丢）
 * B) 两个状态 chip（子智能体 / 后台任务）合并成一个胶囊，独立成条
 *
 * 教训：标题栏（Dc7zOa_header）**同时包含标签栏**，绝不给它设固定高度。
 */
(function () {
  var W = window, D = document;
  if (W.__dshHeaderSlim) { return; }

  function T(zh, en) { return W.__dshI18n ? W.__dshI18n.pick(zh, en) : zh; }
  function q(sel) { return D.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(D.querySelectorAll(sel)); }
  function byLabel(re) {
    var bs = qa('button,[role="button"]');
    for (var i = 0; i < bs.length; i += 1) {
      var l = ((bs[i].getAttribute('aria-label') || '') + (bs[i].getAttribute('title') || '')).trim();
      if (re.test(l)) { return bs[i]; }
    }
    return null;
  }
  function inHeader(el) {
    var h = el && el.closest ? el.closest('[class*="Dc7zOa_header"],[class*="headerUtilities"]') : null;
    return !!h;
  }

  /* ---------- A) 把两个图标折进 ⋯ 菜单 ---------- */
  var teamBtn = null, bottomBtn = null;

  function hideMovedIcons() {
    teamBtn = byLabel(/智能体团队|agent team|teammates/i);
    bottomBtn = byLabel(/展开底部面板|收起底部面板|bottom panel/i);
    [teamBtn, bottomBtn].forEach(function (b) {
      if (b && inHeader(b)) {
        b.setAttribute('data-dsh-slim-moved', '1');
        b.style.setProperty('display', 'none', 'important');
      }
    });
  }

  function menuOpen() {
    var lists = qa('[class*="_list_4ub78_"],[role="menu"]');
    for (var i = 0; i < lists.length; i += 1) {
      var r = lists[i].getBoundingClientRect();
      if (r.width > 80 && r.height > 30 && r.top < innerHeight && r.bottom > 0) { return lists[i]; }
    }
    return null;
  }

  var MENU_TAG = 'data-dsh-slim-item';
  function injectMenuItems() {
    var list = menuOpen();
    if (!list || list.querySelector('[' + MENU_TAG + ']')) { return; }
    var wrap = list.querySelector('[class*="_viewport_"]') || list;
    function row(label, btn, hint) {
      if (!btn) { return; }
      var b = D.createElement('button');
      b.setAttribute(MENU_TAG, '1');
      b.setAttribute('data-dsh-i18n', '1');
      b.setAttribute('role', 'menuitem');
      b.className = list.className.split(' ').filter(function (c) { return /_item_/.test(c); }).join(' ') || '';
      b.textContent = label;
      b.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;min-height:34px;'
        + 'padding:6px 10px;border:0;border-radius:8px;background:transparent;color:inherit;'
        + 'font-size:13px;text-align:left;cursor:pointer;';
      b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,.08)'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = function (ev) {
        ev.stopPropagation();
        try { btn.click(); } catch (e) {}
        /* 关掉菜单 */
        try { D.body.click(); } catch (e) {}
      };
      if (hint) { b.title = hint; }
      wrap.appendChild(b);
    }
    row(T('智能体团队', 'Agent team'), teamBtn, T('查看子代理与共享任务', 'Subagents and shared tasks'));
    row(T('底部面板', 'Bottom panel'), bottomBtn, T('文件 / 文件变动 / 任务管理', 'Files / changes / tasks'));
  }

  /* ---------- B) 状态合并成一个胶囊 ---------- */
  var pill = null;
  function chipText(sel) {
    var e = q(sel);
    if (!e) { return null; }
    var t = (e.textContent || '').replace(/\s+/g, ' ').trim();
    return t || null;
  }
  function shortCount(t) {
    var m = /(\d+)/.exec(t || '');
    return m ? m[1] : '';
  }
  function ensurePill() {
    if (pill && pill.isConnected) { return pill; }
    pill = D.createElement('button');
    pill.setAttribute('data-dsh-uix', 'header-status-pill');
    pill.setAttribute('data-dsh-i18n', '1');
    pill.style.cssText = 'position:fixed;top:54px;right:8px;z-index:866;height:20px;min-height:20px;'
      + 'max-height:20px;padding:0 8px;border-radius:10px;display:none;align-items:center;gap:6px;'
      + 'font-size:10px;line-height:20px;white-space:nowrap;overflow:hidden;'
      + 'background:rgba(46,47,56,.92);color:#fbf7ff;border:1px solid rgba(150,152,170,.28);'
      + 'box-shadow:0 2px 6px rgba(0,0,0,.3);';
    pill.onclick = function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var b = byLabel(/智能体团队|agent team|teammates/i);
      if (b) { b.click(); }
    };
    D.body.appendChild(pill);
    return pill;
  }
  function refreshPill() {
    try {
      if (D.hidden) { return; }
      var a = chipText('[class*="oXE0lW_trigger"]');
      var b = chipText('[class*="foD-wG_trigger"]');
      var p = ensurePill();
      var parts = [];
      if (a) { parts.push('👥 ' + (shortCount(a) || '1')); }
      if (b) { parts.push('⚙ ' + (shortCount(b) || '1')); }
      if (!parts.length) { p.style.display = 'none'; return; }
      var txt = parts.join(' · ');
      if (p.textContent !== txt) { p.textContent = txt; }
      p.title = [a, b].filter(Boolean).join(' / ') || T('子代理与后台任务', 'Subagents & background tasks');
      p.style.display = 'inline-flex';
    } catch (e) {}
  }

  /* ---------- 调度 ---------- */
  function hideOriginalChips() {
    ['[class*="oXE0lW_trigger"]', '[class*="foD-wG_trigger"]'].forEach(function (sel) {
      var e = q(sel);
      if (e) { e.style.setProperty('display', 'none', 'important'); }   /* 内联 important：一定能压住样式表 */
    });
  }
  function tick() {
    hideMovedIcons();
    hideOriginalChips();
    injectMenuItems();
    refreshPill();
  }
  tick();
  setInterval(tick, 1200);
  if (W.MutationObserver && D.body) {
    new MutationObserver(function () { injectMenuItems(); }).observe(D.body, { childList: true, subtree: true });
  }
  W.addEventListener('resize', tick);

  W.__dshHeaderSlim = { team: function () { return teamBtn; }, bottom: function () { return bottomBtn; }, refresh: tick };
})();
