/* 80-paste.js —— 大段粘贴折叠（像 Claude Code 那样）
 *
 * 阈值：100 字 或 6 行 —— 超过就折叠成
 *   ⟦ 已粘贴 12 行 / 480 字 · 点击展开 ⟧
 * 点标记 → 就地展开；发送前 → 自动还原成全文。
 *
 * 保命逻辑（关键）：发送时若还检测到标记，先尝试还原；还原不成功就
 *   **拦下这次发送**并提示，绝不让模型收到 `⟦…⟧`。
 *
 * 开关：?no-pastefold=1 关闭 · ?no-pastefold=0 开启 · localStorage['dsh-pastefold']
 */
(function () {
  var W = window, D = document;
  if (W.__dshPaste && W.__dshPaste.enabled) { return; }

  var LS = 'dsh-pastefold';
  var MIN_CHARS = 100;
  var MIN_LINES = 6;

  function T(zh, en) { return W.__dshI18n ? W.__dshI18n.pick(zh, en) : zh; }

  function enabled() {
    try {
      if (/[?&]no-pastefold=1\b/.test(location.search)) { return false; }
      if (/[?&]no-pastefold=0\b/.test(location.search)) { localStorage.setItem(LS, '1'); return true; }
      var v = localStorage.getItem(LS);
      return v === '1';                                /* 默认关闭：折叠是可选项 */
    } catch (e) { return true; }
  }
  var FOLD = enabled();

  /* 分块写入：实测把一段长文本一次性塞进编辑器会被丢弃（这就是"粘贴吞字"的根因），
     拆成 ~150 字一块、间隔 40ms 就能完整写进去。 */
  function insertTextChunked(text, done) {
    var full = String(text);
    var base = null, rounds = 0;
    (function step() {
      var ed = editor();
      if (!ed) { if (done) { done(false); } return; }
      if (base === null) { base = val(ed).length; }
      var cur = val(ed);
      var tail = cur.slice(base);
      /* 已落地的长度 = 值尾部与目标前缀的最长重合（自愈：被丢弃的块会被补回来） */
      var written = 0;
      var max = Math.min(tail.length, full.length);
      for (var L = max; L > 0; L -= 1) {
        if (tail.slice(tail.length - L) === full.slice(0, L)) { written = L; break; }
      }
      if (written >= full.length) {
        log('chunk-ok:' + written + '/' + full.length);
        if (done) { done(true); }
        return;
      }
      rounds += 1;
      if (rounds > 60) { log('chunk-give-up:' + written + '/' + full.length); if (done) { done(false); } return; }
      var part = full.slice(written, written + 150);
      try { ed.focus(); } catch (e) {}
      var before = val(ed);
      try { D.execCommand('insertText', false, part); } catch (e) {}
      if (val(ed) === before) {
        /* 编辑器这次没吃下去 → 换 insertHTML 再试，仍不行就整体 setVal 兜底 */
        try { D.execCommand('insertHTML', false, part.replace(/[<>&]/g, '')); } catch (e) {}
        if (val(ed) === before) { setVal(ed, before + part); }
      }
      setTimeout(step, 70);
    })();
  }

  /* ① 拦截大段粘贴 */
  D.addEventListener('paste', function (e) {
    try {
      var ed = editor();
      log('paste-target:' + String(e.target && e.target.className || e.target && e.target.tagName || '?').slice(0, 18));
      if (!isEd(ed, e.target)) { log('reject:no-editor'); return; }
      var cd = e.clipboardData || W.clipboardData;
      var txt = cd ? (cd.getData('text/plain') || cd.getData('text') || '') : '';
      function handle(t) {
        if (!t) { return; }
        if (FOLD) {
          if (t.length < MIN_CHARS && t.split('\n').length < MIN_LINES) { insertTextChunked(t); return; }
          seq += 1;
          var id = 'p' + seq, mark = label(t);
          store[id] = { text: t, mark: mark };
          log('fold:' + t.length);
          insert(mark);
        } else {
          log('chunk-paste:' + t.length);
          insertTextChunked(t);
        }
      }
      if (txt) {
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
        log('paste:' + txt.length);
        handle(txt);
        return;
      }
      /* 键盘/系统粘贴有时拿不到 clipboardData → 读剪贴板兜底 */
      log('paste:empty');
      if (W.navigator && navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) {
          if (!t) { return; }
          if (t.length < MIN_CHARS && t.split('\n').length < MIN_LINES) { return; }
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
          log('clip:' + t.length);
          handle(t);
        }).catch(function (err) { log('clip-err'); });
      }
    } catch (err) {}
  }, true);

  /* ② 点击标记 → 就地展开 */
  D.addEventListener('click', function (e) {
    try {
      var ed = editor();
      if (!isEd(ed, e.target)) { return; }
      setTimeout(function () {
        var s = val(ed);
        var pos = (ed.selectionStart !== undefined && ed.selectionStart !== null) ? ed.selectionStart : -1;
        for (var id in store) {
          var it = store[id];
          if (!it.mark) { continue; }
          var i = s.indexOf(it.mark);
          if (i < 0) { continue; }
          if (pos > 0 && (pos < i || pos > i + it.mark.length)) { continue; }
          var mark = it.mark, text = it.text, n = 0;
          it.mark = null;
          (function tryExpand() {
            if (!replaceInEditor(ed, mark, text) && n < 8) { n += 1; setTimeout(tryExpand, 160); }
          })();
          return;
        }
      }, 0);
    } catch (err) {}
  }, true);

  /* ③ 发送前还原；还原不成就拦下这次发送 */
  function pending() {
    var ed = editor();
    if (!ed) { return { ed: null, marks: [] }; }
    var s = val(ed), out = [];
    for (var id in store) { var it = store[id]; if (it.mark && s.indexOf(it.mark) >= 0) { out.push(it); } }
    return { ed: ed, marks: out };
  }
  function restoreAll() {
    var p = pending();
    if (!p.ed || !p.marks.length) { return true; }
    for (var i = 0; i < p.marks.length; i += 1) {
      var it = p.marks[i];
      if (replaceInEditor(p.ed, it.mark, it.text)) { it.mark = null; }
    }
    var again = pending();
    if (again.marks.length && again.ed) {                 /* 第二轮：内容可能刚被回滚 */
      var ed2 = again.ed;
      var txt = val(ed2);
      for (var j = 0; j < again.marks.length; j += 1) { txt = txt.split(again.marks[j].mark).join(again.marks[j].text); }
      setAll(ed2, txt, 10);
      if (pending().marks.length === 0) { return true; }
    }
    return pending().marks.length === 0;
  }
  function toast(msg) {
    var old = D.querySelector('[data-dsh-uix="paste-toast"]');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var d = D.createElement('div');
    d.setAttribute('data-dsh-uix', 'paste-toast');
    d.setAttribute('data-dsh-i18n', '1');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:995;'
      + 'background:rgba(28,29,34,.96);color:#fbf7ff;padding:10px 14px;border-radius:10px;font-size:13px;'
      + 'box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:86vw;text-align:center;';
    D.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) { d.parentNode.removeChild(d); } }, 2600);
  }
  function guardSend(e, announce) {
    if (!pending().marks.length) { return true; }
    var ok = restoreAll();
    if (!ok) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
      toast(T('正在还原粘贴内容，请再按一次发送', 'Restoring pasted text — press send again'));
      return false;
    }
    if (announce) { toast(T('已还原粘贴内容', 'Pasted text restored')); }
    return true;
  }
  D.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { guardSend(e); }
  }, true);
  D.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button,[role="button"]') : null;
    if (!b) { return; }
    var s = ((b.getAttribute('aria-label') || '') + (b.textContent || '')).trim();
    if (/发送|Send|Submit/i.test(s)) { guardSend(e); }
  }, true);
  D.addEventListener('submit', function (e) { guardSend(e); }, true);

  /* ?pastetest=1：屏幕上显示最近事件，便于真机截图排查 */
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
      var ed = editor();
      d.textContent = 'paste-fold v3\nth=' + MIN_CHARS + 'c/' + MIN_LINES + 'L  pending=' + pendingIns.length
        + '\neditor=' + (ed ? (ed.tagName + '.' + String(ed.className || '').slice(0, 18)) : 'none')
        + '  len=' + (ed ? val(ed).length : -1)
        + '\nlog:\n' + LOG.slice(-14).join('\n');
    }, 700);
  }

  W.__dshPaste = {
    enabled: true,
    log: LOG,
    store: store,
    restoreAll: restoreAll,
    pending: function () { return pending().marks.length; },
    editor: editor,
    thresholds: { chars: MIN_CHARS, lines: MIN_LINES },
    disable: function () { try { localStorage.setItem(LS, '0'); } catch (e) {} }
  };
})();
