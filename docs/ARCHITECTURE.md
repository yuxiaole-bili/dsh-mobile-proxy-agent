# 架构与移植对照
> **中文**：架构与数据流：鉴权、文件 API、API 缓存、热补丁注入的细节。
>
> **English**: Architecture & data flow: auth, file API, API cache, hot-patch injection.


## 1. 为什么要三层，而不是"全做成插件"

DSH 插件跑在 **DSH 自己的进程 / 页面**里。这决定了它能碰什么、碰不到什么：

| 问题 | 插件能解吗 | 原因 |
|---|---|---|
| 较旧内核 缺 `Promise.withResolvers` / `AbortSignal.any` | ✅ | 页面里补 polyfill 就行 |
| 页面布局挤、抽屉盖正文 | ✅ | 注入 CSS |
| 明文 HTTP 下没有 `navigator.mediaDevices` | ⚠️ 半 | 插件可以**伪造** `getUserMedia`，但真实录音要么靠原生桥，要么靠宿主提供 |
| 会话列表 78 万字节 / 首屏 500 条 | ✅（服务端插件） | 在 RPC 层改请求与响应 |
| 上游 300 秒请求超时把慢上传判死 | ❌ | 那是 DSH 网络栈的超时；插件在它之上，改不了"请求还没收完就超时" |
| 手机上行只有 3 KB/s | ❌ | 物理链路问题（Tailscale 中转）；插件只能让它**别失败**，不能让它变快 |
| 原生录音、Android Intent、线路热切换 | ❌ | 必须原生壳 |

**结论**：插件是"最正统"的一层（无反向代理、无证书、随 DSH 升级），
但**网络层与原生层的问题必须留在代理/壳里**。三层是互补而不是替代。

## 2. 能力 → 归属 对照表

| 能力 | 现在在哪（本仓库） | 能不能进插件 | 备注 |
|---|---|---|---|
| polyfill（`withResolvers`/`signal.any`/`groupBy`/…） | 代理注入 `MOBILE_POLYFILL` | ✅ 客户端插件 | 移植最直接 |
| 移动端适配 CSS（栅格/抽屉/正文列） | 代理注入 `MOBILE_ADAPT_CSS` | ✅ 客户端插件 | 注意样式优先级与升级兼容 |
| 连接守夜人 `__dshKeeper` | 代理注入 | ✅ 客户端插件 | |
| 手势层 `__dshGestures` | 代理注入 | ✅ 客户端插件 | |
| 分页器 `__dshPager`（首屏 10 条、自动续 5 次） | 代理注入 + 改写 POST/WS 帧 | ✅ 移到**服务端插件**更干净 | 直接改 RPC 请求，不用正则改 body |
| 会话列表瘦身（785 KB → 44 KB） | 代理改响应体 | ✅ 服务端插件 | 白名单要以线上 zod schema 为准 |
| 接口磁盘缓存（20s TTL + 90s SWR + 历史页 7 天） | 代理 | ✅ 服务端插件 | 注意 rpcId 必须换回调用方的 |
| 只读文件接口 `/f` `/d` `/dl` | 代理自带路由 | ✅ 服务端插件注册路由 | 越权防护照搬（realpath 白名单） |
| "就地看文件 / 用手机 App 打开" | 热补丁 `50-fileview.js` + 原生 `openwith` | 半：入口可进插件，**打开动作必须原生** | |
| 语音（录音 → WAV → 主机转写） | 代理注入 shim + 原生 `__DSHVoice` | 半：shim 可进插件，**录音必须原生** | |
| 热补丁通道（改文件刷新即生效） | 代理读 `hotpatch/` 拼包 | ⚠️ 插件本身有 HMR 机制，需调研后决定 | |
| 压缩 / 静态资源 immutable | 代理 | ❌ | DSH 自带，插件不该重复 |
| WS 中继、代答 PING、整帧写入锁 | 代理 | ❌ | 插件在进程内，没有这一跳 |
| **大 body 先收完再连上游** | 代理（`REQ_BUFFER_MIN`） | ❌ | 修"发图片被吞"的关键，必须在代理层 |
| 局域网 / VPN 双模热切换 | Android 壳 | ⚠️ 插件可提供"候选地址"接口 | 壳仍需自己做探测与切换 |
| 原生录音桥 / Intent 选择器 / 预装资源 | Android 壳 | ❌ | |

## 3. 反向代理这一层都做了什么（可独立使用）

`proxy/proxy.py` 是一个单文件 asyncio 反向代理（无第三方依赖），核心机制：

- **注入**：给 HTML 加 `<script id="dsh-polyfill">`、`<style id="dsh-mobile-adapt">`、
  `<script id="dsh-hot">`（热补丁）、语音 shim；
- **改写**：`/api/session/list` 瘦身、`/api/session/page` 压 `maxMessages`、
  `/api/remote.mux` 上的 `session/follow` 开帧改 `turnWindow`；
- **缓存**：POST RPC 的磁盘缓存（键里**去掉**每请求唯一的 `rpcId`，回放时再换回去，
  否则客户端会 `rpcId mismatch`）；
- **自带路由**：`/f` `/d` `/dl`（只读文件）、`/m/`（轻量页）、`/apk`、`/__hot/*`（热补丁）、
  `/__health`（免密钥探活，手机端线路探测就用它）；
- **网络层修复**：大于 `REQ_BUFFER_MIN`（默认 256 KB）的请求体**先收完再连上游**，
  避免慢链路上传撞上游 300 秒超时；
- **鉴权**：除 `/__health` 外一切路由都要 `?k=<cap.key>` 或 `dshcap` cookie。

安全边界（都实测过）：路径穿越、`C:\Windows`、前缀假冒、NUL 字节、无密钥/错密钥全部拒绝；
HTML 一律按 `text/plain` 返回（防 XSS），响应带 `nosniff` + `no-store`。

## 4. Android 壳这一层

- **离线构建**：`aapt2 + javac + d8 + zipalign + apksigner`，不需要 Gradle/网络（见 `android/build.ps1`）；
- **预装资源**：把首屏那 10 MB 插件包打进 APK，命中就本地直出（键 = 路径+完整查询串，含 `rev`）；
- **原生桥**：`__DSHNative.call(method, argsJson)` → `__DSHNativeResult(callId, json)`；
  方法含 `ping/info/toast/vibrate/share/openUrl/clipboard.*/back/bundle.*/openwith`；
- **双模线路**：候选地址表 + 并行探测 `<候选>/__health` + 启动/回前台/网络变化/45s 轮询触发 +
  换 host 热重载（详见 `README.md` 第 4 节）。

## 5. 待调研确认（插件侧）

> 这一节由 `plugin/` 的调研结论补齐：DSH 插件的清单格式、放置目录、服务端/客户端 API、
> 生命周期、启用步骤，以及"最小可用插件"长什么样。结论会写进
> `docs/PLUGIN.md`，并据此实现 `plugin/` 下的第一个能力（polyfill + 移动端适配）。
