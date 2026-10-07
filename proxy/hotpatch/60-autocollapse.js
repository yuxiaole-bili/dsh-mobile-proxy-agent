/* ============================================================================
 * dsh-hotpatch / 60-autocollapse.js —— 点开会话后自动收起左侧抽屉
 * ----------------------------------------------------------------------------
 * 解决：手机端抽屉是"浮层"，开着的时候会盖住正文（见交接文档"已知限制"）。
 * 本补丁在两种时机把抽屉收起来，让会话内容立刻可见：
 *
 *   规则 1｜活动会话变了：轮询 [data-conversation-session]（DSH 前端把当前会话
 *           id 写在这个属性上；代理里的分页器 __dshPager 也用同一个锚点）。
 *           变了且抽屉是开的 → 收起。覆盖"点会话 / 新建会话 / 任何来源的切换"。
 *   规则 2｜点了抽屉里的会话行：`[class*="sessionRow"]` 或 `button[class*="newSession"]`
 *           → 260ms 后收起。覆盖"再点一次当前会话"（此时 id 不变，规则 1 不会触发）。
 *           点行内"…"菜单（[class*="rowActions"]）、"展开其余会话"、设置等一律不动。
 *
 * 只对手机生效（window.__dshHot.mobile）；桌面端侧栏常驻，不碰。
 * 关闭开关：地址后加 ?no-autocollapse=1；诊断：window.__dshAutoCollapse.state()
 * ========================================================================== */
(function () {
  var W = window;
  var D = document;
  var V = "2026-10-04.1";
  var POLL = 300;
  var ROW_DELAY = 260;
  var OFF = /(^|[?&])no-autocollapse=1(&|$)/.test(String(W.location.search || ""));

  var S = {
    on: !OFF,
    checks: 0,
    sidSeen: 0,
    rowTaps: 0,
    closes: 0,
    lastReason: null,
    lastAt: null,
    sid: null,
    errs: 0
  };

  function err(f, e) {
    try {
      S.errs++;
      (W.__dshHotErrors = W.__dshHotErrors || []).push({
        f: "60-autocollapse." + f,
        e: String((e && e.stack) || e),
        t: Date.now()
      });
      if (W.__dshHotErrors.length > 200) { W.__dshHotErrors.splice(0, 100); }
    } catch (_) {}
  }

  function mobile() {
    try { return !!(W.__dshHot && W.__dshHot.mobile); } catch (e) { return false; }
  }

  function gest() {
    try { return W.__dshGestures || null; } catch (e) { return null; }
  }

  function drawerOpen() {
    try {
      var g = gest();
      return !!(g && typeof g.drawerState === "function" && g.drawerState() === "open");
    } catch (e) { err("drawerState", e); return false; }
  }

  function activeSid() {
    try {
      var el = D.querySelector("[data-conversation-session]");
      var v = el && el.getAttribute("data-conversation-session");
      return v ? String(v) : null;
    } catch (e) { err("sid", e); return null; }
  }

  function closeDrawer(reason) {
    try {
      var g = gest();
      if (!g || typeof g.close !== "function") { err("close", "no __dshGestures.close"); return false; }
      var r = g.close();
      if (r) { S.closes++; S.lastReason = reason; S.lastAt = Date.now(); }
      return !!r;
    } catch (e) { err("close", e); return false; }
  }

  function maybeClose(reason) {
    if (!S.on || !mobile()) { return false; }
    if (!drawerOpen()) { return false; }
    return closeDrawer(reason);
  }

  /* ---------- 规则 1：活动会话变化 ---------- */
  function poll() {
    try {
      S.checks++;
      var cur = activeSid();
      if (S.sid === null) { S.sid = cur; return; }        // 首次只记录，不动作
      if (cur !== S.sid) {
        S.sid = cur;
        S.sidSeen++;
        maybeClose("sessionChanged");
      }
    } catch (e) { err("poll", e); }
  }

  /* ---------- 规则 2：点击抽屉里的会话行 ---------- */
  D.addEventListener("click", function (ev) {
    try {
      if (!S.on || !mobile()) { return; }
      var el = ev.target;
      if (!el || typeof el.closest !== "function") { return; }
      if (el.closest('[class*="rowActions"]')) { return; }               // 行内操作菜单：不动
      var hit = el.closest('[class*="sessionRow"]') || el.closest('button[class*="newSession"]');
      if (!hit) { return; }
      var drawer = D.querySelector('[class*="sidebarCol"]');
      if (!drawer || !drawer.contains(hit)) { return; }                  // 只认抽屉里的
      S.rowTaps++;
      setTimeout(function () { maybeClose("rowTap"); }, ROW_DELAY);
    } catch (e) { err("click", e); }
  }, true);

  setInterval(poll, POLL);
  poll();

  W.__dshAutoCollapse = {
    version: V,
    off: OFF,
    on: function () { S.on = true; return S.on; },
    offNow: function () { S.on = false; return S.on; },
    closeNow: function () { return closeDrawer("manual"); },
    state: function () {
      return {
        version: V,
        on: S.on && !OFF,
        offByQuery: OFF,
        mobile: mobile(),
        drawer: (function () { try { var g = gest(); return g && g.drawerState ? g.drawerState() : null; } catch (e) { return null; } })(),
        sid: S.sid,
        checks: S.checks,
        sidChanges: S.sidSeen,
        rowTaps: S.rowTaps,
        closes: S.closes,
        lastReason: S.lastReason,
        lastAt: S.lastAt,
        errors: S.errs
      };
    }
  };

  try { console.log("[dsh-hot] autocollapse ready " + V + " on=" + (S.on && !OFF)); } catch (_) {}
})();
