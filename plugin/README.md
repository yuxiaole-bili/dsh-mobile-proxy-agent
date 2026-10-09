# dsh-mobile-kit（DSH 插件）

让 DSH 的网页端在**手机**上可用的插件：较旧内核 缺的 API 补齐 + 两条真机验证过的移动端布局修复 +
给手机壳用的"局域网/VPN 候选地址"接口。

> 这是 [dsh-mobile-kit](../README.md) 的插件半边。仓库里还有 `proxy/`（反向代理，能补插件补不了的网络层问题）
> 与 `android/`（原生壳：录音、Intent、线路切换）。

## 文件（对齐 DSH 官方 4 文件模板）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单：`dsh.bundle.patch`（bundle 身份）+ `dsh.client`（浏览器半边）+ 双入口 `exports` |
| `cordis.patch.yml` | 随包补丁：把自己插进 composition（`- insert: - id: mobile-kit, name: dsh-mobile-kit`） |
| `index.js` | **Host 半边**（跑在 DSH 进程内）：`export { apply, inject, name }`，注册 `/mobile-kit/health` 与 `/mobile-kit/info` |
| `client.js` | **Client 半边**（跑在页面里）：polyfill + 移动端 CSS，经 `ctx.effect` 注册、随插件卸载回收 |

## 装法（三种）

1. **Web 侧栏「插件」页**（推荐，本机可用）：添加 bundle → 指向这个目录。
   官方语义是 `plugin_manager` 的 `install_bundle`；本机该 agent 工具默认关（仅 Creator 预设开），Web 页可用。
2. **profile 补丁里用绝对路径直接挂载**（本机免 pnpm、免 node_modules）：
   在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加
   ```yaml
   - insert:
       - id: mobile-kit
         name: '<REPO>/plugin'
   ```
   `insert` 行的 `name` 接受包名 / 绝对路径 / `file:` URL / `./` 相对路径。
3. **作为 bundle 装进 profile**：让 profile 的 `package.json` → `dsh.profile.bundles` 含本包；
   包自己的 `cordis.patch.yml` 会插入它的行。

> **HMR 默认开着**：改 profile 的 patch 文件即时生效，**不用重启 DSH**。
> 但**原地改 JS 无效**（ESM 按 URL 缓存）—— 换文件名或重启才会加载新代码。

## 接口

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /mobile-kit/health` | 无 | 探活，给连接守夜人 / 线路探测用 |
| `GET /mobile-kit/info` | **仅本机/私网/Tailscale peer** | 返回本机非回环 IPv4 列表，手机壳据此生成"局域网候选地址" |

`ctx.webServer` **没有内建鉴权**（官方行为：插件路由默认对能访问该端口者开放），
所以 `/info` 自己做了 peer 校验：回环 / `10.` / `192.168.` / `172.16-31.` / Tailscale CGNAT（`100.64-127.`）
放行，其余返回 403。

## 验证

```bash
node ../tools/plugin_verify.js      # 23/23 PASS
```

覆盖：清单字段、host 导出形状、`ctx.effect` 注册、路由真跑、peer 鉴权（本机 200 / 公网 403 / Tailscale 200）、
client 在"先删 `withResolvers`/`findLast`"的 较旧内核 条件下 polyfill 复原 + CSS 注入 + 0 报错。

## 已知边界

- 插件**补不了网络层**：慢上行撞 DSH 自身 300s 请求超时（"发图片被吞"）要在 `proxy/` 层修。
- 插件**补不了原生**：录音、用第三方 App 打开文件、线路热切换在 `android/` 层。
- Host 半边**无沙箱**（官方原文："installed Host code executes in-process outside the workspace sandbox"）：
  本插件的 `apply()` 全程 try/catch，绝不向外抛异常。

## 实测：作为 DSH 插件真的跑起来了（2026-10-07）

在**没有外网**的机器上（npm/registry 全不通，跑不了 pnpm）用**绝对路径挂载**装进 profile，
6 秒内 HMR 生效，**不需要重启 DSH**：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml 末尾
- insert:
    - id: mobile-kit
      name: '<REPO>/plugin/index.js'
```

**⚠️ 坑（重要）**：`name` 必须指向**入口文件**，不能指向包目录。
指向目录时 loader 会解析成 `file:///…/plugin`，而 Node ESM 拒绝目录导入
（`Directory import … is not supported resolving ES modules`），host 半边**静默不加载**，
路由 404 且没有任何报错——第一次就是这么失败的。指 `index.js` 后立刻 200。
（loader 会读最近的 `package.json`，所以 `dsh.client` 声明的浏览器半边照样生效。）

### 验证结果

| 半边 | 检查 | 结果 |
|---|---|---|
| host | `GET /mobile-kit/health` | **200** `{"ok":true,"name":"mobile-kit","version":"0.1.0",…}` |
| host | `GET /mobile-kit/info` | **200** `{"platform":"win32","node":"24.18.1","addresses":[Radmin VPN 26.36.62.139, 以太网 …]}` |
| 清单 | `__DSH_BOOT__.entries` | 客户端插件数 **75 → 76**，出现 `{"id":"dsh-mobile-kit","url":"plugins/??dsh-mobile-kit/client.js&rev=…","immediately":true}` |
| client | 客户端包 | **200，9,525 B**，含 `__ModuleLoader__.load` / polyfill / `dsh-mobile-kit-css` |
| client | 页面内 `window.__dshMobileKit.state()` | `{version:"0.1.0", mobile:true, withResolvers:"function", abortAny:"function", css:true, notes:["applied (mobile)"]}` |
| client | DOM | `#dsh-mobile-kit-css` 存在，内容含 `_panel` 规则 |
| 共存 | 与本仓库的手机热补丁 | `__dshChipView` / `__dshFileView` 均在，互不干扰 |
| 控制台 | 报错数 | **0** |

端到端脚本：`tools/test_mobilekit_e2e.js`（10/10 PASS）、`tools/test_mobilekit_client.py`、
`tools/test_plugin_routes.py`。证据：`evidence/mobilekit_e2e.txt`。

### 卸载

删掉 `cordis.patch.yml` 里那一段 `insert` 即可（备份 `cordis.patch.yml.bak_mobilekit_*`）；
文件里没有别的改动。
