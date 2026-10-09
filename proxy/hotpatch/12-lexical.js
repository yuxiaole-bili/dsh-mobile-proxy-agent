/* 12-lexical.js —— 粘贴长文本：走 Lexical 自己的模型写入
 *
 * 背景（2026-10-09 实测）：
 *   · DSH 的输入框是 **Lexical** 富文本编辑器（ComposerContentEditable + setRootElement）
 *   · 编辑器会把"外部 DOM 写入"当作脏数据**回滚** → 这就是粘贴长文本被吞 / 程序化写入
 *     到 448 字就停的原因
 *   · 编辑器实例可以从页面直接拿到：el.__lexicalEditor（含 _nodes / _editorState / update）
 *
 * 做法：拦截粘贴 → 用 editor.update() 在 Lexical 自己的模型里建节点
 *       → 不受 DOM 回滚影响，一次性写入上千字也没问题
 *
 * 只在输入框为空且内容 ≥ MIN 字时接管；小粘贴、非空输入框都不干预。
 * 开关：?no-lexpaste=1 关 · ?no-lexpaste=0 开 · localStorage['dsh-lexpaste']
 */
(function () {
  var W = window, D = document;
  if (W.__dshLexPaste) { return; }

  var LS = 'dsh-lexpaste';
  var MIN_TAKEOVER = 200;      // 少于这个字数不接管（小粘贴走原生）
  var MAX_LINES = 400;         // 防御：超多行时按单段写入，避免建几千个节点

  function T(zh, en) { return W.__dshI18n ? W.__dshI18n.pick(zh, en) : zh; }

  function on() {
    try {
      if (/[?&]no-lexpaste=1\b/.test(location.search)) { return false; }
      if (/[?&]no-lexpaste=0\b/.test(location.search)) { localStorage.setItem(LS, '1'); return true; }
      var v = localStorage.getItem(LS);
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  }

  var LOG = [];
  function log(x) { LOG.push(String(x)); if (LOG.length > 30) { LOG.shift(); } }

  function composerEl() { return D.querySelector('[data-composer-input]'); }
  function editorOf(el) { return el && el.__lexicalEditor ? el.__lexicalEditor : null; }
  function domText(el) { return el ? (el.textContent || '') : ''; }

  /* 从 _nodes 里按类型名取节点类（不用 import Lexical 的 $ 函数） */
  function nodeClass(ed, names) {
    for (var i = 0; i < names.length; i += 1) {
      var c = ed._nodes.get(names[i]);
      if (c) { var K = c.klass || c.$ || c; if (typeof K === 'function') { return K; } }  /* Lexical: {klass, config, replace} */
    }
    /* 兜底：从当前状态里已有节点的 constructor 取 */
    try {
      var want = names[0].toLowerCase();
      var got = null;
      ed._editorState._nodeMap.forEach(function (n) {
        if (got) { return; }
        try { if (n.getType && n.getType().toLowerCase() === want) { got = n.constructor; } } catch (e) {}
      });
      if (got) { log('via-ctor:' + want); return got; }
      var keys = [];
      ed._nodes.forEach(function (v, k) { keys.push(k); });
      log('nodes:' + keys.slice(0, 12).join(','));
    } catch (e) { log('fallback-err'); }
    return null;
  }

  function writeViaLexical(ed, text) {
    var P = nodeClass(ed, ['paragraph', 'ParagraphNode']);
    var Tx = nodeClass(ed, ['text', 'TextNode']);
    if (!P || !Tx) { log('no-node-class'); return false; }
    var lines = String(text).split('\n');
    if (lines.length > MAX_LINES) { lines = [String(text)]; }
    try {
      ed.update(function () {
        var st = ed._pendingEditorState || ed._editorState;
        var root = st._nodeMap.get('root');
        if (!root) { return; }
        for (var i = 0; i < lines.length; i += 1) {
          var p = new P();
          if (lines[i].length) { p.append(new Tx(lines[i])); }
          root.append(p);
        }
        try { root.selectEnd(); } catch (e) {}
      }, { tag: 'dsh-paste' });
      return true;
    } catch (e) { log('update-err:' + (e && e.message)); return false; }
  }

  function toast(msg, bad) {
    try {
      var old = D.querySelector('[data-dsh-uix="paste-toast"]');
      if (old && old.parentNode) { old.parentNode.removeChild(old); }
      var d = D.createElement('div');
      d.setAttribute('data-dsh-uix', 'paste-toast');
      d.setAttribute('data-dsh-i18n', '1');
      d.textContent = msg;
      d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:104px;z-index:995;'
        + 'background:' + (bad ? 'rgba(122,34,34,.96)' : 'rgba(28,29,34,.96)') + ';color:#fbf7ff;'
        + 'padding:9px 13px;border-radius:10px;font-size:13px;max-width:86vw;text-align:center;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.5);';
      D.body.appendChild(d);
      setTimeout(function () { if (d.parentNode) { d.parentNode.removeChild(d); } }, 2200);
    } catch (e) {}
  }

  var ACTIVE = on();

  D.addEventListener('paste', function (e) {
    try {
      if (!ACTIVE) { return; }
      var el = composerEl();
      var ed = editorOf(el);
      if (!el || !ed) { log('no-editor'); return; }
      var cd = e.clipboardData || W.clipboardData;
      var txt = cd ? (cd.getData('text/plain') || cd.getData('text') || '') : '';
      log('paste:' + (txt ? txt.length : 'empty'));
      if (!txt) { return; }
      if (txt.length < MIN_TAKEOVER) { return; }
      if (domText(el).trim() !== '') { log('skip:not-empty'); return; }
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
      log('takeover:' + txt.length);
      var ok = writeViaLexical(ed, txt);
      /* 校验：DOM 里应出现目标文本 */
      setTimeout(function () {
        var got = domText(el).replace(/\u200b/g, '').length;
        log('after:' + got + '/' + txt.length);
        if (got >= txt.length - 2) { toast(T('已粘贴 ' + txt.length + ' 字', 'Pasted ' + txt.length + ' chars')); }
        else { toast(T('粘贴不完整：' + got + '/' + txt.length, 'Paste incomplete: ' + got + '/' + txt.length), true); }
      }, 400);
      W.__dshLexPaste.last = { ok: ok, len: txt.length };
    } catch (err) { log('err:' + (err && err.message)); }
  }, true);

  if (/[?&]pastetest=1\b/.test(location.search)) {
    setInterval(function () {
      var d = D.querySelector('[data-dsh-uix="paste-diag"]');
      if (!d) {
        d = D.createElement('pre');
        d.setAttribute('data-dsh-uix', 'paste-diag');
        d.style.cssText = 'position:fixed;left:6px;right:6px;bottom:150px;z-index:996;max-height:34vh;overflow:auto;'
          + 'background:rgba(0,0,0,.86);color:#9ef;font:11px/1.5 monospace;padding:8px;border-radius:8px;white-space:pre-wrap;';
        D.body.appendChild(d);
      }
      var el = composerEl();
      var ed = editorOf(el);
      d.textContent = 'lex-paste v1  active=' + ACTIVE + '\n'
        + 'composer=' + (el ? 'yes' : 'no') + '  lexical=' + (ed ? 'yes' : 'no')
        + '  len=' + domText(el).length + '\nlog:\n' + LOG.slice(-12).join('\n');
    }, 700);
  }

  W.__dshLexPaste = {
    version: 1,
    enabled: ACTIVE,
    log: LOG,
    composerEl: composerEl,
    editorOf: editorOf,
    writeViaLexical: writeViaLexical,
    disable: function () { try { localStorage.setItem(LS, '0'); } catch (e) {} ACTIVE = false; }
  };
})();
