/* 15-subagents.js —— 让"1 个子智能体 / 1 个后台任务"这两个 chip 可点，
 * 点一下直接打开标题栏那个『智能体团队』面板（子代理列表就在这里）。
 *
 * 背景：这两个 chip 是移动端唯一常驻的子代理状态指示；标题栏的『智能体团队』按钮
 *       文字被图标化后不好认，很多人找不到。点 chip 直达 = 最自然的入口。
 */
(function () {
  var W = window, D = document;
  if (W.__dshSubEntry) { return; }
  var SEL = '[class*="oXE0lW_root"],[class*="foD-wG_root"]';

  function teamBtn() {
    var bs = D.querySelectorAll('button,[role="button"]');
    for (var i = 0; i < bs.length; i += 1) {
      var l = ((bs[i].getAttribute('aria-label') || '') + (bs[i].getAttribute('title') || '')).trim();
      if (/智能体团队|agent team|teammates/i.test(l)) { return bs[i]; }
    }
    return null;
  }
  function openTeam() {
    var b = teamBtn();
    if (b) { b.click(); return true; }
    return false;
  }
  /* 面板是否已经开着（有可见的成员/团队面板） */
  function teamOpen() {
    var ps = D.querySelectorAll('[class*="EBLgjq_panel"],[class*="panelC"]');
    for (var i = 0; i < ps.length; i += 1) {
      var r = ps[i].getBoundingClientRect();
      if (r.width > 120 && r.height > 60 && r.top < innerHeight && r.bottom > 0) { return true; }
    }
    return false;
  }

  D.addEventListener('click', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest(SEL) : null;
    if (!chip) { return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
    if (teamOpen()) {                                   /* 已开 → 再点收起 */
      var b = teamBtn();
      if (b) { b.click(); }
      return;
    }
    if (!openTeam()) {
      /* 找不到按钮：给个提示，别静默失败 */
      try {
        var d = D.createElement('div');
        d.setAttribute('data-dsh-uix', 'subagent-toast');
        d.setAttribute('data-dsh-i18n', '1');
        d.textContent = W.__dshI18n ? W.__dshI18n.pick('找不到团队面板入口', 'Team panel entry not found') : '找不到团队面板入口';
        d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:104px;z-index:995;'
          + 'background:rgba(122,34,34,.96);color:#fff;padding:9px 13px;border-radius:10px;font-size:13px;';
        D.body.appendChild(d);
        setTimeout(function () { if (d.parentNode) { d.parentNode.removeChild(d); } }, 2200);
      } catch (err) {}
    }
  }, true);


  /* 把两个状态 chip 顶到第二行：在第一个 chip 前插入一个 100% 宽的占位元素
     （标题行允许换行，占位元素强制换行，chip 就整体落到下一行） */
  var SPACER = 'data-dsh-sub-break';
  function ensureBreak() {
    try {
      var chips = D.querySelectorAll(SEL);
      if (!chips.length) { return false; }
      var first = chips[0];
      var parent = first.parentElement;
      if (!parent) { return false; }
      var ex = parent.querySelector('[' + SPACER + ']');
      if (ex) { return true; }
      var sp = D.createElement('div');
      sp.setAttribute(SPACER, '1');
      sp.style.cssText = 'flex-basis:100%;width:100%;height:0;margin:0;padding:0;order:98;pointer-events:none;';
      parent.insertBefore(sp, first);
      return true;
    } catch (e) { return false; }
  }
  ensureBreak();
  var t = setInterval(function () {
    if (!D.querySelector('[' + SPACER + ']')) { ensureBreak(); }
  }, 1500);
  setTimeout(function () { clearInterval(t); }, 30000);
  W.addEventListener('resize', ensureBreak);

  W.__dshSubEntry = { openTeam: openTeam, teamOpen: teamOpen, teamBtn: teamBtn };
})();
