# 发布清单（开源前逐项确认）

## 一、必须先过（自动化）
```powershell
python tools/security_audit.py        # 密钥/地址泄露 + 缓存与内存
python tools/final_security_check.py  # 命中明细 + 线上/仓库一致性
```
要求：**仓库命中 0**。CI（`.github/workflows/secret-scan.yml`）会在每次 push 自动跑。

## 二、绝不入库的东西
- `cap.key` 或任何 capability key / cookie / token
- 真实 IP（内网、Tailscale、公网）、主机名、用户名
- `evidence/`（含运行日志，可能带路径与会话内容）
- `*.bak_*`（历史备份里常有改前的真实值）
- 手机截图（含会话正文）

## 三、发布步骤
```bash
cd establish
git init
git add -A
git status                    # 逐项确认没有敏感文件
git commit -m "dsh-mobile-proxy-agent: 手机端 DSH 代理与交互层"
git branch -M main
git remote add origin https://github.com/yuxiaole-bili/dsh-mobile-proxy-agent.git
git push -u origin main
```

## 四、发布后
- 仓库设置里开启 **Secret scanning** 与 **Push protection**
- 确认 LICENSE 与包名（`plugin/package.json` 的 `name` 需全局唯一）
- 首次 Release 打 tag：`git tag v0.2.0 && git push --tags`

## 五、已知边界（写进 README，避免误导）
- 这套东西是**给个人自用**的：代理靠单一 capability key 鉴权，key 泄露等于主机命令执行权
- 不要部署到公网；只在可信局域网/Tailscale 内使用
- 无多用户、无审计、无限流

## 六、远端（本仓库主推 GitHub）

```bash
git remote -v
# 必须是这一条：
# origin  https://github.com/yuxiaole-bili/dsh-mobile-proxy-agent.git (fetch/push)

# 若 origin 指向别处（例如 Gitee），改回来：
git remote set-url origin https://github.com/yuxiaole-bili/dsh-mobile-proxy-agent.git

# 若 GitHub 上仓库是"非空"创建的（勾了 README/.gitignore/license），
# push 会被拒（non-fast-forward），用：
git pull --rebase origin main
# 或者仓库是全新的、以本地为准：
git push -u origin main --force-with-lease
```

> 注意：PC 无外网时 `git push` 必然失败，先挂梯子。

## 七、打标签发布（CI 自动出 Release）

推完 `main` 之后再打标签，GitHub Actions 会**自动**创建 Release，说明从 `CHANGELOG.md` 抽取：

```bash
git tag v0.2.0
git push origin v0.2.0
```

- 标签形如 `v0.2.0` → 正常 Release；带 `alpha`/`beta`/`rc` → 自动标为 **pre-release**
- 抽取规则：取 `CHANGELOG.md` 里与标签同名的 `## <版本>` 段（如 `## 0.2.0 (2026-10-07)`）
- 工作流文件：`.github/workflows/release.yml`（也可在 Actions 页面手动触发并指定已存在的标签）

## 八、APK 怎么上 Release

打标签时 `.github/workflows/android.yml` 会构建 APK 并**自动挂到该标签的 Release**：

```bash
git tag v0.2.1
git push origin v0.2.1
```

**给已存在的旧 Release 补挂 APK**（例如 v0.2.0 当时没配这个工作流）：
Actions → `android` → Run workflow → 填标签 `v0.2.0` → 运行。

### 签名

- 默认用**自动生成的 debug keystore**（口令 `android`）签名 —— 能装能用，但**每次构建签名不同**，
  覆盖安装会失败（需先卸载）。仅适合自用/尝鲜。
- 想让升级签名一致：把你本地的 keystore 转 base64 存成仓库 Secrets（Settings → Secrets → Actions）：

  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\code\dsh-android\debug.keystore"))
  ```
  然后添加 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KS_PASS`、`ANDROID_KEY_PASS`、`ANDROID_KS_ALIAS`
  四个 Secrets。工作流检测到 `ANDROID_KEYSTORE_BASE64` 就改用你的固定签名。

> ⚠️ keystore 是签名私钥，**只放进 Secrets**，永远不要提交进仓库（`.gitignore` 已排除 `*.keystore`）。

### 本地构建

```powershell
# Windows（原脚本）
pwsh -File android\build.ps1
```
```bash
# Linux / macOS / Git-Bash / WSL（与 CI 同一脚本）
export JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk
bash android/build.sh
```

### 关于 APK 体积（appassets/ 已随仓库提供）

`appassets/`（离线预装资源，约 13 MB）已随仓库提供，因此 **CI 与本地产出的都是完整版**（约 5.4 MB）。

| 构建方式 | 体积 | 行为 |
|---|---|---|
| CI（仓库源码 + appassets/） | ~5.4 MB | 首屏用**预装资源**，离线也能起 |
| 本地 `build.ps1` | ~5.4 MB | 同上 |

预装资源变更时重新生成并提交 `appassets/` 即可。
