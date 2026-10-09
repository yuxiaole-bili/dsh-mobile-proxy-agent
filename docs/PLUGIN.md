# DSH 插件机制（从真实安装里读出来的）

> 结论：**能做成插件**，而且我们已经在 `plugin/` 里做了一个可用的（host + client 两半边）。
> 下面每条都来自本机真实文件，不是推测。

## 1. 插件是什么

**一个 ESM npm 包（bundle），有"host 半边"和可选的"client 半边"。**

以本机已安装的第三方插件 `dsh-alert-chime` 为例（`~/.dsh/profiles/node_modules/dsh-alert-chime/`）：

```json
{
  "name": "dsh-alert-chime",
  "type": "module",
  "main": "lib/host.js",                        // host 半边（在 DSH 进程内跑）
  "exports": {
    ".":         { "default": "./lib/host.js" },
    "./client":  { "default": "./lib/client.js" },   // client 半边（在浏览器页面里跑）
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": { "inject": [], "platform": "web", "immediately": true }
  }
}
```

### host 半边（`lib/host.js`）

Cordis 风格的插件对象：**导出 `{ name, inject, apply }`**。

```js
const name = 'alert-chime'
const inject = ['webServer']          // 声明依赖：等 HTTP 载体挂载后再激活本插件

function apply(ctx) {
  const sessions = ctx.get('sessions')            // 取服务
  ctx.on('session/event', (session, event) => {}) // 订阅事件
  ctx.effect(() => webServer.register({            // 注册 HTTP 路由（随插件一起销毁）
    kind: 'exact', path: '/alert-chime/events', handler,
  }))
}
export { apply, inject, name }
```

要点（`@deepseek-ai/dsh-plugin-manager` 的 README 原话）：
> *installed Host code executes **in-process** outside the workspace sandbox*

→ host 半边跑在 DSH 自己的进程里、**不受工作区沙箱限制**。能力很大，所以插件必须**防御式编码**
（我们的 `apply()` 全程 try/catch，绝不抛出——插件抛异常会把整个 profile 组合带下去）。

### client 半边（`lib/client.js`）

模块加载器协议，返回与 host 同形的插件对象：

```js
window.__ModuleLoader__.load({
  id: 'dsh-alert-chime',                 // 必须等于包名
  factory: (require) => {
    var exports = {}
    exports.name = 'alert-chime'
    exports.inject = []
    exports.apply = function () { /* 页面里跑：注入样式/DOM、fetch、包 API 都行 */ }
    return exports
  },
})
```

client 半边**拥有完整页面权限**（`document`、`fetch`、`window`），这正是把
"polyfill / 移动端 CSS / 守夜人 / 手势"从反向代理搬进来的落点。

## 2. 插件放哪、怎么启用

### 位置

```
~/.dsh/profiles/node_modules/<包名>/        ← 包本体（本机已装的两个第三方插件就在这）
~/.dsh/profiles/desktop/cordis.patch.yml    ← 把插件"插"进组合（一个 insert 行）
```

### `cordis.patch.yml` 里的真实例子（本机原文）

```yaml
- insert:
    - id: alert-chime
      name: dsh-alert-chime
    - id: cyberpunk-theme
      name: '@dsh-cyberpunk/cyberpunk-theme'
- id: alert-chime
  disabled: false
```

- `insert:` 里的 `id` 是**行 id**（可被后续 `- id: <row>` 覆盖/禁用），`name` 是包名；
- 插件的开关就是 `disabled:`；plugin-manager 页面上点开关，写的就是这里最后一条匹配的 `disabled`。

### 两条启用路径

1. **官方路径（推荐）**：Web 侧栏 **插件** 页（你手机上截图那个页面），或
   `plugin_manager` 工具 / `dsh plugin` CLI，直接 `installBundle` 一个 registry 包、路径、git 或 tarball；
   它会跑 pnpm、做 peer 版本兼容检查、失败时回滚 `package.json`/`pnpm-lock.yaml`。
2. **手工路径（离线/自用最省事）**：把包目录拷进 `~/.dsh/profiles/node_modules/<包名>/`，
   再在 profile 的 `cordis.patch.yml` 追加一条 `insert:` 行。

**生效时机**：plugin-manager README 说 *"With HMR enabled in YAML, configuration changes apply
immediately; without HMR, the running composition remains until restart."* —— 也就是说
**开了 HMR 就即时生效，否则要重启 DSH**（重启会中断正在跑的会话，请挑时间）。

## 3. `plugin/` 里已经做出来的东西（v0.1.0）

