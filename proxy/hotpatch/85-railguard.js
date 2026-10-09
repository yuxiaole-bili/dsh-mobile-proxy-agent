/* 85-railguard.js —— 防止误触"新建会话"把当前对话甩掉
 *
 * 场景：手机左侧图标栏里 `+`（新建会话）紧贴拇指活动区，滑动/打字时很容易蹭到，
 *       一蹭就新开一个对话，当前上下文消失。
 *
 * 做法：点 `+` 时先弹一个确认小卡（取消 / 新建），确认后才放行原始点击；
 *       · 长按 `+` ≥600ms 直接放行（熟手不受打扰）
 *       · 卡里有"不再提醒" → 写 localStorage，之后不再拦
 *       · `?no-railguard=1` 一次性关闭；`?no-railguard=0` 恢复
 */
(function () {
  var W = window, D = document;
  if (W.__dshRailGuard) { return; }

  var LS = 'dsh-railguard';
  var HOLD_MS = 600;

  function T(zh, en) { return W.__dshI18n ? W.__dshI18n.pick(zh, en) : zh; }

  function enabled() {
    try {
      if (/[?&]no-railguard=1\b/.test(location.search)) { return false; }
      if (/[?&]no-railguard=0\b/.test(location.search)) { localStorage.setItem(LS, '1'); return true; }
      return localStorage.getItem(LS) !== '0';
    } catch (e) { return true; }
  }

  /* 找"新建会话"按钮：优先 aria-label，其次左侧竖排里的第一个带加号的按钮 */
  function isNewChatBtn(b) {
    if (!b) { return false; }
    var label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim();
    if (label) {
      // 有明确标签：只有真的是"新建会话"才拦，避免误伤 插件 / 自动化任务 / 上下文洞察
      return /新建会话|新建对话|新对话|new (chat|session|conversation)/i.test(label);
    }
    // 没有可读标签时才用位置兜底：左栏顶部那个带图标的按钮
    var r = b.getBoundingClientRect();
    if (r.left > 70 || r.width > 64) { return false; }
    if (r.top > 190 || r.top < 40) { return false; }
    var t = (b.textContent || '') + (b.innerHTML || '');
    return /[+＋]/.test(t) || (b.querySelector && !!b.querySelector('svg'));
  }

  var pass = false, holdTimer = null, holding = false;

  function closeCard() {
    var c = D.querySelector('[data-dsh-uix="rail-guard"]');
    if (c && c.parentNode) { c.parentNode.removeChild(c); }
  }

  function card(btn) {
    closeCard();
    var wrap = D.createElement('div');
    wrap.setAttribute('data-dsh-uix', 'rail-guard');
    wrap.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:990;'
      + 'background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;'
      + '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';
    var box = D.createElement('div');
    box.style.cssText = 'width:min(300px,86vw);border-radius:16px;padding:18px 16px 12px;'
      + 'background:#26272d;color:#fbf7ff;box-shadow:0 18px 50px rgba(0,0,0,.55);'
      + 'font-size:15px;line-height:1.5;';
    var h = D.createElement('div');
    h.textContent = T('新建对话？', 'Start a new chat?');
    h.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:6px;';
    var p = D.createElement('div');
    p.textContent = T('当前对话会留在列表里，随时可以切回来。',
      'Your current chat stays in the list — you can switch back anytime.');
    p.style.cssText = 'opacity:.72;font-size:13px;margin-bottom:14px;';
    box.appendChild(h); box.appendChild(p);

    var row = D.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;';
    function mkBtn(label, primary) {
      var b = D.createElement('button');
      b.textContent = label;
      b.setAttribute('data-dsh-i18n', '1');
      b.style.cssText = 'flex:1;height:44px;border-radius:11px;border:0;font-size:15px;font-weight:600;'
        + (primary ? 'background:#5b8cff;color:#fff;' : 'background:rgba(255,255,255,.10);color:#fbf7ff;');
      return b;
    }
    var cancel = mkBtn(T('取消', 'Cancel'), false);
    var ok = mkBtn(T('新建', 'New chat'), true);
    cancel.onclick = function (e) { e.stopPropagation(); closeCard(); };
    ok.onclick = function (e) {
      e.stopPropagation();
      closeCard();
      pass = true;
      try { btn.click(); } catch (err) {}
      setTimeout(function () { pass = false; }, 400);
    };
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);

    var never = D.createElement('button');
    never.setAttribute('data-dsh-i18n', '1');
    never.textContent = T('不再提醒', "Don't ask again");
    never.style.cssText = 'display:block;margin:10px auto 0;background:none;border:0;color:#9aa0b5;'
      + 'font-size:12px;text-decoration:underline;padding:6px;';
    never.onclick = function (e) {
      e.stopPropagation();
      try { localStorage.setItem(LS, '0'); } catch (err) {}
      closeCard();
      pass = true;
      try { btn.click(); } catch (err) {}
      setTimeout(function () { pass = false; }, 400);
    };
    box.appendChild(never);
    wrap.appendChild(box);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) { closeCard(); } }, true);
    D.body.appendChild(wrap);
  }

  D.addEventListener('pointerdown', function (e) {
    if (!isNewChatBtn(e.target && e.target.closest ? e.target.closest('button,[role="button"],a') : null)) { return; }
    holding = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () { holding = true; }, HOLD_MS);   // 长按 → 直接放行
  }, true);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
    D.addEventListener(t, function () { clearTimeout(holdTimer); }, true);
  });

  D.addEventListener('click', function (e) {
    if (pass || !enabled()) { return; }
    var b = e.target && e.target.closest ? e.target.closest('button,[role="button"],a') : null;
    if (!isNewChatBtn(b)) { return; }
    if (holding) { holding = false; return; }        // 长按：放行
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
    card(b);
  }, true);

  D.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeCard(); }
  }, true);

  W.__dshRailGuard = {
    active: enabled,
    card: card,
    disable: function () { try { localStorage.setItem(LS, '0'); } catch (e) {} },
    enable: function () { try { localStorage.setItem(LS, '1'); } catch (e) {} }
  };
})();
