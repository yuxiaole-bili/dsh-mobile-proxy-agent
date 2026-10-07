/* 30-rboverlay.js —— 手机上让"文档预览"可见（配合 00-base.css 的 .dsh-rb 规则）
 *
 * 真机/无头实测的根因：点会话里的文件 chip 后，DSH 右侧栏文档预览其实打开了，
 * 但右栏列宽是 0（grid-template-columns: 0px 304px 0px），面板被排到 x=417，
 * 而视口只有 360 宽 —— 于是"什么都没有"，blob 还会被 WebView 接管打开第三方应用。
 *
 * 这里只做一件事：右栏**有内容**时给 <html> 打 data-dsh-rb="1"，空了就摘掉。
 * 全屏覆盖的样式在 00-base.css 里，且只在 data-dsh-rb="1" 时生效 ——
 * 这样没内容时绝不会有一层东西挡住界面。
 */
(function () {
  var W = window, D = document;
  if (W.__dshRbOverlay) { return; }

  var S = { on: false, applied: 0, cleared: 0, lastSize: 0 };
  var mo = null, timer = null;

  function rightbar() {
    var f = D.querySelector('[class*="frame"]');
    if (!f) { return null; }
    var kids = f.children, i;
    for (i = 0; i < kids.length; i += 1) {
      if (String(kids[i].className || "").indexOf("rightbarCol") >= 0) { return kids[i]; }
    }
    return null;
  }

  /* "有内容"的判定：子树里出现可见的预览类节点，或面板带可读文本。
     空右栏只有一个 0 宽的空容器，判定为 false。 */
  function hasContent(rb) {
    if (!rb) { return false; }
    /* 必须**真实可见的内容**才算：判松了会把空右栏/残留的报错面板当成内容，
       覆盖层就会盖住整个界面（2026-10-06 真机事故：整页变空白）。 */
    var media = rb.querySelectorAll("img,iframe,video,canvas");
    var i;
    for (i = 0; i < media.length; i += 1) {
      var mr = media[i].getBoundingClientRect();
      if (mr.width >= 40 && mr.height >= 40) { return true; }
    }
    var boxes = rb.querySelectorAll('[class*="preview"],[class*="document"],[class*="markdown"]');
    for (i = 0; i < boxes.length; i += 1) {
      var br = boxes[i].getBoundingClientRect();
      if (br.width < 24 || br.height < 24) { continue; }
      var text = String(boxes[i].textContent || "").replace(/\s+/g, "");
      /* ≥16 字才算正文："文件资源服务不可用"（11 字）这类状态文案不算 */
      if (text.length >= 16) { return true; }
    }
    return false;
  }

  function sync() {
    try {
      var rb = rightbar();
      var want = hasContent(rb);
      if (want === S.on) { return; }
      S.on = want;
      var root = D.documentElement;
      if (want) {
        root.setAttribute("data-dsh-rb", "1");
        S.applied += 1;
        try { console.log("[dsh-rb] preview visible -> full-screen overlay"); } catch (e0) {}
      } else {
        root.removeAttribute("data-dsh-rb");
        S.cleared += 1;
      }
    } catch (e) { /* 补丁绝不抛出 */ }
  }

  function watch() {
    try {
      if (mo) { mo.disconnect(); }
      var rb = rightbar();
      if (!rb) { return false; }
      mo = new MutationObserver(function () { sync(); });
      mo.observe(rb, { childList: true, subtree: true, attributes: true, characterData: true });
      sync();
      return true;
    } catch (e) { return false; }
  }

  function start() {
    watch();
    /* 右栏容器可能后于本补丁出现，低频兜底重挂 */
    timer = setInterval(function () {
      if (!mo) { watch(); } else { sync(); }
    }, 1200);
    sync();
  }

  W.__dshRbOverlay = {
    state: function () {
      return { on: S.on, applied: S.applied, cleared: S.cleared,
               hasRightbar: !!rightbar(), flag: D.documentElement.getAttribute("data-dsh-rb") };
    },
    resync: sync
  };

  if (D.readyState === "loading") {
    D.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
