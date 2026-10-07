/* 40-panels.js —— 手机 App 内的「服务器面板」入口
 *
 * 起因：手机浏览器的流量没走 Tailscale（安卓分应用 VPN 把浏览器排除了），所以
 * 浏览器打不开服务器上的 9090 / 10100 / 10110。但 **App 的 WebView 是走 Tailscale 的**
 * （服务器上能看到手机节点的连接），所以把面板嵌进 App 里就能用。
 *
 * 做法：右下角一个小按钮 → 全屏浮层里用 iframe 打开面板；地址默认取当前页面主机
 * （手机是经 <TAILSCALE-IP>:19390 访问的，所以面板就是同一个主机的别的端口）。
 * 这几个服务都没有 X-Frame-Options / CSP（已实测），可以嵌。
 *
 * 关闭：右上角 ✕、按返回键（挂到 __dshNativeBack）。地址不对可以逐个换。
 * 关掉本补丁：地址加 ?no-panels=1
 */
(function () {
  var W = window, D = document;
  if (W.__dshPanels || /[?&]no-panels=1/.test(location.search)) { return; }

  var VERSION = "2026-10-06.1";
  var LS_TAB = "dsh-panels-tab";
  var LS_HOST = "dsh-panels-host";

  /* 面板清单：名字 + 端口（10100 是 YuAgent 面板首页，10110 是它的前端） */
  var TABS = [
    { port: 9090, label: "9090 面板" },
    { port: 10100, label: "10100 面板" },
    { port: 10110, label: "10110 前端" },
    { port: 10120, label: "10120 网关" }
  ];

  var S = { opens: 0, closes: 0, errors: [], tab: 0, host: null, opened: false };

  function logErr(where, e) {
    try {
      S.errors.push(where + ": " + (e && e.message ? e.message : String(e)));
      if (W.__dshHotErrors) { W.__dshHotErrors.push("[40-panels] " + where + ": " + e); }
    } catch (_) {}
  }

  /* ---- 候选地址：先当前主机，再同网段的 .1，再已知地址 ---- */
  function candidates() {
    var out = [], seen = {};
    function add(h) {
      if (!h || seen[h]) { return; }
      seen[h] = 1;
      out.push(h);
    }
    try { add(location.hostname); } catch (e) {}
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(location.hostname || "");
    if (m) { add(m[1] + "." + m[2] + "." + m[3] + ".1"); }
    add("<TAILSCALE-IP>");
    add("<SRV-LAN-IP>");
    add("<SRV-LAN-IP>");
    return out;
  }

  function savedHost() {
    var saved = null;
    try { saved = localStorage.getItem(LS_HOST); } catch (e) {}
    var list = candidates();
    if (saved && list.indexOf(saved) >= 0) { return saved; }
    if (saved) { list.unshift(saved); }
    return list[0];
  }

  function urlFor(port) { return "http://" + S.host + ":" + port + "/"; }

  function css(el, style) {
    for (var k in style) { if (Object.prototype.hasOwnProperty.call(style, k)) { el.style[k] = style[k]; } }
  }

  /* ---- UI ---- */
  var root = null, frameEl = null, tabsEl = null, statusEl = null, addrEl = null, btn = null;

  function build() {
    if (root) { return root; }
    root = D.createElement("div");
    root.id = "dsh-panels";
    css(root, { position: "fixed", left: "0", top: "0", right: "0", bottom: "0",
                zIndex: "2147483600", display: "none", flexDirection: "column",
                background: "#0b0f14", color: "#e8eef7" });

    var head = D.createElement("div");
    css(head, { flex: "0 0 auto", display: "flex", alignItems: "center", gap: "6px",
                padding: "6px 8px", background: "#111823", borderBottom: "1px solid #1e2836",
                paddingTop: "calc(env(safe-area-inset-top,0px) + 6px)" });

    var title = D.createElement("div");
    title.textContent = "服务器面板";
    css(title, { fontSize: "13px", fontWeight: "600", flex: "0 0 auto" });
    var close = D.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", "关闭");
    close.setAttribute("data-dsh-panels", "close");
    css(close, { marginLeft: "auto", background: "#1b2634", color: "#e8eef7",
                 border: "1px solid #1e2836", borderRadius: "8px", width: "30px",
                 height: "28px", fontSize: "14px", lineHeight: "1", cursor: "pointer" });
    close.onclick = function () { close_(); };
    head.appendChild(title);

    addrEl = D.createElement("button");
    addrEl.type = "button";
    addrEl.setAttribute("data-dsh-panels", "addr");
    css(addrEl, { marginLeft: "6px", background: "#0f1520", color: "#8fa0b5",
                  border: "1px solid #1e2836", borderRadius: "8px", fontSize: "11px",
                  padding: "5px 6px", maxWidth: "40%", overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" });
    addrEl.title = "点一下换地址";
    addrEl.onclick = function () { cycleHost(); };
    head.appendChild(addrEl);
    head.appendChild(close);

    tabsEl = D.createElement("div");
    css(tabsEl, { flex: "0 0 auto", display: "flex", gap: "4px", padding: "0 8px 6px",
                  background: "#111823", borderBottom: "1px solid #1e2836",
                  overflowX: "auto", WebkitOverflowScrolling: "touch" });

    statusEl = D.createElement("div");
    css(statusEl, { flex: "0 0 auto", display: "none", padding: "6px 10px",
                    fontSize: "12px", color: "#ffcf7a", background: "#1a1408",
                    borderBottom: "1px solid #33280f", wordBreak: "break-all" });

    var body = D.createElement("div");
    css(body, { flex: "1", minHeight: "0", position: "relative", background: "#fff" });
    frameEl = D.createElement("iframe");
    frameEl.setAttribute("data-dsh-panels", "frame");
    frameEl.setAttribute("referrerpolicy", "no-referrer");
    css(frameEl, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
                   border: "0", background: "#fff" });
    body.appendChild(frameEl);

    root.appendChild(head);
    root.appendChild(tabsEl);
    root.appendChild(statusEl);
    root.appendChild(body);
    (D.body || D.documentElement).appendChild(root);
    renderTabs();
    return root;
  }

  function renderTabs() {
    if (!tabsEl) { return; }
    while (tabsEl.firstChild) { tabsEl.removeChild(tabsEl.firstChild); }
    for (var i = 0; i < TABS.length; i += 1) {
      (function (idx) {
        var t = TABS[idx];
        var b = D.createElement("button");
        b.type = "button";
        b.textContent = t.label;
        b.setAttribute("data-dsh-panels", "tab-" + t.port);
        var on = idx === S.tab;
        css(b, { flex: "0 0 auto", padding: "5px 9px", fontSize: "12px", borderRadius: "999px",
                 border: "1px solid " + (on ? "#2f6fdd" : "#1e2836"),
                 background: on ? "#17325c" : "#0f1520",
                 color: on ? "#cfe1ff" : "#8fa0b5", cursor: "pointer" });
        b.onclick = function () { selectTab(idx); };
        tabsEl.appendChild(b);
      })(i);
    }
  }

  function selectTab(idx) {
    try {
      S.tab = idx;
      try { localStorage.setItem(LS_TAB, String(idx)); } catch (e) {}
      renderTabs();
      load();
    } catch (e) { logErr("selectTab", e); }
  }

  function cycleHost() {
    try {
      var list = candidates();
      var at = list.indexOf(S.host);
      S.host = list[(at + 1) % list.length];
      try { localStorage.setItem(LS_HOST, S.host); } catch (e) {}
      load();
    } catch (e) { logErr("cycleHost", e); }
  }

  function setStatus(text, tone) {
    if (!statusEl) { return; }
    if (!text) { statusEl.style.display = "none"; statusEl.textContent = ""; return; }
    statusEl.style.display = "block";
    statusEl.textContent = text;
    statusEl.style.color = tone === "bad" ? "#ffb4b4" : "#ffcf7a";
  }

  /* 探活：no-cors 请求成功 = 主机在该端口上有响应（跨域读不到内容，但能判断可达） */
  function probe(url) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(false); } }, 3500);
      try {
        W.fetch(url, { mode: "no-cors", cache: "no-store" }).then(function () {
          if (!done) { done = true; clearTimeout(timer); resolve(true); };
        }, function () {
          if (!done) { done = true; clearTimeout(timer); resolve(false); };
        });
      } catch (e) { clearTimeout(timer); resolve(false); }
    });
  }

  function load() {
    var t = TABS[S.tab];
    var url = urlFor(t.port);
    if (addrEl) { addrEl.textContent = S.host; }
    setStatus("正在打开 " + url + " …");
    probe(url).then(function (ok) {
      if (!ok) {
        setStatus("连不上 " + url + "。点上面的地址换一个（App 内是走 Tailscale 的；" +
                  "若都不通，说明这台主机在该网段不可达）。");
        return;
      }
      setStatus("");
      try { frameEl.src = url; } catch (e) { logErr("load", e); }
    }, function () { setStatus("探测失败：" + url); });
  }

  function open_(idx) {
    try {
      build();
      if (typeof idx === "number") { S.tab = idx; renderTabs(); }
      if (S.opened) { load(); return; }
      S.opened = true;
      S.opens += 1;
      S.host = S.host || savedHost();
      root.style.display = "flex";
      load();
      try {
        // 桌面浏览器没有原生桥；dshNative 会 reject，必须接住，否则控制台报未处理拒绝
        if (W.__dshHot && W.__dshHot.native && W.__dshHot.native()) {
          var vib = W.dshNative("vibrate", { ms: 12 });
          if (vib && typeof vib.catch === "function") { vib.catch(function () {}); }
        }
      } catch (e) {}
    } catch (e) { logErr("open", e); }
  }

  function close_() {
    try {
      if (!S.opened) { return; }
      S.opened = false;
      S.closes += 1;
      root.style.display = "none";
      try { frameEl.removeAttribute("src"); } catch (e) {}
    } catch (e) { logErr("close", e); }
  }

  /* ---- 右下角入口按钮（放在提示音按钮上方，避开它）---- */
  function mountButton() {
    try {
      if (btn && btn.parentNode) { return; }
      if (!D.body) { return; }
      btn = D.createElement("button");
      btn.type = "button";
      btn.id = "dsh-panels-btn";
      btn.textContent = "▣";
      btn.setAttribute("aria-label", "服务器面板");
      btn.title = "服务器面板（在 App 内打开 9090/10100/10110）";
      css(btn, { position: "fixed", right: "10px", bottom: "46px", zIndex: "2147483590",
                 width: "28px", height: "28px", padding: "0", borderRadius: "50%",
                 border: "1px solid rgba(127,127,127,.35)", background: "rgba(20,20,24,.55)",
                 color: "inherit", fontSize: "14px", lineHeight: "1", cursor: "pointer",
                 opacity: ".35", transition: "opacity .15s" });
      btn.addEventListener("mouseenter", function () { btn.style.opacity = "1"; });
      btn.addEventListener("mouseleave", function () { btn.style.opacity = "0.35"; });
      btn.onclick = function () { open_(); };
      D.body.appendChild(btn);
    } catch (e) { logErr("mountButton", e); }
  }

  /* ---- 返回键：浮层开着就先关它 ---- */
  function hookBack() {
    try {
      var prev = W.__dshNativeBack;
      W.__dshNativeBack = function () {
        try { if (S.opened) { close_(); return true; } } catch (e) {}
        return typeof prev === "function" ? prev() : false;
      };
    } catch (e) { logErr("hookBack", e); }
  }

  function start() {
    try {
      var t = 0;
      try { t = parseInt(localStorage.getItem(LS_TAB) || "0", 10); } catch (e) {}
      S.tab = (t >= 0 && t < TABS.length) ? t : 0;
      S.host = savedHost();
      mountButton();
      hookBack();
      setInterval(function () { mountButton(); }, 1500);
      var f = build();
      f.style.display = "none";
    } catch (e) { logErr("start", e); }
  }

  W.__dshPanels = {
    version: VERSION,
    open: open_,
    close: close_,
    tabs: TABS,
    state: function () {
      return { version: VERSION, opened: S.opened, tab: S.tab, host: S.host,
               opens: S.opens, closes: S.closes, errors: S.errors.slice(),
               candidates: candidates(),
               frameSrc: frameEl ? String(frameEl.getAttribute("src") || "") : null,
               button: !!btn };
    }
  };

  if (D.readyState === "loading") { D.addEventListener("DOMContentLoaded", start); } else { start(); }
})();
