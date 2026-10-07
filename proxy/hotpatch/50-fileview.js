/* ============================================================================
 * dsh-hotpatch / 50-fileview.js —— 手机端"就地看文件"
 * ----------------------------------------------------------------------------
 * 背景：DSH 的 "在应用中打开 / Open in app"（插件 dsh-client-ui-open-in-app）
 * 会把 path 交给 Host（电脑）用本地应用打开。手机上看不到任何东西。
 *
 * 本补丁把这条请求在**页面侧**接过来：识别到"打开文件/在工作区打开"的调用后
 * 拦下它，改为在手机浏览器里打开代理的只读文件接口：
 *     /f?path=<绝对路径>&k=<cap.key>      内联预览（文本 / 图片 / PDF）
 *     /d?path=<目录>&k=<cap.key>          目录列表（可点进子目录 / 文件）
 *     /dl?path=...&k=...                  强制下载
 *
 * 接管的三条链路（任一条命中，就绝不落到"电脑打开"）：
 *   1. fetch POST /api/session/openWorkspacePath   ← "打开文件/显示文件位置"按钮
 *      （并顺带接管 /api/session/workspacePathApplications，让它列出"本机"）
 *   2. fetch POST /open-in-app/open                ← 会话头的"在应用中打开"
 *      （并接管 GET /open-in-app/apps，返回一个本机条目）
 *   3. window.__dshOpenFile(path, opts)            ← 手工/其它补丁调用入口
 *
 * 失败必回落：任何一步（没有可用地址 / 弹层建不出来 / 路径非法）出问题，都退回
 * 原始请求 —— 该发出去的发出去，功能一点不丢。
 *
 * 开关：?no-fileview=1 完全关闭本补丁；window.__dshFileView.enable/disable()。
 * ========================================================================== */
