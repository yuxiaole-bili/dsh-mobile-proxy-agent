# 手机端"就地看文件" —— 接口 / 入口 / 验证报告

日期：2026-10-04 · 环境：`dsh-gui-forward` 代理（<PC-LAN-IP>:19390 → 127.0.0.1:19387）
改动范围：`proxy.py`（锚点增量，+339 行 / -0 行）+ `hotpatch/50-fileview.js`（新增）
服务端源码未动、用户数据未动、DSH 服务端未重启（只重启了 `proxy.py` 进程由守护拉起）

---

## 1. 接口清单与安全边界（`proxy.py`）

### 新增路由

| 路由 | 作用 | 关键响应头 |
|---|---|---|
| `GET /f?path=<路径>&k=<cap.key>` | 内联预览 | `Content-Disposition: inline`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff` |
| `GET /d?path=<目录>&k=<cap.key>` | 目录列表页（HTML，可点进子目录/文件） | `Content-Type: text/html; charset=utf-8` |
| `GET /dl?path=<路径>&k=<cap.key>` | 强制下载 | `Content-Disposition: attachment` |

- 鉴权：`?k=<cap.key>` 或 `dshcap` cookie（与既有网关一致）；无密钥/错密钥 → **403**。
- MIME：`.md`→`text/markdown; charset=utf-8`；`.txt/.log/.py/.js/.yaml` 等→`text/*; charset=utf-8`；
  `.json`→`application/json; charset=utf-8`；`.html/.htm/.svg`→**`text/plain`（防 XSS）**；
  `.png/.jpg/.jpeg/.webp/.gif/.bmp/.ico`、`.pdf`；其余回落 `application/octet-stream`。
- 目录走 `/d`（`/f` 命中目录 → 400 提示改用 `/d`）；文件走 `/f`/`/dl`（`/d` 命中文件 → 404）。
- 大文件 64 KB 分块流式写出；`Accept-Ranges: none`（**未实现 Range**，见"未做项"）。

### 安全边界（只读，无任何写/删/执行路径）

1. **规范化**：URL 解码 → 拒绝含 NUL → 拒绝任何 `..` 路径段 → 拒绝非绝对路径；
2. **白名单**：`os.path.realpath()` 结果必须落在允许根目录内（Windows 大小写不敏感比较），
   否则 **403** —— 符号链接逃逸、`C:\Windows`、`<WORKSPACE>x`（前缀假冒）都被拒；
3. **允许根目录**：默认 `<WORKSPACE>`（本代理所在会话工作区，实测 7 个在线会话 cwd 全部是它）；
   需要更多时用环境变量 `DSH_FILE_ROOTS` 追加；
4. HTML 一律按文本返回、所有响应带 `nosniff` + `no-store`；列表页文件名做 HTML 转义（`& < > " '`）；
5. 只读打开（`open(path,"rb")`），没有 POST/PUT/DELETE 分支，没有子进程调用。

---

## 2. hotpatch 入口：怎么接管"打开文件"

新增 `hotpatch/50-fileview.js`（16 KB，热补丁通道注入，**手机刷新即生效**）。

接管三条链路（任一条命中都绝不再把打开动作交给电脑）：

1. **`POST /api/session/openWorkspacePath`**（"打开文件 / 显示文件位置"按钮真正走的 RPC，
   实测形态 `{type:"client-request",rpcId,method:"session/openWorkspacePath",payload:{args:{_request:{path}}}}`）
   → 页面侧 `fetch` 钩子识别 → **不发往上游**，本地返回
   `{type:"server-response",rpcId,result:{ok:true,value:{opened:true}}}`，并在手机内打开预览层。
   同时接管 `POST /api/session/workspacePathApplications`（返回"本机（手机内查看）"这一项）
   与 `canOpenWorkspacePath`（返回 true，让按钮保持可用）。
2. **`POST /open-in-app/open`**（会话头"在应用中打开"）→ 本地返回
   `{opened:true,handledBy:"phone"}`；`GET /open-in-app/apps` → `{"apps":["phone"]}`。
3. **`window.__dshOpenFile(path, opts)`**：暴露给其它补丁/手工调用的入口；
   另有 `file://` 链接点击拦截 → 改走本机查看。

预览层：全屏覆盖层（`#dsh-fv`），文本/源码用 `iframe`（服务端 `text/plain`，浏览器按文本渲染）、
图片用 `img`（`naturalWidth` 实测 512）、目录/PDF 用 `iframe`；底部有"下载 / 新窗口"，
顶部"✕ 关闭 / ⟳ 重载"；硬件返回键（`__dshNativeBack`）先关预览层。

**失败必回落**：没有可用地址、预览层建不出来、路径为空、RPC 形态不认识 —— 任何一步都退回
原始请求（`orig.apply`），并计入 `fallbacks` 计数。调试开关：`?no-fileview=1`、
`window.__dshFileView.enable()/disable()/state()`。

---

## 3. 验证输出（证据文件在 `_fv_evidence/`）

### 3.1 接口与越权（`_fv_verify.txt`，**41/41 PASS**，裸 socket 取原始报文）

```
== /f text (markdown) ==            <WORKSPACE>\docs\REPORT_20261004_summary.md
  status: HTTP/1.1 200 OK
  content-type: text/markdown; charset=utf-8
  content-disposition: inline; filename="REPORT_20261004_summary.md"
  cache-control: no-store | nosniff: nosniff | content-length: 16703
  md first 200 bytes: b'# \xe6\x89\x8b\xe6\x9c\xba\xe7\xab\xaf DSH + YuAgent ...'   ← 正文开头正确
== /f png ==   HTTP/1.1 200 OK | image/png | inline ; magic b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR'
== /f py  ==   HTTP/1.1 200 OK | text/plain; charset=utf-8 | inline
== /f html ==  HTTP/1.1 200 OK | text/plain; charset=utf-8          ← 防 XSS：绝不当 HTML
== 越权（全部 403）==
  /f?path=..\..\Windows\win.ini              -> 403   (path traversal rejected)
  /f?path=C:\Windows\win.ini                 -> 403   (path outside the allowed roots)
  /f?path=<WORKSPACE>\..\..\Windows\win.ini -> 403
  /f?path=C%3A%5CWindows%5Cwin.ini           -> 403
  /f?path=..%5C..%5CWindows%5Cwin.ini        -> 403
  /f?path=D%3A%5Ccode%5Cyuagent%5C..%5C..%5CWindows%5Cwin.ini -> 403
  /f?path=<WORKSPACE>x\a.txt             -> 403   (前缀假冒)
  /d?path=C:\Windows                         -> 403
  /dl?path=C:\Windows\win.ini                -> 403
== 不存在文件 ==  HTTP/1.1 404 Not Found
== 无密钥 ==      HTTP/1.1 403 Forbidden
== 错密钥 ==      HTTP/1.1 403 Forbidden
== 目录列表 /d == 200 | text/html | 有 docs/ 链接、/f 链接、/dl 链接；/d 进子目录 200 且列出 md
== /dl ==        200 | attachment; filename="REPORT_20261004_summary.md"
== cookie 鉴权（不带 ?k=）== 200
== 桌面 UA 行为一致 == 200 | text/markdown; charset=utf-8
== 回归 ==  /__health 200 / /m/ 200 / /apk 200 / __hot/patch.js 200 / 完整版 200
            /?no-css=1 200 / /?no-adapt=1 200 / /?no-hot=1 200
== SUMMARY: 41/41 PASS ==
```

### 3.2 注入三态不受影响（`_fv_inject.txt`，**8/8 PASS**）

```
/?k=…              200  hot=True  adapt=True   92687 B
/?k=…&no-hot=1     200  hot=False adapt=True   92544 B   ← 只有热补丁标签消失
/?k=…&no-css=1     200  hot=True  adapt=True   88382 B   ← 自适应 CSS 少一份
/?k=…&no-adapt=1   200  hot=True  adapt=False  37345 B   ← 只保留热补丁
```

### 3.3 WS 101（`_fv_ws_regress.txt`）

```
WS upgrade /api/remote.mux -> HTTP/1.1 101 Switching Protocols   PASS
```

### 3.4 无头 Edge（手机 UA）端到端（`_fv_headless.txt`，**19/19 PASS**，**0 控制台错误**）

```
fileview state: {"on":true,"mobile":true,"hook":true,"key":"yes","errors":0}
open(md)  -> 覆盖层 flex，iframe src=…/f?path=…REPORT…md&k=…，正文 9160 字符，文本首行
             "# 手机端 DSH + YuAgent 运维改造 · 汇报摘要（v2 更新版）…"        截图 _fv_shot_md.png
open(png) -> img naturalWidth=512 naturalHeight=512                        截图 _fv_shot_png.png
open(py)  -> 源码文本正常（762 字符）
open(dir) -> 目录页 107 个链接，列表首行 "目录 <WORKSPACE> … 共 69 项"   截图 _fv_shot_dir.png
真实 RPC  -> POST /api/session/openWorkspacePath 被本地应答：
             {"result":{"ok":true,"value":{"opened":true}}}，taken=1，fallbacks=0，
             且预览层打开的就是该文件（覆盖层 src 指向 /f?path=…REPORT…md）
/open-in-app/open -> {"opened":true,"handledBy":"phone"}
workspacePathApplications -> {"ok":true,"value":[{"id":"phone","name":"本机（手机内查看）"…}]}
console error/exception entries: 0        SUMMARY: 19/19 PASS
```

### 3.5 防 XSS（`_fv_xss.txt`，**4/4 PASS**）

```
html opened as plain text    | text/plain
no script executed in viewer | scripts=0
viewer shows raw html source as text | "<!DOCTYPE html>"
raw /f html is text/plain    | text/plain; charset=utf-8
```

### 3.6 离线单测（`_fv_unit.txt` / `_fv_unit2.txt`，**12/12 + 41/41 PASS**）

在进程内直接调用抽取出来的处理函数（假 writer），核对状态行/头/正文，
并逐条覆盖越权路径、MIME 表、转义函数。处理函数 `_file_serve` 不依赖上游，
因此可在不打断手机的前提下先行验证。

### 3.7 进程与日志

```
proxy.py: 164451 B（备份 proxy.py.bak_fileview = 150130 B，diff：+339 / -0 行）
py_compile: 通过；`python -m py_compile proxy.py` OK
proxy 进程：PID 54072，2026-10-04 13:57:15 由 forward_watch.py 拉起（旧进程 9284 被杀）
重启后日志：无 handler error / 无 Traceback；每条文件请求都有
  "file /f <路径> -> N B <mime> (peer)" 审计行
手机侧：14:04:43 已从代理取到含本补丁的 /__hot/patch.js（27619 B）——热补丁已到手机
```

---

## 4. 未做项与原因

1. **Range / 断点续传**：未实现（明确标注为可选）。响应带 `Accept-Ranges: none`，
   预览与下载都是整文件流式返回；大文件（>100 MB）在手机浏览器上体验一般，但功能不缺。
2. **在真机（P40 WebView）上点按验证**：本会话只能驱动无头 Edge（手机 UA，较旧内核 内核同源）。
   真机侧唯一缺的是一次人手点按；但补丁文件已确认送达手机（日志有拉取记录），
   接管逻辑在"真实 RPC 形态"上已用同一内核验证通过。**没有**新建会话、没有发消息。
3. **其它历史工作区未加入白名单**：在线会话 cwd 实测只有 `<WORKSPACE>`，
   因此只开这一个根；`D:\code\mirror`、`D:\滚木` 等旧 cwd 需要时用
   `DSH_FILE_ROOTS` 环境变量追加（有意不做成"自动读取所有会话 cwd"的宽口径）。
4. **未接管 DSH 自己的文件预览器**：左键单击文件仍走 DSH 内置预览（那是手机内渲染，本来就没问题）；
   只有"在应用/电脑上打开"这条委派链路被改成手机内查看。

---

## 5. 手机上怎么用（一句话）

**在手机上点文件的"在应用中打开"按钮（或任意触发打开文件的地方），现在会直接在手机里弹出页面内预览
（文本 / 图片 / PDF / 目录都能看，底部可下载）**；想直接翻工作区文件，用手机浏览器打开：

```
http://<TAILSCALE-IP>:19390/d?path=<WORKSPACE>&k=<cap.key>
```

（`<cap.key>` 就是平时登录用的那串访问密钥；点进任意子目录/文件即在本机查看。
首次带 `k=` 访问后代理会种下 `dshcap` cookie，之后的 `/f`、`/d`、`/dl` 链接都不用再带密钥。）

---

## 6. 证据文件

| 文件 | 内容 |
|---|---|
| `_fv_evidence/_fv_verify.txt` | 接口 + 越权 + 回归的原始报文（41/41 PASS） |
| `_fv_evidence/_fv_verify.py` | 上述验证脚本（裸 socket） |
| `_fv_evidence/_fv_inject.txt` | 注入三态开关证据（8/8 PASS） |
| `_fv_evidence/_fv_ws_regress.txt` | WS 101 证据 |
| `_fv_evidence/_fv_unit.txt` `_fv_unit2.txt` | 离线单测（12/12、41/41 PASS） |
| `_fv_evidence/_fv_headless.txt` `_fv_console.json` | 无头 Edge 手机 UA 端到端（19/19 PASS、0 控制台错误） |
| `_fv_evidence/_fv_xss.txt` | 防 XSS 验证（4/4 PASS） |
| `_fv_evidence/_fv_shot_md.png` `_fv_shot_png.png` `_fv_shot_dir.png` | 预览层截图（文本 / 图片 / 目录） |
| `_fv_evidence/_fv_patch_proxy.py` | `proxy.py` 的锚点增量补丁脚本（含 `py_compile` 失败自动回滚） |
| `proxy.py.bak_fileview` | 改动前的 `proxy.py` 备份 |
