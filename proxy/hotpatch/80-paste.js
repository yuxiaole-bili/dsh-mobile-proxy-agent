/* 80-paste.js —— 粘贴拦截（当前：已停用）
 *
 * 为什么停用（2026-10-09 实测结论）：
 *   1. 真机"粘贴吞字"的根因找到了：这个富文本编辑器（DIV.RlGAzG_input，受控组件）
 *      **会把一次性写入的长文本丢掉** —— 实测粘贴 457 字，落地 0 字。
 *   2. 用「分块写入」有明显改善：0 → 293/457 字（部分块仍被丢弃）。
 *   3. 但"折叠成 ⟦…⟧ 后点开/发送前还原"在这套编辑器上**不可靠**：
 *      Range 选中已有文字不被编辑器识别，整体重写会被受控状态回滚，
 *      发送保命拦截虽能挡住"把标记发出去"，但会让人卡在"请再按一次发送"。
 *
 * 结论：先把拦截完全停用，保证粘贴行为与官方一致、不会卡住；
 *       「分块写入 + 自愈补写」的实现留待真机验证通过后再启用。
 *
 * 后续要恢复的话：把下面的 return 去掉，并用 ?no-pastefold=0 打开折叠做灰度测试。
 */
(function () {
  window.__dshPaste = {
    disabled: true,
    enabled: false,
    reason: 'temporarily-disabled: paste intercept unreliable on this editor',
    note: 'paste behaves exactly like the stock app; no interception'
  };
  return;
})();
