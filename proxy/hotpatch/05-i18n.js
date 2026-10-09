/* 05-i18n.js —— 客户端多语言（中文 / English）
 *
 * 为什么需要：DSH 自己是多语言的，但我注入的按钮、文件预览层等文案原先写死中文。
 * 语言判定顺序（可用 ?lang=zh / ?lang=en 强制并记忆）：
 *   1) URL 参数 ?lang=     2) localStorage['dsh-ui-lang']
 *   3) <html lang>（DSH 当前语言，实测为 en/zh-CN）   4) navigator.language
 *
 * 翻译方式：
 *   · 代码里用 __dshI18n.pick('中文','English') 生成文案
 *   · 已经渲染出来的节点，由 translateTree() 按词典翻译 —— 但**只处理我自己的 UI**
 *     （#dsh-fv 预览层 / [data-dsh-uix] 注入元素 / [data-dsh-i18n] 显式标记），
 *     app 自身的文案一个字都不动。
 */
(function () {
  var W = window, D = document;
  if (W.__dshI18n) { return; }
  var LS = 'dsh-ui-lang';

  function fromQuery() {
    try {
      var m = /[?&]lang=(zh|en)\b/i.exec(location.search);
      return m ? m[1].toLowerCase() : null;
    } catch (e) { return null; }
  }
  function detect() {
    var q = fromQuery();
    if (q) { try { localStorage.setItem(LS, q); } catch (e) {} return q; }
    try { var l = localStorage.getItem(LS); if (l === 'zh' || l === 'en') { return l; } } catch (e) {}
    var hl = (D.documentElement.getAttribute('lang') || '').toLowerCase();
    if (hl.indexOf('zh') === 0) { return 'zh'; }
    if (hl.indexOf('en') === 0) { return 'en'; }
    var nl = (navigator.language || '').toLowerCase();
    if (nl.indexOf('zh') === 0) { return 'zh'; }
    return nl ? 'en' : 'zh';
  }

  var cur = detect();

  /* 词典：只覆盖"我自己的 UI"出现的文案 */
  var DICT = {
    '关闭': 'Close',
    '收起': 'Collapse',
    '展开': 'Expand',
    '返回': 'Back',
    '重新加载': 'Reload',
    '下载': 'Download',
    '新窗口': 'New window',
    '换行': 'Wrap',
    '用手机应用打开': 'Open in app',
    '在应用中打开': 'Open in app',
    '在应用中打开 / Open in app': 'Open in app',
    '就地看文件': 'Preview in place',
    '本机': 'Local',
    '电脑打开': 'Open on computer',
    '打开文件/在工作区打开': 'Open file / reveal in workspace',
    '打开文件/显示文件位置': 'Open file / show location',
    '载入中…': 'Loading…',
    '文件': 'File',
    '打不开这个文件': "Can't open this file",
    '打不开这个图片': "Can't open this image",
    '文件较大，只显示前 400 KB': 'Large file — showing the first 400 KB',
    '展开底部用量': 'Expand usage',
    '收起底部用量': 'Collapse usage',
    '关闭面板': 'Close panel',
    '关闭上下文': 'Close context panel'
  };

  function pick(zh, en) { return cur === 'en' ? (en || zh) : zh; }

  function mine(e) {
    return !!(e.closest && e.closest('#dsh-fv,[data-dsh-uix],[data-dsh-i18n]'));
  }

  function translateTree(root) {
    try {
      if (cur !== 'en' || !root || !root.querySelectorAll) { return 0; }
      var n = 0, walker = D.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var t;
      while ((t = walker.nextNode())) {
        var p = t.parentElement;
        if (!p || !mine(p)) { continue; }
        var key = (t.nodeValue || '').trim();
        if (DICT[key]) { t.nodeValue = t.nodeValue.replace(key, DICT[key]); n += 1; }
      }
      var all = root.querySelectorAll('[data-dsh-i18n],[title],[aria-label],#dsh-fv button,#dsh-fv span,#dsh-fv div');
      for (var i = 0; i < all.length; i += 1) {
        var e = all[i];
        if (!mine(e)) { continue; }
        for (var a = 0; a < 2; a += 1) {
          var attr = a === 0 ? 'title' : 'aria-label';
          var v = e.getAttribute && e.getAttribute(attr);
          if (v && DICT[v.trim()]) { e.setAttribute(attr, DICT[v.trim()]); n += 1; }
        }
      }
      return n;
    } catch (e) { return 0; }
  }

  var subs = [];
  function fire() {
    for (var i = 0; i < subs.length; i += 1) { try { subs[i](cur); } catch (e) {} }
    translateTree(D.body);
  }

  W.__dshI18n = {
    get lang() { return cur; },
    pick: pick,
    t: pick,
    translateTree: translateTree,
    onChange: function (fn) { subs.push(fn); try { fn(cur); } catch (e) {} },
    setLang: function (l) {
      cur = (String(l).toLowerCase() === 'en') ? 'en' : 'zh';
      try { localStorage.setItem(LS, cur); } catch (e) {}
      fire();
      return cur;
    }
  };

  /* 语言跟着 app 变：轮询 <html lang> + ?lang=，另监听我自己的 UI 插入 */
  try {
    var lastLang = D.documentElement.getAttribute('lang');
    setInterval(function () {
      var q = fromQuery();
      if (q && q !== cur) { cur = q; fire(); return; }
      var now = D.documentElement.getAttribute('lang');
      if (now !== lastLang) {
        lastLang = now;
        var d = detect();
        if (d !== cur) { cur = d; fire(); }
      }
    }, 1500);
    if (W.MutationObserver && D.body) {
      var mo = new MutationObserver(function (muts) {
        if (cur !== 'en') { return; }
        for (var i = 0; i < muts.length; i += 1) {
          var nodes = muts[i].addedNodes;
          for (var j = 0; j < nodes.length; j += 1) {
            var nd = nodes[j];
            if (nd.nodeType === 1) { translateTree(nd); }
          }
        }
      });
      mo.observe(D.body, { childList: true, subtree: true });
    }
  } catch (e) {}
})();
