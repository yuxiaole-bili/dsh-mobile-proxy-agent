# 手机端热补丁通道（hotpatch）

把 `.css` / `.js` 文件丢进这个目录，**手机刷新页面就生效** —— 不用重启代理，不用重装 APK。

## 怎么用

- 想让**手机端样式**变样的：往这里加 `*.css`（建议整段包在 `@media (max-width:820px){ … }` 里，
  这样桌面浏览器不受影响）。本目录的 `00-base.css` 就是模板（默认只有注释，零视觉影响）。
- 想给页面打 **JS 补丁**（改行为、埋点、加按钮、修前端 bug、临时开关）的：加 `*.js`。
  文件名排序 = 执行顺序，例如 `20-sidebar.js` 会排在 `10-base.js` 之后。
  只对手机生效请自己判断 `window.__dshHot.mobile`（原生桥是否存在看 `window.__dshHot.native()`）。
- 起名字建议用两位数字前缀，方便控制顺序。改文件名/删文件同样立即生效。
- 想临时跳过（只这一次访问）：地址后面加 `?no-hot=1`。
- 想整体关掉：代理进程的环境变量 `DSH_HOTPATCH=0`。

## 现有补丁

| 文件 | 作用 |
|---|---|
| `00-base.css` | 模板（默认零视觉影响） |
| `10-base.js` | 热补丁运行时基座：`__dshHot` / `__dshHotErrors` / `dshNative()` / 硬件返回键 / 语音中继 |
| `50-fileview.js` | **手机端"就地看文件"**：接管"在应用中打开 / 打开文件"；**新版 APK（1.11+）存在时优先交给手机上的第三方 App**（原生 `openwith`：下载 → `content://` → 系统选择器），旧 APK / 桌面浏览器自动退回页面内预览（代理只读接口 `/f` `/d` `/dl`）。详见 `README-fileview.md`；开关 `?no-fileview=1`，诊断 `window.__dshFileView.state()` |
| `70-voiceselfheal.js` | **语音"尚未就绪"自愈**：前端 `usable = readiness.connected && phase∈{ready,standby,waking}`，而 `connected` 只在 `speech/follow` 流首帧置真、流一旦结束就永久停 false（页面不重载就一直弹框）。本补丁盯 `[role="dialog"]` 里的"语音识别尚未就绪"，出现就重启 mux（限速 8s／最多 5 次）让流重建；诊断 `window.__dshVoiceHeal.state()` |
| `60-autocollapse.js` | **点开会话自动收起抽屉**：活动会话变化（轮询 `[data-conversation-session]`）或点中抽屉里的会话行/新会话按钮时把抽屉收起来，避免浮层遮挡正文；只对手机生效，`?no-autocollapse=1` 关，诊断 `window.__dshAutoCollapse.state()` |

## 服务端是怎么做的

- `proxy.py` 会把本目录按 `*.css` / `*.js` 分别**按文件名排序拼接**，`.js` 每个文件各自包一层
  `IIFE + try/catch`（异常进 `window.__dshHotErrors`，不会影响页面）。
- 每个 HTML 页面响应注入两条标签（手机 UA、桌面 UA、`/m/` 都注入）：
  - `<link rel="stylesheet" id="dsh-hot-css" href="/__hot/patch.css?v=<mtime-hash>">`（放在 `</head>` 前）
  - `<script id="dsh-hot" src="/__hot/patch.js?v=<mtime-hash>"></script>`（放在页面最后）
- `/__hot/patch.css` 和 `/__hot/patch.js` **每次请求都重新读盘**（进程内无缓存），
  并回 `Cache-Control: no-store`；`?v=` 由「文件名+mtime+size」派生，文件一变 URL 就变。
- 诊断：`/__hot/status`（要带访问密钥）会列出本目录的文件、字节数、mtime，以及拼好的版本号和注入计数。
- APK 诊断页里也有「热补丁 / 原生桥自检」按钮，可以看到 `__dshHot` 状态与 `__dshHotErrors`。

## 注意

- 补丁文件之间用 `\n;\n` 分隔；**某个 `.js` 有语法错误会让整个 patch.js 解析失败**
  （运行时异常有兜底，语法错误没有）。排查办法：`/__hot/status` 看列表，逐个改名二分，
  或把可疑文件改成非 `.js` 后缀（不参与拼接）。页面本身不会因此打不开。
- 本目录不存在或为空时：路由回空内容（HTTP 200，不报错），页面照常。
