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
      return v === null ? true : v === '1';           /* 默认开启 */
    } catch (e) { return true; }
  }
  if (!enabled()) {
    W.__dshPaste = { disabled: true, enabled: false, enable: function () {
      try { localStorage.setItem(LS, '1'); } catch (e) {} location.reload(); } };
    return;
  }

  var store = {}, seq = 0;

  function editor() {
    var els = D.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""]');
    for (var i = els.length - 1; i >= 0; i -= 1) {
      var r = els[i].getBoundingClientRect();
      if (r.width > 140 && r.height > 18 && els[i].offsetParent !== null) { return els[i]; }
    }
    return null;
  }
  function isEd(ed, t) { return ed && (t === ed || ed.contains(t)); }
  function val(ed) { return (ed.value !== undefined) ? ed.value : (ed.innerText || ''); }
  function setVal(ed, s) {
    if (ed.value !== undefined) {
      ed.value = s;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ed.innerText = s;
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }
  function label(text) {
    var lines = String(text).split('\n').length;
    return '⟦ ' + T('已粘贴 ', 'pasted ') + lines + T(' 行', ' lines') + ' / '
      + String(text).length + T(' 字 · 点击展开', ' chars · click to expand') + ' ⟧';
  }

  /* 选中编辑器里 needle 对应的文本区间（textarea 用 selection，富文本用 Range） */
  function selectNeedle(ed, needle) {
    if (ed.value !== undefined) {
      var idx = ed.value.indexOf(needle);
      if (idx < 0) { return false; }
      ed.focus();
      ed.setSelectionRange(idx, idx + needle.length);
      return true;
    }
    var at = (ed.innerText || '').indexOf(needle);
    if (at < 0) { return false; }
    var walker = D.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null);
    var pos = 0, t, sn = null, so = 0, en = null, eo = 0;
    while ((t = walker.nextNode())) {
      var len = t.nodeValue.length;
      if (sn === null && at < pos + len) { sn = t; so = at - pos; }
      if (en === null && at + needle.length <= pos + len) { en = t; eo = at + needle.length - pos; }
      pos += len;
      if (sn && en) { break; }
    }
    if (!sn || !en) { return false; }
    try {
      ed.focus();
      var rg = D.createRange();
      rg.setStart(sn, so);
      rg.setEnd(en, eo);
      var sel = W.getSelection();
      sel.removeAllRanges();
      sel.addRange(rg);
      return true;
    } catch (e) { return false; }
  }

  /* 把 needle 换成 replacement（真实手势下 execCommand 走编辑器自身管线，最可靠） */
  function replaceInEditor(ed, needle, replacement) {
    try {
      var cur = val(ed);
      if (cur.indexOf(needle) < 0) { return true; }
      if (selectNeedle(ed, needle)) {
        try { D.execCommand('insertText', false, replacement); } catch (e) {}
        if (val(ed).indexOf(needle) < 0) { return true; }
      }
      var j = val(ed).indexOf(needle);
      if (j >= 0) { setVal(ed, val(ed).slice(0, j) + replacement + val(ed).slice(j + needle.length)); }
      return val(ed).indexOf(needle) < 0;
    } catch (e) { return false; }
  }

  /* 插入标记：写入 + 校验 + 有限重试（受控组件可能回滚） */
  function insert(ed, s) {
    var n = 0;
    (function tick() {
      if (val(ed).indexOf(s) >= 0) { return; }
      var before = val(ed);
      try { ed.focus(); } catch (e) {}
      try { D.execCommand('insertText', false, s); } catch (e) {}
      if (val(ed) === before) { setVal(ed, before + s); }
      n += 1;
      if (n < 10) { setTimeout(tick, 150); }
    })();
  }

  /* ① 拦截大段粘贴 */
  D.addEventListener('paste', function (e) {
    try {
      var ed = editor();
      if (!isEd(ed, e.target)) { return; }
      var cd = e.clipboardData || W.clipboardData;
      var txt = cd ? (cd.getData('text/plain') || cd.getData('text') || '') : '';
      if (!txt) { return; }
      if (txt.length < MIN_CHARS && txt.split('\n').length < MIN_LINES) { return; }
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
      seq += 1;
      var id = 'p' + seq, mark = label(txt);
      store[id] = { text: txt, mark: mark };
      insert(ed, mark);
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
          if (pos >= 0 && (pos < i || pos > i + it.mark.length)) { continue; }
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

  W.__dshPaste = {
    enabled: true,
    store: store,
    restoreAll: restoreAll,
    pending: function () { return pending().marks.length; },
    editor: editor,
    thresholds: { chars: MIN_CHARS, lines: MIN_LINES },
    disable: function () { try { localStorage.setItem(LS, '0'); } catch (e) {} }
  };
})();
