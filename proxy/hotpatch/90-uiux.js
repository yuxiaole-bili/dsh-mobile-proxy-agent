/* 90-uiux.js —— 手机端交互层：折叠按钮 / 长按展开 / 手势 / 用量优先完整
 *
 * 用户要求：① 避免所有按键重叠 ② 手势优化 ③ 折叠按钮 ④ 长按展开
 *          ⑤ 底部用量等优先保证展示完整
 *
 * 重叠的实测根因（360 宽）：
 *   Dc7zOa_titleCluster x=76 w=152 与 Dc7zOa_headerActions x=86 w=241 互相压住，
 *   其中 foD-wG_root(后台任务) x=228 w=99 整个盖在 Dc7zOa_headerUtilities(图标组) x=248 w=64 上。
 * 布局部分在 00-base.css 里用 CSS 修；这里负责交互：折叠按钮、长按、手势。
 *
 * 关掉：地址加 ?no-uiux=1
 */
(function () {
  var W = window, D = document;
  if (W.__dshUix || /[?&]no-uiux=1/.test(location.search)) { return; }
  var MOBILE = /Android|iPhone|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent || "");
  if (!MOBILE) { return; }

  var LS = "dsh-uix-usage-min";
  var S = { toggles: 0, longPress: 0, gestures: 0, ctxClosed: 0, ctxVia: null, ctxClosing: false, errors: [] };

  function logErr(where, e) {
    try {
      if (S.errors.length > 30) { S.errors.shift(); }   /* 上限：防长跑内存增长 */
      S.errors.push(where + ": " + (e && e.message ? e.message : String(e)));
      if (W.__dshHotErrors) {
        if (W.__dshHotErrors.length > 60) { W.__dshHotErrors.shift(); }
        W.__dshHotErrors.push("[90-uiux] " + where + ": " + e);
      }
    } catch (_) {}
  }
  function css(el, o) { for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { el.style[k] = o[k]; } } }
  function root() { return D.documentElement; }

  /* ---------- 用量条：折叠状态 ---------- */
  function usageBar() {
    var e = D.querySelector('[class*="_2WTFBq_trigger"]');
    if (e) { return e; }
    /* 兜底：底部 90px 内、带百分号的最小容器 */
    var all = D.querySelectorAll("div,span"), best = null;
    for (var i = 0; i < all.length; i += 1) {
      var q = all[i], r = q.getBoundingClientRect();
      if (r.top < innerHeight - 90 || r.height < 10 || r.width < 60) { continue; }
      var t = q.textContent || "";
      if (!/%/.test(t) || t.length > 90) { continue; }
      if (!best || r.width * r.height < best.r.width * best.r.height) { best = { e: q, r: r }; }
    }
    return best ? best.e : null;
  }

  function isMin() { return root().getAttribute("data-dsh-uix-min") === "1"; }
  function setMin(on) {
    try {
      if (on) { root().setAttribute("data-dsh-uix-min", "1"); } else { root().removeAttribute("data-dsh-uix-min"); }
      try { localStorage.setItem(LS, on ? "1" : "0"); } catch (e) {}
      paintToggle();
    } catch (e) { logErr("setMin", e); }
  }

  var btn = null;
  function paintToggle() {
    if (!btn) { return; }
    btn.textContent = isMin() ? "⌃" : "⌄";
    btn.title = isMin() ? "展开底部用量" : "收起底部用量";
    btn.setAttribute("aria-label", btn.title);
  }

  function mountToggle() {
    try {
      var bar = usageBar();
      if (!bar || !D.body) { return; }
      if (btn && btn.parentNode) { paintToggle(); return; }
      var host = bar.parentElement || bar;
      btn = D.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-dsh-uix", "usage-toggle");
      css(btn, { flex: "0 0 auto", width: "22px", height: "22px", padding: "0", marginRight: "2px",
                 borderRadius: "6px", border: "1px solid rgba(127,127,127,.35)",
                 background: "rgba(20,20,24,.45)", color: "inherit", fontSize: "12px",
                 lineHeight: "1", cursor: "pointer", opacity: ".75" });
      btn.addEventListener("click", function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        S.toggles += 1;
        setMin(!isMin());
      }, true);
      host.insertBefore(btn, host.firstChild);
      paintToggle();
    } catch (e) { logErr("mountToggle", e); }
  }

  /* ---------- 长按展开 / 手势 ---------- */
  var pressTimer = null, expandTimer = null;

  function expandTemporarily(ms) {
    try {
      root().setAttribute("data-dsh-uix-expand", "1");
      S.longPress += 1;
      if (expandTimer) { clearTimeout(expandTimer); }
      expandTimer = setTimeout(function () {
        try { root().removeAttribute("data-dsh-uix-expand"); } catch (e) {}
      }, ms || 8000);
    } catch (e) { logErr("expand", e); }
  }

  function onPressStart(ev) {
    try {
      var t = ev.target;
      if (!t || !t.closest) { return; }
      /* 用量条长按 -> 展开完整数值 */
      if (t.closest('[class*="_2WTFBq_"]')) {
        pressTimer = setTimeout(function () { expandTemporarily(8000); }, 550);
        return;
      }
      /* 顶部 chip 长按 -> 临时取消省略号，看全称 */
      if (t.closest('[class*="oXE0lW_root"],[class*="foD-wG_root"],[class*="titleCluster"]')) {
        pressTimer = setTimeout(function () {
          try {
            root().setAttribute("data-dsh-uix-chipfull", "1");
            S.longPress += 1;
            setTimeout(function () { root().removeAttribute("data-dsh-uix-chipfull"); }, 5000);
          } catch (e) {}
        }, 500);
        return;
      }
      /* 折叠的工具行/消息长按 -> 点它附近的"展开"按钮 */
      var row = t.closest('[class*="callRow"],[class*="flowItem"],[class*="WW4l1q_body"],[class*="toolRow"],[class*="ToolRow"]');
      if (row) {
        pressTimer = setTimeout(function () {
          try {
            var scope = row.closest('[class*="WW4l1q_root"],[class*="row"],div') || row;
            var cand = scope.querySelectorAll('button[aria-label*="展开"],button[aria-label*="xpand"],[class*="expand"]');
            for (var i = 0; i < cand.length; i += 1) {
              var b = cand[i];
              if (b.getBoundingClientRect().width < 6) { continue; }
              b.click();
              S.longPress += 1;
              expandTemporarily(0);
              try { if (W.dshNative && W.__dshHot && W.__dshHot.native()) { var p = W.dshNative("vibrate", { ms: 12 }); if (p && p.catch) { p.catch(function () {}); } } } catch (e2) {}
              return;
            }
          } catch (e) {}
        }, 520);
      }
    } catch (e) { logErr("pressStart", e); }
  }
  function onPressEnd() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }

  /* 上下滑用量条 = 展开 / 收起 */
  var ty = 0;
  function onTouchStart(ev) {
    try {
      var t = ev.target;
      if (!t || !t.closest || !t.closest('[class*="_2WTFBq_"]')) { return; }
      ty = ev.touches && ev.touches[0] ? ev.touches[0].clientY : 0;
    } catch (e) {}
  }
  function onTouchEnd(ev) {
    try {
      if (!ty) { return; }
      var t = ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientY : ty;
      var dy = t - ty;
      ty = 0;
      if (Math.abs(dy) < 26) { return; }
      S.gestures += 1;
      if (dy < 0) { expandTemporarily(8000); } else { setMin(true); }
    } catch (e) { logErr("touchEnd", e); }
  }

  /* ---------- 底部状态条：强制完整显示（按"贴底那一带"定位，不依赖类名） ---------- */
  function bandItems() {
    var out = [], all = D.querySelectorAll("span,div,button,p,a");
    for (var i = 0; i < all.length; i += 1) {
      var e = all[i], r = e.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) { continue; }
      if (r.top < innerHeight - 58 || r.bottom > innerHeight + 2) { continue; }
      var t = (e.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 24) { continue; }
      out.push(e);
    }
    return out;
  }

  function untruncateBottom() {
    try {
      var items = bandItems();
      if (!items.length) { return 0; }
      var fixed = 0, parents = [];
      for (var i = 0; i < items.length; i += 1) {
        var e = items[i];
        e.setAttribute("data-dsh-uix", "seen");   /* 不再强行改样式：格网列宽度由父级决定，改了只会让文字溢出叠住 */
        fixed += 1;
        if (e.parentElement) { parents.push(e.parentElement); }
      }
      for (var j = 0; j < parents.length; j += 1) {
        var p = parents[j];
        if (p.getAttribute("data-dsh-uix-fixed") === "1") { continue; }
        p.style.setProperty("flex-wrap", "nowrap", "important");
        p.style.setProperty("overflow", "visible", "important");
        p.style.setProperty("column-gap", "6px", "important");
        /* 放不下就换行：宁可整条高一点，也不切掉任何数字 */
        p.style.setProperty("flex-wrap", "wrap", "important");
        p.style.setProperty("justify-content", "flex-end", "important");
        p.style.setProperty("row-gap", "2px", "important");
        p.style.setProperty("overflow", "visible", "important");
        p.setAttribute("data-dsh-uix-fixed", "1");
      }
      return fixed;
    } catch (e) { logErr("untruncateBottom", e); return 0; }
  }


  /* ---------- 浮动层贴边收敛：超出视口底部的菜单/弹层改为限高可滚动 ---------- */
  function clampFloating() {
    try {
      var n = 0;
      var sel = '[role="menu"],[role="listbox"],[role="dialog"],[class*="popover"],[class*="Popover"],[class*="menu"],[class*="Menu"],[class*="dropdown"]';
      var all = D.querySelectorAll(sel);
      for (var i = 0; i < all.length; i += 1) {
        var e = all[i];
        var cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden") { continue; }
        if (cs.position !== "absolute" && cs.position !== "fixed") { continue; }
        var r = e.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) { continue; }
        var room = innerHeight - r.top - 10;
        if (r.bottom > innerHeight - 4 && room > 60 && e.getAttribute("data-dsh-uix-clamped") !== "1") {
          e.style.setProperty("max-height", room + "px", "important");
          e.style.setProperty("overflow-y", "auto", "important");
          e.style.setProperty("overscroll-behavior", "contain", "important");
          e.setAttribute("data-dsh-uix-clamped", "1");
          n += 1;
        }
      }
      return n;
    } catch (e) { logErr("clampFloating", e); return 0; }
  }


  /* ---------- 上下文洞察面板：点外面关闭 + 开合加固 ---------- */
  /* 实测：上下文面板是"整屏覆盖层页面"—— BynINW_overlayLayer 里挂一页 lc-ov-* 的东西，
     标题是 h1.lc-ov-pagetitle。按 dialog 找是找不到的。 */
  var CTX_TITLE = /上下文洞察|上下文浏览器|上下文构成/;

  /* 通用：任何"整屏覆盖层子页面"（不限上下文洞察）。
     必须与视口相交 —— 否则排在屏幕外的收起态面板（如 OUqwTW_panel x=416）会误触发。 */
  function ctxOverlay() {
    try {
      function usable(k) {
        var r = k.getBoundingClientRect(), cs = getComputedStyle(k);
        if (r.width < 120 || r.height < 120) { return false; }
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) { return false; }
        if (cs.pointerEvents === "none") { return false; }
        if (r.right <= 4 || r.left >= innerWidth - 4) { return false; }   /* 在视口外：别挂按钮 */
        if (r.bottom <= 4 || r.top >= innerHeight - 4) { return false; }
        return true;
      }
      var layers = D.querySelectorAll('[class*="overlayLayer"],[class*="OverlayLayer"]');
      for (var i = 0; i < layers.length; i += 1) {
        var kids = layers[i].children, j;
        for (j = 0; j < kids.length; j += 1) {
          if (usable(kids[j])) { return kids[j]; }      /* 整屏覆盖页：一律算 */
        }
      }
      /* 兜底：任何带 lc-ov 页标题的可见页 */
      var t = D.querySelector("h1.lc-ov-pagetitle,[class*='lc-ov-pagetitle']");
      if (t) {
        var rr = t.getBoundingClientRect();
        if (rr.width > 40 && rr.height > 8 && rr.right > 4 && rr.left < innerWidth - 4) {
          return (t.closest('[class*="lc-ov"]') || t.parentElement || t);
        }
      }
    } catch (e) { logErr("ctxOverlay", e); }
    return null;
  }

  /* 覆盖层当前页的标题（用于按钮 tooltip / 状态上报） */
  function overlayTitle() {
    try {
      var ov = ctxOverlay();
      if (!ov) { return ""; }
      var h = (ov.closest('[class*="overlayLayer"]') || ov).querySelector("h1,h2,[class*='pagetitle'],[class*='title']");
      return h ? (h.textContent || "").trim().slice(0, 24) : "";
    } catch (e) { return ""; }
  }

  function closeCtxOverlay() {
    var ov = ctxOverlay();
    if (!ov) { return false; }
    try {
      /* 优先用插件/应用自己的关闭或返回控件 */
      var root = ov.closest('[class*="overlayLayer"]') || ov;
      var btns = root.querySelectorAll('button,[role="button"],a[href]');
      for (var i = 0; i < btns.length; i += 1) {
        var b = btns[i];
        var lbl = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
        var r = b.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) { continue; }
        if (lbl === "关闭" || lbl === "返回" || /^(close|back|clos)/i.test(lbl)) { b.click(); S.ctxClosed += 1; return true; }
      }
      /* ② 会话区的"对话/轨迹"标签（覆盖层若只是叠在会话上时有效） */
      var tabs = D.querySelectorAll('[role="tab"],[class*="tab"]');
      for (var k = 0; k < tabs.length; k += 1) {
        var tb = tabs[k];
        var tl = (tb.textContent || "").trim();
        var tr = tb.getBoundingClientRect();
        if (tr.width < 8 || tr.height < 8) { continue; }
        if (tl === "对话" || tl === "轨迹") { tb.click(); S.ctxClosed += 1; return true; }
      }
      /* ③ 点一条**别的**侧栏项：实测只有这一步真的让 app 切走视图、覆盖层随之消失。
            排除当前选中的"上下文洞察"（点了等于没点）和"新建会话"（会建新会话）。 */
      try {
        var rail = D.querySelector('[class*="sidebarCol"]') || D.querySelector('[class*="_2H3hWW_root"]');
        if (rail) {
          var all = rail.querySelectorAll('button,[role="button"],a,[class*="panelRow"]');
          var safe = null, other = null;
          for (var i = 0; i < all.length; i += 1) {
            var it = all[i], ir = it.getBoundingClientRect();
            if (ir.width < 12 || ir.height < 12) { continue; }
            var il = ((it.getAttribute("aria-label") || "") + " " + (it.getAttribute("title") || "") + " " + (it.textContent || "")).trim();
            if (/新建会话|newSession/i.test(il)) { continue; }
            if (/上下文|context/i.test(il)) { continue; }
            if (/插件|plugin|自动化|任务|智能体团队|agent|设置|setting/i.test(il)) { if (!safe) { safe = it; } }
            if (!other) { other = it; }
          }
          var t3 = safe || other;
          if (t3) {
            var cl3 = String(t3.className || "");
            if (!/active|selected|current/i.test(cl3)) { t3.click(); S.ctxClosed += 1; S.ctxVia = "rail-item"; return true; }
          }
        }
      } catch (e) { logErr("closeCtxRailItem", e); }

      /* ③b 退而求其次：点左上角 logo（回会话列表，仍在 DSH 内） */
      try {
        var lg = D.querySelector('[class*="logoRow"]');
        var lgb = lg ? (lg.querySelector("button,[role='button'],a") || lg) : null;
        if (lgb) {
          var lr = lgb.getBoundingClientRect();
          if (lr.width > 8 && lr.height > 8) { lgb.click(); S.ctxClosed += 1; S.ctxVia = "logo"; return true; }
        }
      } catch (e) { logErr("closeCtxLogo", e); }

      /* ④ 点左侧图标栏，让 app 自己切视图（注意避开当前已选中的那一项，点了等于没点）。
            避开"新建会话"（会建新会话），优先带"会话/对话/主页/home"字样的项。 */
      var rail = D.querySelector('[class*="sidebarCol"]') || D.querySelector('[class*="_2H3hWW_root"]');
      if (rail) {
        var items = rail.querySelectorAll('button,[role="button"],a[class*="panelRow"],[class*="panelRow"]');
        var pick = null, fallback = null, logo = null;
        for (var m = 0; m < items.length; m += 1) {
          var it = items[m];
          var ir = it.getBoundingClientRect();
          if (ir.width < 12 || ir.height < 12) { continue; }
          var il = ((it.getAttribute("aria-label") || "") + " " + (it.getAttribute("title") || "") + " " + (it.textContent || "")).trim();
          var icl = String(it.className || "");
          if (/logoRow/.test(icl) && !logo) { logo = it; }
          if (/新建会话|newSession/.test(il) || /newSession/.test(icl)) { continue; }
          if (/会话|对话|主页|home/i.test(il) && !pick) { pick = it; }
          if (!fallback) { fallback = it; }
        }
        /* 依次尝试若干项，跳过"当前选中"的（aria-current/active 类名） */
        var order = [];
        if (pick) { order.push(pick); }
        if (logo) { order.push(logo); }
        if (fallback) { order.push(fallback); }
        for (var n2 = 0; n2 < order.length; n2 += 1) {
          var t2 = order[n2];
          var cl = String(t2.className || "");
          if (/active|selected|current/i.test(cl) && n2 === 0) { continue; }
          t2.click(); S.ctxClosed += 1; S.ctxVia = "rail"; return true;
        }
      }
      /* ④ 最后兜底：路由返回 / 原生返回（会把历史退到 App 主页，代价大，仅在前几步都无效时用） */
      if (W.history && typeof W.history.back === "function") { W.history.back(); S.ctxClosed += 1; S.ctxVia = "back"; return true; }
      try {
        var nat = (W.__dshHot && typeof W.__dshHot.call === "function") ? W.__dshHot.call
                : (typeof W.dshNative === "function" ? W.dshNative : null);
        if (nat) { var pr = nat("back", {}); if (pr && pr.catch) { pr.catch(function () {}); } S.ctxClosed += 1; S.ctxVia = "native-back"; return true; }
      } catch (e) { logErr("nativeBack", e); }
    } catch (e) { logErr("closeCtxOverlay", e); }
    return false;
  }


  function ctxPanel() {
    try {
      var sel = '[role="dialog"],[class*="panel"],[class*="Panel"],[class*="overlay"],[class*="Overlay"],[class*="sheet"]';
      var all = D.querySelectorAll(sel);
      for (var i = 0; i < all.length; i += 1) {
        var e = all[i], cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden") { continue; }
        var r = e.getBoundingClientRect();
        if (r.width < 180 || r.height < 160) { continue; }
        if (CTX_TITLE.test(e.textContent || "")) { return e; }
      }
    } catch (e) { logErr("ctxPanel", e); }
    return null;
  }

  function closeCtxPanel() {
    var p = ctxPanel();
    if (!p) { return false; }
    try {
      var btns = p.querySelectorAll('button,[role="button"],[class*="close"],[class*="Close"]');
      for (var i = 0; i < btns.length; i += 1) {
        var b = btns[i];
        var lbl = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
        if (lbl === "关闭" || lbl === "收起" || /^(close|clos)/i.test(lbl)) {
          var r = b.getBoundingClientRect();
          if (r.width < 6 && r.height < 6) { continue; }
          b.click();
          S.ctxClosed += 1;
          return true;
        }
      }
    } catch (e) { logErr("closeCtxPanel", e); }
    return false;
  }

  function onCtxOutsideClick(ev) {
    try {
      if (!ctxOverlay()) { return; }
      if (S.ctxClosing) { return; }        /* 正在关闭中：不要再叠一次，防止自我循环 */
      S.ctxClosing = true;
      setTimeout(function () { S.ctxClosing = false; }, 1500);
      var t = ev.target;
      if (t && t.closest && t.closest('[class*="lc-ov"]')) { return; }   /* 点面板内部不动 */
      if (closeCtxOverlay()) {
        /* 吃掉这次点击：否则点"上下文"开关时插件会立刻又打开 */
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        try { if (ev.stopImmediatePropagation) { ev.stopImmediatePropagation(); } } catch (e) {}
      }
    } catch (e) { logErr("onCtxOutsideClick", e); }
  }


  /* ---------- 自建"关闭上下文"按钮：app 的覆盖层里没有任何关闭控件 ---------- */
  var ctxBtn = null;

  function mountCtxClose() {
    try {
      var ov = ctxOverlay();
      if (!ov) {
        if (ctxBtn && ctxBtn.parentNode) { ctxBtn.parentNode.removeChild(ctxBtn); }
        ctxBtn = null;
        return;
      }
      if (ctxBtn && ctxBtn.parentNode) { return; }
      if (!D.body) { return; }
      ctxBtn = D.createElement("button");
      ctxBtn.type = "button";
      ctxBtn.setAttribute("data-dsh-uix", "ctx-close");
      var _tt = overlayTitle();
      ctxBtn.setAttribute("aria-label", _tt ? ("关闭 " + _tt) : "关闭面板");
      if (_tt) { ctxBtn.title = "关闭 " + _tt; }
      ctxBtn.textContent = "✕";
      ctxBtn.style.cssText = "position:fixed;right:10px;top:44px;width:34px;height:34px;z-index:2147483646;" +
        "border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(20,20,26,.82);" +
        "color:#e8eef7;font-size:15px;line-height:1;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35)";
      ctxBtn.addEventListener("click", function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
        var ok = closeCtxOverlay();
        try {
          ctxBtn.textContent = ok ? "↵" : "!";
          setTimeout(function () { if (ctxBtn) { ctxBtn.textContent = "✕"; } }, 1500);
        } catch (e) {}
      }, true);
      D.body.appendChild(ctxBtn);
    } catch (e) { logErr("mountCtxClose", e); }
  }

  function start() {
    try {
      try { if (localStorage.getItem(LS) === "1") { root().setAttribute("data-dsh-uix-min", "1"); } } catch (e) {}
      mountToggle();
      untruncateBottom();
      clampFloating();
      /* 降频 + 页面隐藏时不动 DOM（原来每 1.5 秒全量扫描取 rect，长列表上很贵） */
      setInterval(function () {
        try {
          if (D.hidden) { return; }
          mountToggle();
          clampFloating();
          mountCtxClose();
        } catch (e) { logErr("tick", e); }
      }, 1200);
      D.addEventListener("click", onCtxOutsideClick, true);
      D.addEventListener("pointerdown", onPressStart, true);
      D.addEventListener("pointerup", onPressEnd, true);
      D.addEventListener("pointercancel", onPressEnd, true);
      D.addEventListener("pointermove", onPressEnd, true);
      D.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
      D.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    } catch (e) { logErr("start", e); }
  }

  W.__dshUix = {
    version: "2026-10-07.1",
    state: function () {
      var cp = null; try { cp = ctxOverlay(); } catch (e) {}
      var bar = usageBar();
      return { version: "2026-10-07.1", min: isMin(),
               expand: root().getAttribute("data-dsh-uix-expand") === "1",
               chipfull: root().getAttribute("data-dsh-uix-chipfull") === "1",
               hasBar: !!bar, hasToggle: !!(btn && btn.parentNode),
               untrunc: (function(){try{return D.querySelectorAll('[data-dsh-uix="untrunc"]').length;}catch(e){return -1;}})(),
               toggles: S.toggles, longPress: S.longPress, gestures: S.gestures,
               ctxOpen: !!cp, ctxClosed: S.ctxClosed, ctxVia: S.ctxVia, ctxTitle: overlayTitle(),
               errors: S.errors.slice() };
    },
    collapse: function () { setMin(true); },
    expand: function () { setMin(false); },
    expandFull: function () { expandTemporarily(8000); }
  };

  if (D.readyState === "loading") { D.addEventListener("DOMContentLoaded", start); } else { start(); }
})();
