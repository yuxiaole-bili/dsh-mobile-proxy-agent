/* ============================================================================
 * dsh-hotpatch / 10-base.js —— 热补丁运行时基座
 * ----------------------------------------------------------------------------
 * 1) window.__dshHot        ：版本、状态、错误查询、原生桥包装
 * 2) window.__dshHotErrors  ：任何补丁文件抛出的异常都进这里（APK 诊断页会显示）
 * 3) window.dshNative(...)  ：把 APK 里的 window.__DSHNative.call 包成 Promise
 *      call(method, argsJson) -> callId（同步返回）
 *      __DSHNativeResult(callId, resultJson)（异步回，用 callId 关联）
 * 4) window.__dshNativeBack ：硬件返回键。APK 的 onBackPressed 先问这里，
 *      返回 true 表示页面已处理，不退出。
 * 5) speech.* 的流式分片由这里把语音桥的 __dshVoiceResult 等回调**链式**中继到
 *    __DSHNativeResult（保留原有回调，不覆盖）。
 *
 * 这个文件本身也走热补丁通道 —— 随时可改，无需重装 APK、无需重启代理。
 * ========================================================================== */
(function () {
  var W = window;
  var HOOKV = "2026-10-04.2";
  var MOBILE = /Android|iPhone|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);

  W.__dshHotErrors = W.__dshHotErrors || [];
  W.__dshNativeWait = W.__dshNativeWait || {};
  W.__dshNativeUndo = W.__dshNativeUndo || {};

  function logErr(f, e) {
    try {
      W.__dshHotErrors.length > 60 && __dshHotErrors.shift(), __dshHotErrors.push({ f: f, e: String((e && e.stack) || e), t: Date.now() });
      if (W.__dshHotErrors.length > 200) { W.__dshHotErrors.splice(0, 100); }
    } catch (_) {}
  }

  // 只负责记录：补丁脚本加载失败（404/403）在页面里表现为 script error 事件
  try {
    if (!W.__dshHotErrHook) {
      W.__dshHotErrHook = 1;
      W.addEventListener("error", function (e) {
        try {
          var t = e && e.target;
          if (t && t.tagName === "SCRIPT" && /\/__hot\//.test(t.src || "")) {
            logErr("patch.js(load)", "script load failed: " + t.src);
          }
        } catch (_) {}
      }, true);
      W.addEventListener("unhandledrejection", function (e) {
        try {
          var r = e && e.reason;
          if (r && (r.error === "native-timeout" || r.error === "unknown-method"
                    || r.error === "no-native-bridge")) { return; }   // 桥自己的错误已经回给调用方
          logErr("patch.js(promise)", r);
        } catch (_) {}
      });
    }
  } catch (_) {}

  function hasNative() {
    return !!(W.__DSHNative && typeof W.__DSHNative.call === "function");
  }

  /* ---- 语音流式中继：全局只包一层，按监听者分发 ----
   * 关键：绝不能每个调用各自链式包一层 —— 那样"上一次会话的收尾事件"会被链到
   * "下一次会话"的回调里（实测过的交叉污染）。这里全局只包一层 fan-out，
   * 每个调用注册/注销自己的监听者，原有回调始终只被调用一次。 */
  var voiceListeners = [];

  function voiceListenersCount() { return voiceListeners.length; }

  function voiceInstallOnce() {
    if (W.__dshVoiceFanout) { return; }
    W.__dshVoiceFanout = 1;
    function hook(name, make) {
      var prev = W[name];
      W[name] = function () {
        var a = arguments;
        try { if (typeof prev === "function") { prev.apply(null, a); } } catch (_) {}
        var frame;
        try { frame = make.apply(null, a); } catch (e) { return; }
        for (var i = voiceListeners.length - 1; i >= 0; i--) {
          try { voiceListeners[i](frame); } catch (e2) { logErr("voice-fanout", e2); }
        }
      };
    }
    hook("__dshVoiceAsrReady", function () { return { ok: true, event: "ready" }; });
    hook("__dshVoiceResult", function (t, f) {
      return { ok: true, event: f ? "result" : "partial",
               text: String(t == null ? "" : t), final: !!f };
    });
    hook("__dshVoiceAsrEnd", function () { return { ok: true, event: "end", final: true }; });
    hook("__dshVoiceAsrError", function (c, m) {
      return { ok: false, error: String(c || "asr-error"), msg: String(m || ""),
               event: "error", final: true };
    });
  }

  function voiceListen(fn) {
    voiceInstallOnce();
    voiceListeners.push(fn);
    return function () {
      var i = voiceListeners.indexOf(fn);
      if (i >= 0) { voiceListeners.splice(i, 1); }
    };
  }

  /* ---- 原生桥 Promise 包装 ----
   * 流式方法（见 STREAMING）：onEvent(frame) 收到每一帧，Promise 只在最终帧
   * （final/end/error）settle —— 一个 Promise 只能 resolve 一次，分片绝不能靠 resolve 传。
   * 流式方法的"受理回执"帧没有 event，会被标成 event:"ack" 交给 onEvent，不当成最终帧。 */
  var STREAMING = { "speech.start": 1 };

  function bridge(method, args) {
    return new Promise(function (resolve, reject) {
      if (!hasNative()) { reject(new Error("no-native-bridge")); return; }
      var streaming = !!STREAMING[method];
      var onEvent = (args && typeof args.onEvent === "function") ? args.onEvent : null;
      var id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      var key = id;                 // 原生可能返回自己的 callId -> key 要跟着改
      var settled = false;
      var drained = false;
      var drainTimer = null;
      var lastText = null;
      var sawContent = false;
      var unlisten = null;
      function drain() {
        if (drained) { return; }
        drained = true;
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
        delete W.__dshNativeWait[key];
        if (unlisten) { try { unlisten(); } catch (_) {} unlisten = null; }
      }
      function settle(o) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        if (o && o.ok === false) { reject(o); } else { resolve(o); }
      }
      var timer = setTimeout(function () {
        if (settled) { return; }
        settled = true;
        logErr("native(" + method + ")", "timeout");
        drain();
        reject(new Error("native-timeout"));
      }, 30000);
      W.__dshNativeWait[key] = function (res) {
        var o = res;
        if (typeof o === "string") { try { o = JSON.parse(o); } catch (e) { o = { ok: true, value: o }; } }
        if (streaming && o && o.event === "end" && !sawContent) {
          // 上一次会话的收尾 end 落到了本次会话开头：丢弃。
          // 本次自己的 end 一定跟在 ready/partial/result 之后，所以这条规则不会误伤；
          // 而 error 永远放行（识别失败必须让调用方看到）。
          return;
        }
        if (o && (o.event === "ready" || o.event === "partial" || o.event === "result")) {
          sawContent = true;
        }
        var isFinal;
        if (o && o.ok === false) {
          isFinal = true;                                   // 明确失败：立刻 settle
        } else if (o && (o.final === true || o.event === "end" || o.event === "error")) {
          isFinal = true;
        } else if (o && o.event) {
          isFinal = false;                                  // ready / partial / result（非最终）
        } else if (streaming) {
          isFinal = false;                                  // 流式方法的受理回执
          o = { ok: true, event: "ack", value: (o && o.value) || null };
        } else {
          isFinal = true;                                   // 非流式：没有 event 就是最终帧
        }
        if (o && o.event === "result") { lastText = o.text; }
        if (isFinal && o && o.event === "end") {
          o = { ok: true, event: "end", final: true,
                text: (lastText === null ? "" : lastText) };   // resolve 时带上最终文本
        }
        if (onEvent) { try { onEvent(o); } catch (e) { logErr("onEvent(" + method + ")", e); } }
        if (isFinal) { settle(o); }
        if (!streaming) { drain(); return; }
        // 流式：收到结束帧就卸载中继；只拿到最终结果也给它 3s 收尾窗口
        if (o && (o.event === "end" || o.event === "error" || o.ok === false)) {
          drain();
        } else if (settled && !drainTimer) {
          drainTimer = setTimeout(drain, 3000);
        }
      };
      if (streaming) {
        // 把语音桥的流式回调中继到 __DSHNativeResult(key, ...)
        unlisten = voiceListen(function (frame) {
          var f = W.__dshNativeWait[key];
          if (f) { try { f(frame); } catch (e) { logErr("relay(" + method + ")", e); } }
        });
      }
      var payload = {};
      for (var k in (args || {})) {
        if (k !== "onEvent" && Object.prototype.hasOwnProperty.call(args, k)) { payload[k] = args[k]; }
      }
      payload.callId = id;
      var rid = null;
      try {
        rid = W.__DSHNative.call(method, JSON.stringify(payload));
      } catch (e) {
        settled = true; clearTimeout(timer); drain(); reject(e); return;
      }
      if (rid && rid !== id) {
        // 以原生返回的 callId 为准，否则结果永远对不上
        W.__dshNativeWait[rid] = W.__dshNativeWait[key];
        delete W.__dshNativeWait[key];
        key = rid;
      }
    });
  }

  if (!W.__DSHNativeResult) {
    W.__DSHNativeResult = function (callId, resultJson) {
      var m = W.__dshNativeWait || {};
      var fn = m[callId];
      if (!fn) { return; }
      try {
        var o = typeof resultJson === "string" ? JSON.parse(resultJson) : resultJson;
        fn(o);
      } catch (e) {
        logErr("10-base.js", "bad native result: " + e);
      }
    };
  }

  W.dshNative = bridge;

  /* ---- 硬件返回键 ---- */
  if (typeof W.__dshNativeBack !== "function") {
    W.__dshNativeBack = function () {
      try {
        // 通用兜底：有可见的 dialog/modal 或打开的抽屉就关掉它
        var d = document.querySelector('[role="dialog"]:not([hidden])');
        if (d) {
          var btn = d.querySelector('[aria-label*="lose"],[aria-label*="关闭"],button');
          if (btn) { btn.click(); return true; }
          return false;
        }
      } catch (_) {}
      return false;
    };
  }

  W.__dshHot = {
    version: HOOKV,
    mobile: MOBILE,
    errors: function () { return W.__dshHotErrors.slice(); },
    clearErrors: function () { W.__dshHotErrors.length = 0; },
    native: hasNative,
    call: bridge,
    state: function () {
      var sc = document.getElementById("dsh-hot");
      var lk = document.getElementById("dsh-hot-css");
      return {
        version: HOOKV,
        mobile: MOBILE,
        native: hasNative(),
        ios: /iPhone|iPad|iPod/i.test(navigator.userAgent),
        errors: W.__dshHotErrors.length,
        js: sc ? sc.src : null,
        css: lk ? lk.href : null
      };
    },
    // 在手机上做一次端到端自检：桥往返（ping + info）
    selfTest: function () {
      if (!hasNative()) { return Promise.resolve({ native: false }); }
      var t0 = Date.now();
      return bridge("ping", {}).then(function (p) {
        return bridge("info", {}).then(function (i) {
          return { native: true, ping: p, info: i, ms: Date.now() - t0 };
        });
      });
    },
    speech: {
      available: function () { return bridge("speech.available", {}); },
      start: function (lang, onEvent) {
        return bridge("speech.start", { lang: lang || "zh-CN", onEvent: onEvent });
      },
      stop: function () { return bridge("speech.stop", {}); }
    }
  };

  try { console.log("[dsh-hot] base ready " + HOOKV + " native=" + hasNative()); } catch (_) {}
})();
