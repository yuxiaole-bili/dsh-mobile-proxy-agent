
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