(function () {
  var W = window, D = document;
  if (W.__dshFileView) { return; }          // 幂等

  var MOBILE = /Android|iPhone|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
  var OFF = /[?&]no-fileview=1/.test(location.search);
  var S = { opens: 0, taken: 0, fallbacks: 0, last: null, errors: [] , on: !OFF };

  function logErr(f, e) {
    try {
      S.errors.push({ f: f, e: String((e && e.stack) || e), t: Date.now() });
      if (S.errors.length > 50) { S.errors.splice(0, 25); }
      if (W.__dshHotErrors) {
        W.__dshHotErrors.push({ f: "50-fileview/" + f, e: String((e && e.stack) || e), t: Date.now() });
      }
    } catch (_) {}
  }

  /* ---- 访问密钥：地址栏 ?k= 优先，其次 dshcap cookie 已足够（同源自动带） ---- */
  function key() {
    try {
      var m = /[?&]k=([^&\s#]+)/.exec(location.search + location.hash);
      if (m) { return decodeURIComponent(m[1]); }
      var c = D.cookie || "";
      var m2 = /(?:^|;\s*)dshcap=([^;]*)/.exec(c);
      if (m2) { return decodeURIComponent(m2[1]); }
    } catch (_) {}
    return "";
  }

  function enc(s) { return encodeURIComponent(String(s)); }

  function urlFor(path, mode) {
    var p = String(path == null ? "" : path);
    var k = key();
    return "/" + (mode || "f") + "?path=" + enc(p) + (k ? "&k=" + enc(k) : "");
  }

  function isDirPath(p) { return /[\\/]$/.test(String(p || "")); }

  function isMobile() { return !!MOBILE; }

  /* =======================  弹层（在手机内查看）  ======================= */
  var root = null, frameEl = null, titleEl = null, statusEl = null, pathEl = null, bodyEl = null;
  var curUrl = "", curPath = "", isImg = false, isPdf = false, isText = false;
  var IMG = /\.(png|jpe?g|jfif|webp|gif|bmp|ico)$/i;
  var PDF = /\.pdf$/i;

  /* =======================  代码上色（自写 tokenizer，不引第三方库）  ======================= */
  var CODE_RE = /\.(py|pyw|pyi|js|mjs|cjs|jsx|ts|tsx|mts|cts|java|kt|kts|scala|groovy|c|h|cc|cpp|cxx|hpp|hxx|hh|cs|go|rs|rb|rake|php|phtml|swift|m|mm|lua|pl|pm|r|jl|dart|sh|bash|zsh|fish|ksh|ps1|psm1|bat|cmd|sql|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|properties|xml|html?|xhtml|svg|vue|svelte|astro|css|scss|sass|less|styl|md|markdown|mdx|txt|text|log|csv|tsv|tex|bib|proto|thrift|graphql|gql|gradle|cmake|mk|make|dockerfile|gitignore|editorconfig|lock|patch|diff|srt|vtt)$/i;

  var HL_CSS = [
    ".dsh-hl-com{color:#6b7a8d;font-style:italic}",
    ".dsh-hl-str{color:#a5e075}",
    ".dsh-hl-num{color:#f78c6c}",
    ".dsh-hl-kw{color:#c792ea;font-weight:500}",
    ".dsh-hl-typ{color:#82aaff}",
    ".dsh-hl-fn{color:#ffcb6b}",
    ".dsh-hl-var{color:#e8eef7}",
    ".dsh-hl-pun{color:#8fa0b5}",
    ".dsh-hl-tag{color:#f07178}",
    ".dsh-hl-attr{color:#ffcb6b}",
    ".dsh-hl-h{color:#82aaff;font-weight:600}",
    ".dsh-hl-b{color:#e8eef7;font-weight:600}",
    ".dsh-hl-link{color:#7fb2ff;text-decoration:underline}"
  ].join("");

  var KW_C = ("abstract as assert async await base bool break byte case catch char checked class const continue "
    + "decimal default delegate do double else enum event explicit extern false final finally fixed float for foreach "
    + "func function get global goto if implements implicit import in inline int interface internal is let lock long "
    + "match namespace new nil nullptr object operator out override package params private protected public readonly "
    + "record ref return sealed set short sizeof stackalloc static string struct switch this throw throws trait true "
    + "try type typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where while with yield "
    + "defer go map chan package range select impl fn mut pub use crate mod self super dyn move loop unsafe extern "
    + "val def end module require include extend unless elsif synchronized transient native strictfp "
    + "export from default new delete instanceof void null undefined NaN Infinity of in do while "
    + "and or not is lambda pass raise global nonlocal with as print echo fi then done esac local readonly "
    + "select insert update delete where group by having order limit join left right inner outer union "
    + "create table view index drop alter add primary key foreign references unique check").split(" ");

  var KW_PY = ("False None True and as assert async await break class continue def del elif else except finally for "
    + "from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls "
    + "print len range enumerate zip open str int float list dict set tuple type isinstance super").split(" ");

  var KW_SH = ("if then else elif fi for while until do done case esac function return in local export readonly "
    + "declare unset shift source alias echo printf cd exit set trap eval exec test sudo apt systemctl grep sed awk "
    + "cat ls cp mv rm mkdir chmod curl wget tail head sort uniq xargs find pwd pnpm npm node python python3").split(" ");

  var KW_JSON = ["true", "false", "null"];

  function kwSet(lang) {
    if (lang === "py") { return KW_PY; }
    if (lang === "sh") { return KW_SH; }
    if (lang === "json" || lang === "jsonc" || lang === "json5") { return KW_JSON; }
    return KW_C;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function langOf(p) {
    var name = String(p || "").split(/[\\/]/).pop().toLowerCase();
    if (/^(dockerfile|makefile|cmakelists\.txt|\.gitignore|\.editorconfig)$/.test(name)) { return "sh"; }
    var m = /\.([A-Za-z0-9]+)$/.exec(name);
    var e = m ? m[1].toLowerCase() : "";
    if (e === "py" || e === "pyw" || e === "pyi") { return "py"; }
    if (e === "sh" || e === "bash" || e === "zsh" || e === "fish" || e === "ksh" || e === "ps1" || e === "psm1" || e === "bat" || e === "cmd") { return "sh"; }
    if (e === "json" || e === "jsonc" || e === "json5") { return "json"; }
    if (e === "yaml" || e === "yml" || e === "toml" || e === "ini" || e === "cfg" || e === "conf" || e === "env" || e === "properties") { return "yaml"; }
    if (e === "md" || e === "markdown" || e === "mdx") { return "md"; }
    if (e === "html" || e === "htm" || e === "xhtml" || e === "xml" || e === "svg" || e === "vue" || e === "svelte" || e === "astro") { return "xml"; }
    if (e === "css" || e === "scss" || e === "sass" || e === "less" || e === "styl") { return "css"; }
    if (e === "sql") { return "sql"; }
    return "c";
  }

  function langLabel(lang) {
    return { py: "Python", sh: "Shell", json: "JSON", yaml: "YAML", md: "Markdown",
             xml: "HTML/XML", css: "CSS", sql: "SQL", c: "Code" }[lang] || lang;
  }

  /* Markdown：标题 / 围栏 / 行内码 / 粗体 / 链接 / 引用 / 列表 */
  function hlMd(src) {
    var e = escapeHtml(src);
    var out = [];
    var lines = e.split("\n");
    var fence = false;
    for (var i = 0; i < lines.length; i += 1) {
      var L = lines[i];
      if (/^\s*(```|~~~)/.test(L)) { fence = !fence; out.push('<span class="dsh-hl-com">' + L + "</span>"); continue; }
      if (fence) { out.push('<span class="dsh-hl-str">' + L + "</span>"); continue; }
      var line = L
        .replace(/^(#{1,6})(\s+.*)$/, '<span class="dsh-hl-h">$1$2</span>')
        .replace(/^(\s*&gt;\s?.*)$/, '<span class="dsh-hl-com">$1</span>')
        .replace(/`([^`]+)`/g, '<span class="dsh-hl-str">`$1`</span>')
        .replace(/(\*\*|__)(.+?)\1/g, '<span class="dsh-hl-b">$1$2$1</span>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="dsh-hl-link">[$1]($2)</span>')
        .replace(/^(\s*[-*+]\s|\s*\d+\.\s)/, '<span class="dsh-hl-kw">$1</span>');
      out.push(line);
    }
    return out.join("\n");
  }

  /* HTML/XML：注释 / 标签名 / 属性名 / 属性值 */
  function hlXml(src) {
    return escapeHtml(src)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="dsh-hl-com">$1</span>')
      .replace(/(&lt;\/?)([A-Za-z][\w:.-]*)/g, '$1<span class="dsh-hl-tag">$2</span>')
      .replace(/([A-Za-z_:][\w:.-]*)=(&quot;[^&]*?&quot;|'[^']*?')/g,
               '<span class="dsh-hl-attr">$1</span>=<span class="dsh-hl-str">$2</span>');
  }

  /* 通用 tokenizer：注释 / 字符串 / 数字 / 词 / 标点 */
  function hlGeneric(src, lang) {
    var hash = (lang === "py" || lang === "sh" || lang === "yaml" || lang === "sql" || lang === "rb" || lang === "pl" || lang === "r" || lang === "jl" || lang === "toml");
    var kws = kwSet(lang);
    var kwMap = {};
    for (var i = 0; i < kws.length; i += 1) { kwMap[kws[i]] = 1; }

    var comPat = hash ? "(#[^\\n]*)" : "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)";
    var tq1 = String.fromCharCode(34, 34, 34);
    var tq2 = String.fromCharCode(39, 39, 39);
    var re = new RegExp(
      comPat
      + "|(" + tq1 + "[\\s\\S]*?" + tq1 + "|" + tq2 + "[\\s\\S]*?" + tq2
      + "|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*')"
      + "|(`(?:\\\\.|[^`\\\\])*`)"
      + "|(\\b\\d[\\w.]*\\b)"
      + "|([A-Za-z_$@][\\w$]*)"
      + "|([^\\w\\s]+)", "g");

    var out = "", last = 0, m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) { out += escapeHtml(src.slice(last, m.index)); }
      last = m.index + m[0].length;
      var cls;
      if (m[1] !== undefined) { cls = "dsh-hl-com"; }
      else if (m[2] !== undefined || m[3] !== undefined) { cls = "dsh-hl-str"; }
      else if (m[4] !== undefined) { cls = "dsh-hl-num"; }
      else if (m[5] !== undefined) {
        var word = m[5];
        if (kwMap[word] || /^(self|this|cls)$/.test(word)) { cls = "dsh-hl-kw"; }
        else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) { cls = "dsh-hl-typ"; }
        else if (src.charAt(last) === "(") { cls = "dsh-hl-fn"; }
        else { cls = "dsh-hl-var"; }
      }
      else { cls = "dsh-hl-pun"; }
      out += '<span class="' + cls + '">' + escapeHtml(m[0]) + "</span>";
    }
    if (last < src.length) { out += escapeHtml(src.slice(last)); }
    return out;
  }

  function highlight(src, lang) {
    if (lang === "md") { return hlMd(src); }
    if (lang === "xml") { return hlXml(src); }
    return hlGeneric(src, lang);
  }

  function hlStyleOnce() {
    try {
      if (D.getElementById("dsh-hl-css")) { return; }
      var s = D.createElement("style");
      s.id = "dsh-hl-css";
      s.textContent = HL_CSS;
      (D.head || D.documentElement).appendChild(s);
    } catch (e) {}
  }

  var textEl = null, wrapOn = false;
  function ensureTextEl() {
    if (textEl && textEl.parentNode) { return textEl; }
    hlStyleOnce();
    textEl = D.createElement("pre");
    textEl.setAttribute("data-dsh-fv", "body");
    css(textEl, { flex: "1", minHeight: "0", margin: "0", overflow: "auto", background: "#0b0f14",
                  color: "#e8eef7", padding: "10px 12px calc(env(safe-area-inset-bottom,0px) + 10px)",
                  font: "12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
                  whiteSpace: "pre", tabSize: "4", WebkitOverflowScrolling: "touch",
                  WebkitTextSizeAdjust: "100%" });
    bodyEl.insertBefore(textEl, bodyEl.firstChild);
    return textEl;
  }

  /* 代码/文本：取回文本 -> 着色 -> 渲染到 <pre> */
  function showText(url) {
    var el = ensureTextEl();
    el.style.display = "block";
    el.textContent = "载入中…";
    var lang = langOf(curPath);
    try {
      titleEl.textContent = (String(curPath).split(/[\\/]/).pop() || "文件") + "  ·  " + langLabel(lang);
    } catch (e) {}
    S.opens++; S.last = curPath;
    var MAXCHARS = 400 * 1024;
    W.fetch(url, { cache: "no-store", credentials: "same-origin" }).then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.text();
    }).then(function (t) {
      var cut = t.length > MAXCHARS;
      var body = cut ? t.slice(0, MAXCHARS) : t;
      var out;
      try { out = highlight(body, lang); } catch (e) { out = escapeHtml(body); logErr("highlight", e); }
      el.innerHTML = out + (cut ? "\n\n" + '<span class="dsh-hl-com">… 文件较大，只显示前 400 KB</span>' : "");
      el.scrollTop = 0;
    }).catch(function (e) {
      setStatus("打不开这个文件 · " + curPath + "（" + (e && e.message ? e.message : e) + "）");
    });
  }

  function toggleWrap() {
    try {
      wrapOn = !wrapOn;
      if (!textEl) { return; }
      textEl.style.whiteSpace = wrapOn ? "pre-wrap" : "pre";
      textEl.style.wordBreak = wrapOn ? "break-word" : "normal";
    } catch (e) { logErr("toggleWrap", e); }
  }

  function css(el, o) { for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { el.style[k] = o[k]; } } }

  function build() {
    if (root) { return root; }
    root = D.createElement("div");
    root.id = "dsh-fv";
    root.setAttribute("data-dsh-fileview", "1");
    root.style.cssText = [
      "position:fixed", "left:0", "right:0", "top:0", "bottom:0", "z-index:2147483000",
      "background:#0b0f14", "color:#e8eef7", "display:none", "flex-direction:column",
      "font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',system-ui,sans-serif",
      "-webkit-tap-highlight-color:transparent"
    ].join(";");

    var head = D.createElement("div");
    css(head, {
      flex: "0 0 auto", display: "flex", alignItems: "center", gap: "8px",
      padding: "calc(env(safe-area-inset-top,0px) + 8px) 10px 8px",
      background: "#111823", borderBottom: "1px solid #1e2836"
    });
    var close = D.createElement("button");
    close.type = "button"; close.setAttribute("aria-label", "关闭");
    close.textContent = "✕";
    css(close, { background: "#1b2634", color: "#e8eef7", border: "1px solid #1e2836",
                 borderRadius: "10px", minWidth: "40px", minHeight: "38px", fontSize: "16px" });
    close.onclick = hide;
    titleEl = D.createElement("div");
    css(titleEl, { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis",
                   whiteSpace: "nowrap", fontWeight: "600" });
    var reload = D.createElement("button");
    reload.type = "button"; reload.setAttribute("aria-label", "重新加载");
    reload.textContent = "⟳";
    css(reload, { background: "#1b2634", color: "#e8eef7", border: "1px solid #1e2836",
                  borderRadius: "10px", minWidth: "40px", minHeight: "38px", fontSize: "16px" });
    reload.onclick = function () { if (frameEl) { frameEl.src = "about:blank"; frameEl.src = curUrl; } };
    head.appendChild(close); head.appendChild(titleEl); head.appendChild(reload);

    statusEl = D.createElement("div");
    css(statusEl, { flex: "1", display: "flex", alignItems: "center", justifyContent: "center",
                    padding: "18px", color: "#8fa0b5", textAlign: "center", wordBreak: "break-all" });
    bodyEl = D.createElement("div");
    css(bodyEl, { position: "relative", flex: "1", minHeight: "0", display: "flex",
                  flexDirection: "column" });
    bodyEl.appendChild(statusEl);

    var foot = D.createElement("div");
    css(foot, { flex: "0 0 auto", display: "flex", alignItems: "center", gap: "8px",
                padding: "6px 10px calc(env(safe-area-inset-bottom,0px) + 8px)",
                background: "#111823", borderTop: "1px solid #1e2836" });
    pathEl = D.createElement("div");
    css(pathEl, { flex: "1", minWidth: "0", fontSize: "11px", color: "#5d6b7d",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl" });
    var dl = D.createElement("a");
    dl.textContent = "下载"; dl.setAttribute("data-dsh-fv", "dl");
    css(dl, { color: "#7fb2ff", fontSize: "13px", textDecoration: "none", padding: "6px 4px" });
    var br = D.createElement("a");
    br.textContent = "新窗口"; br.target = "_blank"; br.rel = "noopener";
    br.setAttribute("data-dsh-fv", "new");
    css(br, { color: "#7fb2ff", fontSize: "13px", textDecoration: "none", padding: "6px 4px" });
    var ext = D.createElement("a");
    ext.textContent = "用手机应用打开"; ext.href = "javascript:void(0)";
    ext.setAttribute("data-dsh-fv", "ext");
    css(ext, { color: "#7fb2ff", fontSize: "13px", textDecoration: "none", padding: "6px 4px" });
    ext.onclick = function () {
      try { openWithNative(curPath); } catch (e) { logErr("openWithBtn", e); }
    };
    var wrapBtn = D.createElement("a");
    wrapBtn.textContent = "换行"; wrapBtn.href = "javascript:void(0)";
    wrapBtn.setAttribute("data-dsh-fv", "wrap");
    css(wrapBtn, { color: "#7fb2ff", fontSize: "13px", textDecoration: "none", padding: "6px 4px" });
    wrapBtn.onclick = function () { toggleWrap(); };
    foot.appendChild(pathEl); foot.appendChild(dl); foot.appendChild(ext); foot.appendChild(wrapBtn); foot.appendChild(br);

    root.appendChild(head); root.appendChild(bodyEl); root.appendChild(foot);
    (D.body || D.documentElement).appendChild(root);
    return root;
  }

  function setStatus(text) {
    build();
    if (frameEl) { frameEl.style.display = "none"; }
    if (textEl) { textEl.style.display = "none"; }
    statusEl.style.display = "flex";
    statusEl.textContent = text;
  }

  function show(path, mode, label) {
    var url = urlFor(path, mode || "f");
    build();
    curUrl = url; curPath = String(path);
    isImg = IMG.test(curPath); isPdf = PDF.test(curPath);
    isText = !isImg && !isPdf && CODE_RE.test(curPath);
    titleEl.textContent = label || String(path).split(/[\\/]/).pop() || "文件";
    pathEl.textContent = curPath;
    root.querySelectorAll("[data-dsh-fv]").forEach(function (a) {
      if (a.getAttribute("data-dsh-fv") === "dl") { a.href = urlFor(path, "dl"); }
      if (a.getAttribute("data-dsh-fv") === "new") { a.href = url; }
    });
    root.style.display = "flex";

    try {
      if (isText) {
        /* 文本/代码：只走文本层并**立即返回** —— 绝不能落到下面那段公共尾巴，
           否则会把 .py 的 URL 塞给上一次残留的 <img>，解码失败报"打不开这个图片"盖住代码。 */
        if (frameEl) { frameEl.style.display = "none"; }
        statusEl.style.display = "none";
        root.style.display = "flex";
        showText(url);
        return true;
      }
      if (isImg) {
        if (!frameEl || frameEl.tagName !== "IMG") {
          if (frameEl && frameEl.parentNode) { frameEl.parentNode.removeChild(frameEl); }
          frameEl = D.createElement("img");
          frameEl.setAttribute("data-dsh-fv", "body");
          css(frameEl, { flex: "1", minHeight: "0", width: "100%", objectFit: "contain",
                         background: "#0b0f14", display: "block" });
          bodyEl.insertBefore(frameEl, bodyEl.firstChild);
          frameEl.onerror = function () { setStatus("打不开这个图片（可能不在允许的目录里）· " + curPath); };
        }
      } else {
        if (!frameEl || frameEl.tagName !== "IFRAME") {
          if (frameEl && frameEl.parentNode) { frameEl.parentNode.removeChild(frameEl); }
          frameEl = D.createElement("iframe");
          frameEl.setAttribute("data-dsh-fv", "body");
          frameEl.setAttribute("sandbox", "allow-same-origin");
          css(frameEl, { flex: "1", minHeight: "0", width: "100%", border: "0",
                         background: "#0b0f14", display: "block" });
          bodyEl.insertBefore(frameEl, bodyEl.firstChild);
        }
      }
      if (textEl) { textEl.style.display = "none"; }
      frameEl.style.display = "block";
      statusEl.style.display = "none";
      frameEl.src = url;
      S.opens++; S.last = curPath;
      return true;
    } catch (e) {
      logErr("show", e);
      return false;
    }
  }

  function hide() {
    if (!root) { return; }
    root.style.display = "none";
    if (frameEl) {
      try { frameEl.src = "about:blank"; } catch (_) {}
    }
  }

  function visible() { return !!(root && root.style.display === "flex"); }

  /* 打开一个路径（含目录）。失败返回 false，由调用方回落。 */
  function openPath(path, opts) {
    opts = opts || {};
    if (!S.on) { return false; }
    var p = String(path == null ? "" : path);
    if (!p) { return false; }
    var looksDir = opts.dir === true || isDirPath(p) || (!/\.[A-Za-z0-9]{1,8}$/.test(p) && !opts.file);
    try {
      return show(p, looksDir ? "d" : "f", opts.label);
    } catch (e) {
      logErr("openPath", e);
      S.fallbacks++;
      return false;
    }
  }

  /* 硬件返回键：弹层开着就先关弹层（接在原有处理之后） */
  var prevBack = W.__dshNativeBack;
  W.__dshNativeBack = function () {
    try { if (visible()) { hide(); return true; } } catch (_) {}
    try { return typeof prevBack === "function" ? prevBack.apply(this, arguments) : false; }
    catch (_) { return false; }
  };

  /* 桌面 Esc 关闭（手机用返回键；桌面浏览器调试时方便） */
  try {
    D.addEventListener("keydown", function (e) {
      if (e && e.key === "Escape" && visible()) { hide(); }
    }, true);
  } catch (_) {}

  /* =======================  链路 1/2：fetch 接管  ======================= */
  function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "content-type": "application/json" }
    });
  }

  function rpcOk(rpcId, value) {
    return { type: "server-response", rpcId: rpcId, result: { ok: true, value: value } };
  }

  var RPC_OPEN = /^\/api\/session\/openWorkspacePath$/;
  var RPC_APPS = /^\/api\/session\/workspacePathApplications$/;
  var RPC_CAN = /^\/api\/session\/canOpenWorkspacePath$/;
  var OIA_OPEN = /^\/open-in-app\/open$/;
  var OIA_APPS = /^\/open-in-app\/apps$/;

  function normalize(u) {
    try {
      return new URL(String(u), location.href).pathname;
    } catch (e) {
      return String(u || "").split("?")[0];
    }
  }

  function reqBody(init) {
    try {
      if (init && typeof init.body === "string") { return JSON.parse(init.body); }
    } catch (_) {}
    return null;
  }

  /* ★ 图片/文本一律页面内预览 —— 手机点图不该被丢给第三方应用（真机反馈）。
     只有 pdf/office/压缩包/二进制这类"页面里看不了"的才交给手机上的 App。
     预览层底部另有"用手机应用打开"按钮，随时可以改走外部应用。 */
  var INLINE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg|md|markdown|txt|log|json|ya?ml|toml|ini|cfg|conf|csv|tsv|py|js|mjs|cjs|jsx|ts|tsx|java|kt|c|h|cpp|hpp|cs|go|rs|rb|php|sh|bash|ps1|bat|cmd|sql|html?|xhtml|css|scss|less|xml)$/i;
  function preferPreview(p) { return INLINE_RE.test(String(p || "")); }

  /* ★ 交给"手机上的第三方 App"：原生桥 openwith 把文件下载到手机缓存，
     再弹 Android 的 ACTION_VIEW 选择器（用户自己挑 App）。
     失败时（旧版 APK 没这个方法 / 桌面浏览器没桥）由调用方退回页面内预览。 */
  function openWithNative(path) {
    if (!(W.__dshHot && typeof W.__dshHot.call === "function")) {
      return Promise.reject(new Error("no-native-bridge"));
    }
    var dl = "/dl?path=" + enc(path) + "&k=" + enc(key());
    var name = String(path || "").split(/[\\/]/).pop() || "file";
    try { if (W.console && console.log) { console.log("[dsh-fileview] openWith -> " + name); } } catch (e0) {}
    return W.__dshHot.call("openwith", { url: dl, name: name });
  }

  function installFetchHook() {
    if (!W.fetch || W.fetch.__dshFileViewHook) { return; }
    var orig = W.fetch;
    function wrapped(input, init) {
      try {
        if (!S.on) { return orig.apply(this, arguments); }
        var p = normalize(typeof input === "string" ? input : (input && input.url) || "");
        // --- 打开文件/在工作区打开：接管 ---
        if (RPC_OPEN.test(p)) {
          var msg = reqBody(init) || {};
          var args = (msg.payload && msg.payload.args) || {};
          // 线上传参形态可能是 {args:{request:{...}}} 或 {args:{_request:{...}}}
          var req = args.request || args._request || args;
          var path = req && (req.path || req.absolutePath);
          if (path) {
            S.taken++;
            var respOpen = Promise.resolve(jsonResponse(rpcOk(msg.rpcId, { opened: true })));
            if (preferPreview(path)) {
              // 图片/文本：就地预览（点图即看，不跳应用、不等下载）
              try { openPath(path, { file: true }); } catch (e) { logErr("openPreview", e); }
            } else {
              // 其它类型：交给手机上的第三方 App；没有原生桥再退回预览
              openWithNative(path).then(null, function () {
                try { openPath(path, { file: true }); } catch (e) { logErr("openWithFallback", e); }
              });
            }
            return respOpen;
          }
          S.fallbacks++;
          return orig.apply(this, arguments);
        }
        if (OIA_OPEN.test(p)) {
          var m2 = reqBody(init) || {};
          if (m2.path && !isDirPath(m2.path)) {
            S.taken++;
            var respOia = Promise.resolve(jsonResponse({ opened: true, handledBy: "phone" }));
            if (preferPreview(m2.path)) {
              try { openPath(m2.path, { file: true }); } catch (e) { logErr("openPreview2", e); }
            } else {
              openWithNative(m2.path).then(null, function () {
                try { openPath(m2.path, { file: true }); } catch (e) { logErr("openWithFallback2", e); }
              });
            }
            return respOia;
          }
          if (m2.path && openPath(m2.path, { dir: true })) {
            S.taken++;
            return Promise.resolve(jsonResponse({ opened: true, handledBy: "phone" }));
          }
          S.fallbacks++;
          return orig.apply(this, arguments);
        }
        // --- 让 UI 相信"本机可打开"，并只列出一个本机条目 ---
        if (RPC_APPS.test(p)) {
          var m3 = reqBody(init) || {};
          return Promise.resolve(jsonResponse(rpcOk(m3.rpcId, [{
            id: "phone", name: "本机（手机内查看）", path: "phone", default: true
          }])));
        }
        if (OIA_APPS.test(p)) {
          return Promise.resolve(jsonResponse({ apps: ["phone"] }));
        }
        if (RPC_CAN.test(p)) {
          var m4 = reqBody(init) || {};
          return Promise.resolve(jsonResponse(rpcOk(m4.rpcId, true)));
        }
      } catch (e) {
        logErr("fetch-hook", e);
        S.fallbacks++;
      }
      return orig.apply(this, arguments);
    }
    wrapped.__dshFileViewHook = 1;
    W.fetch = wrapped;
  }

  /* deep-link：file:///D:/... 之类一律改成本机查看 */
  try {
    D.addEventListener("click", function (ev) {
      try {
        var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
        if (!a) { return; }
        var href = a.getAttribute("href") || "";
        var m = /^file:\/{2,3}(.+)$/i.exec(href);
        if (!m) { return; }
        var p = decodeURIComponent(m[1]);
        if (!/^[A-Za-z]:/.test(p)) { p = "/" + p; }
        if (openPath(p, {})) { ev.preventDefault(); ev.stopPropagation(); }
      } catch (e) { logErr("file-link", e); }
    }, true);
  } catch (_) {}

  installFetchHook();
  if (!W.fetch || !W.fetch.__dshFileViewHook) { logErr("install", "fetch hook not installed"); }

  W.__dshOpenFile = function (path, opts) {
    if (!openPath(path, opts)) {
      // 回落：直接开代理地址（拿不到就交给原来的行为）
      try { W.open(urlFor(path, (opts && opts.mode) || "f"), "_blank"); return true; }
      catch (e) { logErr("openFile-fallback", e); return false; }
    }
    return true;
  };
  W.__dshFileView = {
    version: "2026-10-04.1",
    mobile: isMobile(),
    on: function () { return S.on; },
    enable: function () { S.on = true; },
    disable: function () { S.on = false; },
    open: function (path, opts) { return openPath(path, opts); },
    close: hide,
    visible: visible,
    url: urlFor,
    browse: function (dir) { return openPath(dir || "", { dir: true }); },
    state: function () {
      return { version: "2026-10-04.1", on: S.on, mobile: isMobile(), taken: S.taken,
               opens: S.opens, fallbacks: S.fallbacks, last: S.last,
               errors: S.errors.length, hook: !!(W.fetch && W.fetch.__dshFileViewHook),
               key: key() ? "yes" : "no" };
    }
  };
  try { console.log("[dsh-hot] fileview ready " + JSON.stringify(W.__dshFileView.state())); } catch (_) {}
})();
