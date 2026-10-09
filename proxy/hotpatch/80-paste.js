/* 80-paste.js —— 大段粘贴折叠（像 Claude Code 那样）
 *
 * 问题：手机上粘贴大量文字时，WebView / 输入框会卡住甚至把内容吞掉。
 * 做法：粘贴内容超过阈值时，不直接塞进输入框，而是放一个短标记
 *        ⟦ 已粘贴 128 行 · 点击展开 ⟧
 *      · 点击标记 → 就地展开成全文
 *      · 发送前（Enter / 点发送）→ 自动把标记还原成全文，模型拿到的是完整内容
 *      · 只在小粘贴时完全不干预
 */
(function () {
  var W = window, D = document;
  if (W.__dshPaste) { return; }

  /* ⚠️ 默认关闭：真机行为尚未验证（无头合成事件绕过了编辑器的真实粘贴管线）。
     合成环境实测：标记能写入，但"点击展开"与"发送前还原"都没成功 —— 若真机同样如此，
     模型会收到标记而不是正文，比原问题更糟。所以必须显式开启后再用：
       · 地址加 ?pastefold=1     · 或 localStorage.setItem('dsh-pastefold','1')
     真机验证通过后再把默认值改成开。 */
  function enabled() {
    try {
      if (/[?&]pastefold=1\b/.test(location.search)) { try { localStorage.setItem('dsh-pastefold', '1'); } catch (e) {} return true; }
      if (/[?&]pastefold=0\b/.test(location.search)) { try { localStorage.setItem('dsh-pastefold', '0'); } catch (e) {} return false; }
      return localStorage.getItem('dsh-pastefold') === '1';
    } catch (e) { return false; }
  }
  if (!enabled()) {
    W.__dshPaste = { disabled: true, reason: 'unverified-on-device', enable: function () {
      try { localStorage.setItem('dsh-pastefold', '1'); } catch (e) {} location.reload();
    } };
    return;
  }

  var MIN_CHARS = 600;   // 超过这么多字符
  var MIN_LINES = 12;    // 或超过这么多行 → 折叠
  var store = {};
  var seq = 0;

  function T(zh, en) { return W.__dshI18n ? W.__dshI18n.pick(zh, en) : zh; }

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
  /* 写入 + 校验 + 有限重试：execCommand 在合成事件里会"假成功"，
     而且 app 是受控组件，可能把 DOM 回滚，所以要反复确认写进去了。 */
  function ensure(pred, apply, tries) {
    var n = 0;
    (function tick() {
      try { if (pred()) { return; } apply(); } catch (e) {}
      n += 1;
      if (n < (tries || 8)) { setTimeout(tick, 150); }
    })();
  }
  function insert(ed, s) {
    var before = val(ed);
    ensure(function () { return val(ed).indexOf(s) >= 0; },
      function () {
        try { ed.focus(); } catch (e) {}
        try { D.execCommand('insertText', false, s); } catch (e) {}
        if (val(ed) === before) { setVal(ed, before + s); }
      });
  }
  function label(text) {
    var lines = String(text).split('\n').length;
    var chars = String(text).length;
    return '⟦ ' + T('已粘贴 ', 'pasted ') + lines + T(' 行', ' lines')
      + ' / ' + chars + T(' 字 · 点击展开', ' chars · click to expand') + ' ⟧';
  }

  /* ① 拦截粘贴 */
  D.addEventListener('paste', function (e) {
    try {
      var ed = editor();
      if (!isEd(ed, e.target)) { return; }
      var cd = e.clipboardData || W.clipboardData;
      var txt = cd ? (cd.getData('text/plain') || cd.getData('text') || '') : '';
      if (!txt) { return; }
      var lines = txt.split('\n').length;
      if (txt.length < MIN_CHARS && lines < MIN_LINES) { return; }   // 小粘贴不干预
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
      seq += 1;
      var id = 'p' + seq;
      var mark = label(txt);
      store[id] = { text: txt, mark: mark, expanded: false };
      insert(ed, mark);
      W.__dshPaste.last = id;
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
          if (!it.mark || it.expanded) { continue; }
          var i = s.indexOf(it.mark);
          if (i < 0) { continue; }
          if (pos >= 0 && (pos < i || pos > i + it.mark.length)) { continue; }
          var mk = it.mark, full = it.text;
          it.expanded = true; it.mark = null;
          ensure(function () { return val(ed).indexOf(mk) < 0; },
            function () {
              var cur = val(ed), j = cur.indexOf(mk);
              if (j >= 0) { setVal(ed, cur.slice(0, j) + full + cur.slice(j + mk.length)); }
            });
          return;
        }
      }, 0);
    } catch (err) {}
  }, true);

  /* ③ 发送前还原全文（Enter / 发送按钮 / 提交） */
  function expandAll() {
    try {
      var ed = editor();
      if (!ed) { return; }
      var s = val(ed), changed = false;
      for (var id in store) {
        var it = store[id];
        if (it.mark && s.indexOf(it.mark) >= 0) {
          s = s.split(it.mark).join(it.text);
          changed = true;
          it.expanded = true;
          it.mark = null;
        }
      }
      if (changed) {
        ensure(function () { return !/⟦[^⟧]*⟧/.test(val(ed)); },
          function () {
            var cur = val(ed);
            for (var k in store) {
              var it2 = store[k];
              if (it2.text && cur.indexOf('⟦') >= 0) {
                cur = cur.replace(/⟦[^⟧]*⟧/g, function (m2) {
                  return (it2.text && m2 === it2.mark) ? it2.text : m2;
                });
              }
            }
            if (cur.indexOf('⟦') < 0) { return; }
            // 兜底：任何残留标记都用最近一次粘贴的全文替换
            var lastId = null; for (var k2 in store) { lastId = k2; }
            if (lastId) { cur = cur.replace(/⟦[^⟧]*⟧/g, store[lastId].text); }
            setVal(ed, cur);
          });
      }
    } catch (err) {}
  }
  D.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { expandAll(); }
  }, true);
  D.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button,[role="button"]') : null;
    if (!b) { return; }
    var s = ((b.getAttribute('aria-label') || '') + (b.textContent || '')).trim();
    if (/发送|Send|Submit/i.test(s)) { expandAll(); }
  }, true);
  D.addEventListener('submit', function () { expandAll(); }, true);

  W.__dshPaste = {
    store: store,
    expandAll: expandAll,
    editor: editor,
    thresholds: { chars: MIN_CHARS, lines: MIN_LINES }
  };
})();