| 半边 | 做了什么 |
|---|---|
| host（`index.js`） | `export { apply, inject, name }`，`inject: ['webServer']`；注册两条只读路由：`GET /mobile-kit/health`（探活）与 `GET /mobile-kit/info`（**本机非回环 IPv4 列表**，仅本机/私网/Tailscale peer 可读）—— 手机端的"局域网/VPN 双模"可以直接问它要候选地址，不用再硬编码网段 |
| client（`client.js`） | 较旧内核 缺的 API 一批（`Promise.withResolvers`、`AbortSignal.any/timeout`、`Object/Map.groupBy`、`URL.canParse/parse`、`Array.fromAsync`、`findLast/Index`、`toSorted/toReversed`、`structuredClone`、`Set.union/intersection/difference`、`crypto.randomUUID`）+ 两条真机验证过的移动端布局修复（`_panel` 让出 56px 图标栏、表头按钮不换行），全局限定在 `@media (max-width:820px)`；样式经 `ctx.effect` 注册，禁用插件即回收 |

### 验证（`tools/` 之外的 `plugin_verify.js`，**16/16 PASS**）

```
== A. host 半边 ==
PASS  host.js 可被 import
PASS  导出 apply/inject/name  | name=mobile-kit inject=["webServer"]
PASS  注册了两条路由  | ["exact /mobile-kit/health","exact /mobile-kit/info"]
PASS  GET /mobile-kit/info 返回本机 IPv4 列表  | addresses=[Radmin VPN 26.36.62.139, 以太网 <PC-LAN-IP>, WLAN <SRV-LAN-IP>]
== B. client 半边（无头模拟 较旧内核：先删 withResolvers / findLast）==
PASS  client.js 注册到 __ModuleLoader__，id 与包名一致
PASS  factory + apply() 不抛异常
PASS  polyfill 生效：withResolvers / AbortSignal.any 回来了
PASS  移动端 CSS 已注入；console 无报错
```

另外，本机**已经跑着的**第三方插件 `dsh-alert-chime` 的路由 `/alert-chime/events` 在代理日志里
被手机轮询过（`chime /alert-chime/events?since=71`）—— 这就是"第三方 host 路由真的生效"的现成证据，
我们的插件用的是同一套机制。

## 4. 移植对照：什么能进插件、什么必须留在外面

| 能力 | 进插件 | 说明 |
|---|---|---|
| polyfill | ✅ client | 已实现 |
| 移动端适配 CSS | ✅ client | 已实现两条；其余（栅格/抽屉/正文列）照搬 `proxy/` 里的 `MOBILE_ADAPT_CSS` |
| 连接守夜人 / 手势层 | ✅ client | 直接搬 `proxy/MOBILE_KEEPER`、`__dshGestures` |
| 首屏分页 / 列表瘦身 / 接口缓存 | ✅ **host** | 在 host 半边改 RPC 请求/响应，比在代理里正则改 body 干净得多 |
| 只读文件接口 `/f /d /dl` | ✅ host | `webServer.register` + realpath 白名单照搬 |
| 用手机 App 打开文件 | ⚠️ 半 | 入口可进插件；**打开动作必须原生**（Android Intent） |
| 语音：录音 → WAV → 转写 | ⚠️ 半 | shim 可进 client 半边；**录音必须原生**（`AudioRecord`） |
| **大 body 先收完再转发**（修"发图片被吞"） | ❌ | 在 DSH 网络栈之外才有意义；上游 300s 超时是 DSH 自己的，插件改不了 |
| 局域网 / VPN 双模热切换 | ⚠️ 半 | 插件可**提供候选地址**（本插件 `/mobile-kit/info` 就是干这个）；探测与切换仍在壳里 |
| 压缩 / 静态资源缓存 / WS 中继 | ❌ | DSH 自带，插件不该重复 |

## 5. 给插件作者的几条硬经验

1. **`apply()` 绝不抛异常**：host 半边在 DSH 进程内，抛了会影响整个 profile 组合。
2. **`inject` 要声明依赖**（如 `['webServer']`），让 profile 决定激活时机；取服务用 `ctx.get('x')`。
3. **注册的东西一定放进 `ctx.effect(...)`**，这样插件被禁用/卸载时会回收。
4. **client 半边的 `id` 必须等于包名**，否则加载器对不上。
5. **改配置后要不要重启，取决于 HMR**；不确定就先只装包、不动 `cordis.patch.yml`，确认无误再插入。

---

## 6. 权威更正与补充（2026-10-05 二次取证，全部有出处）

