/* 45-chipview.js —— 会话里的"文件 chip"点击改用本仓库自己的预览层
 *
 * 为什么：手机上 DSH 自带的文档预览有两个死结 ——
 *   ① 窄屏下右栏列宽被压成 0，预览面板被排到屏幕外（见 §15）；
 *   ② 手机端文件资源 provider 未注册，面板里只显示"文件资源服务不可用|file resource service is unavailable"（见 §19）。
 * 所以直接把 chip 的点击接管，走 50-fileview.js 的轻量预览层 + 代理的 /f
 * （代理已支持工作区相对路径与裸文件名唯一匹配）。
 *
 * 只在**手机上**、且点到文件 chip 时生效；预览层不可用或解析不出路径就原样放行。
 * 关掉：地址加 ?no-chipview=1
 */
(function () {
  var W = window, D = document;
  if (W.__dshChipView || /[?&]no-chipview=1/.test(location.search)) { return; }
  var MOBILE = /Android|iPhone|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent || "");
  if (!MOBILE) { return; }   // 桌面浏览器上 DSH 自带预览是好的，不动它

  var S = { taken: 0, passthrough: 0, missed: 0, last: null, errors: [] };

  function logErr(where, e) {
    try {
      S.errors.push(where + ": " + (e && e.message ? e.message : String(e)));
      if (W.__dshHotErrors) { W.__dshHotErrors.push("[45-chipview] " + where + ": " + e); }
    } catch (_) {}
  }

  var CHIP = 'button[class*="_fileLink"],button[class*="_fileMention"],button[class*="fileLink"],button[class*="fileMention"]';

  function chipOf(node) {
    try {
      if (!node) { return null; }
      if (node.closest) { return node.closest(CHIP); }
    } catch (e) {}
    return null;
  }

  /* 取路径：① title（DSH 无内联预览时会填完整路径）② chip 文本 ③ 附近带目录的文本 */
  function pathOf(btn) {
    var title = "";
    try { title = String(btn.getAttribute("title") || "").trim(); } catch (e) {}
    if (title && /\.[A-Za-z0-9]{1,8}$/.test(title)) { return title; }

    var text = "";
    try { text = String(btn.textContent || "").trim(); } catch (e) {}
    if (!text) { return ""; }

    /* 工具行/交付行里往往并排写着相对路径，取包含该文件名的那个 */
    try {
      var scope = btn.closest('[class*="row"],[class*="card"],[class*="tool"],[class*="deliverable"]') || btn.parentElement;
      if (scope) {
        var nodes = scope.querySelectorAll("span,div,code,a");
        for (var i = 0; i < nodes.length; i += 1) {
          var s = String(nodes[i].textContent || "").trim();
          if (s.length > text.length && s.length < 240 && s.indexOf(text) >= 0 && /[\\/]/.test(s)) {
            var m = s.match(/[A-Za-z]:[\\/][^\s"'<>|]+|[^\s"'<>|]*[\\/][^\s"'<>|]*/);
            if (m && m[0]) { return m[0].trim(); }
            return s;
          }
        }
      }
    } catch (e) {}
    return text;
  }

  function preview(path, opts) {
    try {
      if (W.__dshFileView && typeof W.__dshFileView.open === "function") {
        return W.__dshFileView.open(path, opts);
      }
      if (typeof W.__dshOpenFile === "function") { return W.__dshOpenFile(path, opts); }
    } catch (e) { logErr("preview", e); }
    return false;
  }

  function onClick(ev) {
    try {
      if (ev && (ev.button !== undefined && ev.button !== 0)) { return; }
      var btn = chipOf(ev.target);
      if (!btn) { return; }
      var canPreview = (W.__dshFileView && typeof W.__dshFileView.open === "function") || typeof W.__dshOpenFile === "function";
      if (!canPreview) { S.missed += 1; return; }        // 预览层不在 → 交给 DSH
      var path = pathOf(btn);
      if (!path) { S.missed += 1; return; }
      var ok = preview(path, { file: true });
      if (ok === false) { S.missed += 1; return; }       // 预览层自己拒绝了 → 交给 DSH
      /* 预览成功才吃掉这次点击（阻止 DSH 打开它那个排到屏幕外的面板） */
      S.taken += 1;
      S.last = path;
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      try { if (ev.stopImmediatePropagation) { ev.stopImmediatePropagation(); } } catch (e) {}
    } catch (e) { logErr("onClick", e); }
  }

  try { D.addEventListener("click", onClick, true); } catch (e) { logErr("listen", e); }

  W.__dshChipView = {
    version: "2026-10-06.1",
    state: function () {
      return { version: "2026-10-06.1", taken: S.taken, missed: S.missed,
               last: S.last, errors: S.errors.slice(),
               fileview: !!(W.__dshFileView && W.__dshFileView.open) };
    }
  };
})();
