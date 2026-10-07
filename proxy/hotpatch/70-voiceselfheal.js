/* ============================================================================
 * dsh-hotpatch / 70-voiceselfheal.js —— 语音"尚未就绪"自愈
 * ----------------------------------------------------------------------------
 * 症状（真机截图）：点麦克风弹「语音识别尚未就绪 · 请前往语音插件详情页查看…」。
 *
 * 根因（本轮实测，证据在 <REPO>\evidence\ 下）：
 *   DSH 前端的可用性判断是
 *       usable = readiness.connected && phase ∈ {ready, standby, waking}
 *   phase 由 /api/remote.mux 上的 speech/follow 流给出 —— 实测 standby 且 5 步全
 *   complete，**没问题**；而 connected **只在收到该流第一帧时**置真，之后这条流
 *   只要走到 carrierFailed（服务端结束/网络抖动），connected 就永久停在 false，
 *   页面不重载就会一直弹"尚未就绪"。
 *   实测（evidence/voice_reconnect.txt）：关掉 mux 的 WebSocket，客户端 200ms 内
 *   自动重连并**重开 speech/follow**、重新拿到 catalog —— 所以"重启 mux"就是
 *   有效的修复动作。
 *
 * 本补丁只在手机上生效：盯 [role="dialog"] 里有没有那句"尚未就绪"，出现就做一次
 *   "重启 mux"（限速 8 秒、每次页面最多 5 次），让流重建、connected 回真；
 *   前端自己的 useEffect 会在 usable 变真时关掉弹窗，本补丁只兜底点一下"稍后"。
 *
 * 诊断：window.__dshVoiceHeal.state() / .healNow() / .offNow() / .onNow()
 * ========================================================================== */
