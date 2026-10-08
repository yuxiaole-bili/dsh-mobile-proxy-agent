# 变更记录

## 0.2.1 (2026-10-08)

手机端界面修复版（全部先在无头浏览器里量出根因、修完再截图复核）。

### 手机端界面
- **弹窗不再透底**：下拉/上下文菜单的底色来自 `_material_*` 层，原本只有 45% 不透明，
  叠加被移除的毛玻璃后几乎全透 → 提升到 96%，并恢复该组件的毛玻璃
- **菜单文字不再被裁**：头部图标按钮的 26px 规则误伤了**渲染在容器内部的下拉菜单项**
  （实测菜单项被压成 26px、文字被 `overflow` 裁掉）→ 规则排除 `_item_*` / `role=menuitem`
- **右侧边栏改成全屏页**：点击后其实已打开，但停在 `x=416`（屏幕外）→ 改为 `fixed` 铺满，
  与设置页同一套做法；并确认面板自带"收起右侧边栏"
- **底部下拉面板可以滑了**：真正装内容的内层 `pane` 是 `overflow-y:hidden`
  （脚本能滚、手指滑不动）→ 放开为 `auto` + `touch-action: pan-y`，用 CDP 真实触摸滑动验证
- 渲染优化选择器收窄：`[class*="_row_"]` 会命中菜单行/面板行导致文字跳过渲染，改为只对
  `flowItem / callRow / WW4l1q_root` 生效

### 安全
- 轮换 capability key（旧 key 曾在公开 APK 中出现过，已下架并重建）
- 清理测试期遗留的 28 个 Chromium profile（约 1.46 GB）

## 0.2.0 (2026-10-07)

### 新增：手机端交互层（hotpatch/90-uiux.js + 00-base.css）
- 底部用量**折叠按钮**（`⌄/⌃`，状态存 localStorage）
- **长按展开**：用量条长按看完整数值；顶部 chip 长按取消省略；折叠的工具行长按自动展开
- **手势**：用量条上滑展开 / 下滑收起
- **通用覆盖层关闭按钮 ✕**：任何 `overlayLayer` 内可见且在视口内的整屏子页面都会自动挂上；
  关闭路径按实测有效性排序（面板内控件 → 对话/轨迹标签 → **另一条侧栏项** → logo → back）
- **消除按键重叠**：标题栏不换行 + chip 限宽省略 + 图标按钮 26px + 窄屏隐藏冗余计数 chip

### 性能
- 代理侧**目录接口缓存**（`API_CACHE_CATALOG_PATHS`，TTL 60s）：`pluginManager/listBundles`(86KB)、
  `pluginInventory/list`(88KB)、`listPlugins`(70KB) 等不再每次点控件都走一遍中继
- 渲染层：`content-visibility:auto`、去掉 `backdrop-filter`/厚阴影、过渡 0.08s
- 自身定时器 1.5s → 4s，且页面隐藏时不做 DOM 扫描

### 安全
- 日志里的历史明文 capability key 已脱敏；当前代码不打印 key
- 客户端错误数组加上限（30/60），防长跑内存增长
- `dsh-gui-forward` 目录 ACL 断开继承，只留 SYSTEM/Administrators/当前用户
- 仓库全量脱敏（内网/Tailscale 地址、个人目录 → 占位符），并有 CI 复查

### 演练
- 10 轮 CTF：第 1/2 轮 9/10（SMB 445 失守），修复后第 3 轮 **10/10 全拦**
- 详见 `docs/PENTEST.md`、`docs/SECURITY.md`

## 0.1.0
- 初始版本：手机端反向代理 + 热补丁通道 + DSH 插件骨架