前五节是我从两个已装第三方插件反推的；这一节是**把发行包翻了一遍之后的更正**，冲突以本节为准。

### 6.1 更正

| 前文说法 | 更正 |
|---|---|
| 插件入口是 `main` / `exports["."]` | **正式形态是"bundle"**：包在 `package.json` 里声明 `dsh.bundle.patch`（随包一份 `cordis.patch.yml`，由它 insert 自己的行）。`insert` 行直接挂包（不再需要包自带 patch）同样可行——本机 `dsh-alert-chime` 就是后者 |
| 只能放进 `node_modules` / 跑 pnpm | **`insert` 行的 `name` 支持绝对路径 / `file:` URL / `./` 相对路径**（`dsh-app-boot/lib/index.js:3537`）→ 免 pnpm、免 node_modules，最适合自用与实验 |
| HMR 不确定，可能要重启 | **HMR 默认开着**（`dsh-base` 补丁里的 `hmr` 行；watch profile manifest + 两个用户 patch 文件）→ **改 patch 保存即生效**。但**原地改 JS 不生效**（ESM 按 URL 缓存），要么换文件名要么重启 |
| 插件路由和自己的接口随便开 | **`ctx.webServer` 没有内建鉴权**：插件自注册路由对能访问该端口的人完全开放（实测 `/alert-chime/events` 无鉴权 200）。本插件的 `/mobile-kit/info` 因此自带 peer 白名单（回环/私网/Tailscale CGNAT），公网 403 |
| 配置可能来自 `settings.yaml` | **不是**。`settings.yaml` 是历史遗留的一次性导入格式（已改名 `.imported`，键就是 Loader 行 id）。**插件配置的唯一权威来源是 patch 行的 `config:` 块**，且 `config` 是**整体替换、绝不深合并** |

### 6.2 官方资料在哪（发行包里没有 `docs/`、没有 `.d.ts`）

- **权威 API 清单**：`…/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`
  = **91 个 ctx service + 81 个事件（带 mode）**；
- **随包 4 个 skill**（真正能用的文档）：
  `@deepseek-ai/dsh-agent-preset/skills/{cordis-plugin-development（含 references/* 与 templates/*）、cordis-composition-reference（含 38 KB 可装载包全清单）、editing-cordis-compositions、agent-experience}`
- **官方模板**：`…/skills/cordis-plugin-development/templates/decoration/{package.json,cordis.patch.yml,index.js,client.js}`
  与 `templates/mcp/*`（纯配置 2 文件）。本插件的四个文件就是照它写的。
- 常用 service：`ctx.tools / webServer / systemPrompt / storage / fs / shell / subprocess / sessions / agents / sessionProjections / skills / commands / jobs / userQuestions / approval / logger`；
  client 侧：`slots / locale / uiConversation / layout / shortcuts / remote.*`。

### 6.3 官方要求（踩了会返工的几条）

1. host 插件**只能二选一**导出形式：`export function apply(ctx, config)`（+ 可选 `inject`/`Config`）**或** 默认导出 service class —— 不要混用；
2. **所有资源都用 `ctx.effect` / `ctx.on` 注册并返回清理**（host 与 client 都一样）；client 的工厂必须**无副作用**；
3. client 模块 **`id` 必须等于包名**；声明了 `dsh.client` 就必须有 `exports["./client"]`；
4. **别自己写 profile 的 `package.json` / `cordis.patch.yml`、别在 profile 目录跑 pnpm** —— 官方路径是
   `plugin_manager` 的 `install_bundle`（Web 侧栏「插件」页同理）。手工路径只在没有该工具时用；
5. 显示名/描述放 `meta` + `locale/*.json`，图标用顶层 `icon`（SVG/PNG ≤256 KiB，路径不得越出包目录）；
6. 唯一会拦插件的兼容闸门是 `peerDependencies` 上的 `@deepseek-ai/dsh*`（**不声明 = 无约束**，
   本机两个第三方插件都没声明）；
7. Host 半边**无沙箱**（官方原文："installed Host code executes in-process outside the workspace sandbox"）
   → `apply()` 必须防御式，抛异常会把整个 composition 带下去。

### 6.4 本插件当前状态

四个文件已按官方模板重写，`tools/plugin_verify.js` **23/23 PASS**：
清单字段、host 导出形状、`ctx.effect` 注册、路由真跑、peer 鉴权（本机 200 / 公网 403 / Tailscale 200）、
client 在"先删 `withResolvers`/`findLast`"的 较旧内核 条件下 polyfill 复原 + CSS 注入 + 0 报错。