(function () {
  var W = window;
  var D = document;
  var V = "2026-10-04.1";
  var NEEDLE = "语音识别尚未就绪";
  var MIN_GAP = 8000;
  var MAX_HEALS = 5;

  var S = { on: true, heals: 0, triggers: 0, lastAt: 0, lastWhy: null, lastClosed: 0, errs: 0, seen: 0, list: [],
            sent: false, got: false, beaconed: false };

  function err(f, e) {
    try {
      S.errs++;
      (W.__dshHotErrors = W.__dshHotErrors || []).push({
        f: "70-voiceselfheal." + f,
        e: String((e && e.stack) || e),
        t: Date.now()
      });
      if (W.__dshHotErrors.length > 200) { W.__dshHotErrors.splice(0, 100); }
    } catch (_) {}
  }

  function mobile() {
    try { return !!(W.__dshHot && W.__dshHot.mobile); } catch (e) { return false; }
  }

  /* ---- 诊断信标 ----
   * 远端只能看代理日志，所以把"手机侧到底看没看到 speech/follow 流"用极短路径请求报出来：
   *   /__vs/<sent><got>   sent=发出过 open 帧，got=收到过 catalog 帧
   *   /__vh/<heals><c|n>  自愈次数；c=确实关掉了 socket
   * 代理会把它当普通请求记进 proxy.log，我就能远程读到（404 无所谓，路径本身就是数据）。 */
  function beacon(path) {
    try {
      if (!W.fetch) { return; }
      var p = W.fetch(path, { cache: "no-store" });
      if (p && p.then) { p.then(function () {}, function () {}); }
    } catch (e) {}
  }

  /* ---- 登记 WebSocket：需要时把它们关掉，客户端会自动重连并重开 speech/follow ---- */
  function hookWs() {
    try {
      var OW = W.WebSocket;
      if (typeof OW !== "function" || OW.__dshHealWs) { return; }
      var NW = new W.Proxy(OW, {
        construct: function (t, args) {
          var s = new t(args[0], args[1]);
          try {
            S.list.push(s);
            if (S.list.length > 8) { S.list.shift(); }
            S.seen++;
            tap(s);
          } catch (e) {}
          return s;
        }
      });
      try { NW.__dshHealWs = 1; } catch (e) {}
      W.WebSocket = NW;
    } catch (e) { err("hookWs", e); }
  }

  /* 只观察，不改写：记录 speech/follow 的 open 帧与 catalog 回帧，用于远端诊断 */
  function tap(s) {
    try {
      var send = s.send;
      s.send = function (d) {
        try {
          if (typeof d === "string" && d.indexOf('"endpoint":"speech/follow"') >= 0) { S.sent = true; }
        } catch (e) {}
        return send.apply(s, arguments);
      };
      s.addEventListener("message", function (ev) {
        try {
          var d = ev && ev.data;
          if (typeof d === "string" && d.indexOf('"providers"') >= 0) { S.got = true; }
        } catch (e) {}
      });
    } catch (e) { err("tap", e); }
  }

  function cycleSockets() {
    var n = 0;
    for (var i = S.list.length - 1; i >= 0; i--) {
      try {
        var s = S.list[i];
        if (s && (s.readyState === 0 || s.readyState === 1)) { s.close(); n++; }
      } catch (e) { err("close", e); }
    }
    S.list = [];
    return n;
  }

  function notReadyDialog() {
    try {
      var ds = D.querySelectorAll('[role="dialog"]');
      for (var i = 0; i < ds.length; i++) {
        if (ds[i] && (ds[i].innerText || "").indexOf(NEEDLE) >= 0) { return ds[i]; }
      }
    } catch (e) { err("scan", e); }
    return null;
  }

  function dismissLater(dlg) {
    try {
      var btns = (dlg || D).querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || "").trim();
        if (t === "稍后" || t === "Later") { btns[i].click(); return true; }
      }
    } catch (e) { err("dismiss", e); }
    return false;
  }

  function heal(why, dlg) {
    if (!S.on || !mobile()) { return false; }
    var now = Date.now();
    if (now - S.lastAt < MIN_GAP) { return false; }
    if (S.heals >= MAX_HEALS) { return false; }
    S.lastAt = now;
    S.heals++;
    S.lastWhy = why;
    S.lastClosed = cycleSockets();
    beacon("/__vh/" + S.heals + (S.lastClosed ? "c" : "n"));
    try {
      if (W.console && console.log) {
        console.log("[dsh-voiceheal] heal#" + S.heals + " why=" + why + " closed=" + S.lastClosed);
      }
    } catch (e) {}
    setTimeout(function () {
      try {
        if (notReadyDialog()) { dismissLater(dlg && dlg.isConnected ? dlg : notReadyDialog()); }
      } catch (e) { err("post", e); }
    }, 1200);
    return true;
  }

  function tick() {
    try {
      if (!S.on || !mobile()) { return; }
      var d = notReadyDialog();
      if (!d) { return; }
      S.triggers++;
      heal("notReadyDialog", d);
    } catch (e) { err("tick", e); }
  }

  hookWs();
  setInterval(tick, 1500);
  // 一次性诊断信标：15 秒后报"手机侧到底有没有看到 speech/follow 流"
  setTimeout(function () {
    if (S.beaconed) { return; }
    S.beaconed = true;
    beacon("/__vs/" + (S.sent ? "1" : "0") + (S.got ? "1" : "0"));
  }, 15000);

  W.__dshVoiceHeal = {
    version: V,
    onNow: function () { S.on = true; return S.on; },
    offNow: function () { S.on = false; return S.on; },
    healNow: function () { S.lastAt = 0; return heal("manual", null); },
    state: function () {
      return {
        version: V,
        on: S.on,
        mobile: mobile(),
        socketsSeen: S.seen,
        triggers: S.triggers,
        heals: S.heals,
        lastClosed: S.lastClosed,
        lastWhy: S.lastWhy,
        dialogShown: !!notReadyDialog(),
        errors: S.errs
      };
    }
  };

  try { console.log("[dsh-hot] voiceselfheal ready " + V); } catch (_) {}
})();
