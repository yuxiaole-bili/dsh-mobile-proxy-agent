# 安装与配置

本仓库有三层，**可以只用其中一层或两层**（见 `ARCHITECTURE.md` 的对照表）。

---

## A. 反向代理（推荐先跑通这一层）

零 DSH 改动：它在 DSH 前面加一个 HTTP 代理，把移动端需要的注入、瘦身、缓存、文件接口都做了。

### 依赖
- Windows（脚本按 Windows 写；代理本体是纯 Python，理论上跨平台）
- Python 3.9+（无第三方依赖）

### 起步

```powershell
# 1) 准备目录（默认放 %LOCALAPPDATA%\dsh-gui-forward，也可以用环境变量改）
$T = "$env:LOCALAPPDATA\dsh-gui-forward"
New-Item -ItemType Directory -Path $T -Force | Out-Null
Copy-Item proxy\proxy.py            $T\
Copy-Item proxy\forward_watch.py    $T\
Copy-Item proxy\mobile.html         $T\      # 可选：轻量页
Copy-Item -Recurse proxy\hotpatch   $T\      # 可选：热补丁
Copy-Item proxy\restart_svc.cmd     $T\      # 可选：远程重启通道

# 2) 生成访问密钥（32 位随机串）
python -c "import secrets;open(r'$T\cap.key','w').write(secrets.token_urlsafe(24))"

# 3) 跑起来
python $T\proxy.py
```

默认监听 `0.0.0.0:19390` → 上游 `127.0.0.1:19387`（DSH 自己的 web 服务）。
用环境变量覆盖：

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_LISTEN_HOST` | `0.0.0.0` | 监听地址（想只绑单网卡就填具体 IP） |
| `DSH_LISTEN_PORT` | `19390` | 监听端口 |
| `DSH_HOTPATCH` | 开 | `0` 关掉热补丁注入 |
| `DSH_PAGE_MAX_MESSAGES` | `10` | 首屏消息条数上限 |
| `DSH_REQ_BUFFER_MIN` | `262144` | 大于此值的请求体先收完再转发（修"发图片被吞"） |
| `DSH_REQ_BUFFER_MAX` | `16777216` | 超过此值退回"边收边转"（避免吃内存） |
| `DSH_FILE_ROOTS` | 会话工作区 | 只读文件接口额外允许的根目录（`;` 分隔） |

### 手机访问

```
http://<这台PC的局域网IP>:19390/?k=<cap.key 的内容>
```

第一次带 `?k=` 访问后，代理会种下 `dshcap` cookie，之后刷新不用再带。

### 守护（可选，但强烈建议）

`forward_watch.py` 用 `pythonw` 常驻，每 3 秒检查一次 `proxy.py`，掉了就拉起来：

```powershell
# 开机自启（HKCU Run）
$py = (Get-Command pythonw).Source
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'dsh-gui-forward' `
  -Value "`"$py`" `"$T\forward_watch.py`""
```

> 重启代理时**只杀 proxy.py**：
> ```powershell
> Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" |
>   Where-Object { $_.CommandLine -match 'proxy\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
> ```
> **不要**用 `-match "forward|proxy"`，那会把守护一起杀掉。

### 体检

```powershell
pwsh -File tools\healthcheck_mobile.ps1              # 全量（含无头渲染）
pwsh -File tools\healthcheck_mobile.ps1 -SkipHeadless # 快检
```

七段检查：进程 / 监听 / 54 项协议验收 / 热补丁包语法 / 体积 / **手机真实流量** /
无头渲染（模拟"先删 `Promise.withResolvers`"的 Chrome 114）。任一项不过 → 退出码 1。

---

## B. Android 壳

### 依赖（都可离线）
- JDK 17（例如 `D:\Android\jdk-17.0.2`）
- Android SDK `build-tools;34.0.0` + `platforms;android-34`
- Python 3（构建脚本用它往 APK 里塞 `classes.dex` 与预装资源）

### 构建

```powershell
# 改 build.ps1 顶部的 $JDK / $SDK 路径
powershell -File android\build.ps1
# 产物 android\out\DSH.apk
```

### 首次运行要填的两件事

APK 里 `DEFAULT_HOST` / `DEFAULT_KEY` **是占位符，必须自己填**：
打开 App → 「诊断与设置」→ 服务器设置 → 填 `<PC的IP或Tailscale地址>:19390` 与你的访问密钥。

### 双模线路（局域网 / VPN 自动切换）

主界面 →「线路（局域网 / VPN 自动切换）」：

- 逐条列出候选地址与实测延迟（`● 当前` / `○ 其它` / `不可达`）
- 自动选择 / 手动切换 / 重新探测 / 编辑候选地址

默认候选 = 你填的地址 + `<PC-LAN-IP>:19390` + `<SRV-LAN-IP>:19390`（后两个是示例网段，
**请改成你自己的**）。切换 = 换 host 重载页面；服务端会话数据不受影响。

> **并发注意**：切换会换 origin，App 的前端状态（"上次打开的会话"）会重置。想要零重载切换，
> 需要固定一个主机名（例如让路由器 DNS 或 Tailscale MagicDNS 把它解析到当前最快的地址）。

---

## C. DSH 插件

见 `docs/PLUGIN.md`（待调研结论落地后补齐：插件放哪、清单怎么写、怎么启用）。
