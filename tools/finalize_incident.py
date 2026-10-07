# -*- coding: utf-8 -*-
"""收尾：记事故与修复 + 测试进仓库 + 重生成 MANIFEST。"""
import hashlib
import os
import shutil
import sys

E = r"<REPO>\establish"
REPORT = r"<REPO>\REPORT_takeover.md"
W = r"<REPO>"
TESTS = ["rboverlay_regression.js", "repro_preview.js", "diag_hash_table.py",
         "resolve_diag_hash.py", "find_preview_error.py", "compare_bundles.py"]

SECTION = """
---

## 18. 事故与修复：整页变空白（2026-10-06 14:0x，**我造成的**）

**现象**：手机刷新后整个界面空白（只剩右下角提示音按钮）。

**根因**：`30-rboverlay.js`（§15 的右栏全屏覆盖补丁）判据太松 —— 原来是
"右栏子树里出现 >24px 的 preview/document 节点，**或右栏文本 > 8 字符**"。
手机上 DSH 会**恢复上次打开的文档页签**，那个页签里正是 §16 的报错文案
"文件资源服务不可用"（11 字符 > 8）→ 判定为"有内容"→ 给 `<html>` 打上
`data-dsh-rb="1"` → 右栏变成**全屏覆盖层把整个界面盖住** → 看起来就是一片空白。

**修复**（`30-rboverlay.js`）：判据收紧为"必须**真实可见的内容**"——
- 有 ≥40×40 的可见 `img/iframe/video/canvas`，**或**
- 预览类容器（≥24×24）内有 **≥16 字符**正文（"文件资源服务不可用" 11 字，不算）

**回归测试**（`tools/rboverlay_regression.js`，专测这个事故场景）：

| 用例 | 结果 |
|---|---|
| A 全新加载、未开预览 → 标记必须为空、正文列可见 | PASS |
| B **右栏里只有"文件资源服务不可用"文案** → 标记仍须为空、正文列可见 | **PASS（本次事故场景）** |
| C 真打开图片预览 → 标记置 1 | PASS |
| D 关闭后端 → 标记撤销、界面回来 | PASS |

图片预览在收紧判据后仍正常：`evidence/repro_preview_after_strict.txt`
（`blobImg x=6 w=347`，面板显示 `t54_ortho3b.png D:\\code\\yuagent\\out\\t54_ortho3b.png 22%`）。

**教训**：给"覆盖整屏"这类高风险样式装触发器时，判据必须**只认真实内容**，
并且要专门写一条"最坏情况不得触发"的回归用例。

---

## 19. "文件资源服务不可用"的追查记录（未结案，已排除多条）

那句话来自 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`：
`meta.status === "none" ? t("resourceUnavailable") : <Loading/>`；
而 `"none"` 在 `@deepseek-ai/dsh-client-resources` 里只有一个来源：
`providerOf(protocol) === undefined` —— **没有 provider 注册到 `dsh-resource://file/…` 的 `file` 协议**。

provider 由 `@deepseek-ai/dsh-api-workspace-files` 的客户端半边注册：

```js
const inject = ["resources", "remote", "remote.workspaceFiles"];
function apply(ctx) { ctx.effect(() => ctx.resources.register(createFileResourceProvider(ctx.remote, changes))); }
```

→ 只要 `remote.workspaceFiles` 这个服务没出现，`apply` 就永远不会被调用。

**已排除（均有实测证据）**：

| 假设 | 证据 |
|---|---|
| 手机跑旧插件清单 | 诊断信标 `/__diag/rev9f35f1` + `/__diag/n71` 与 PC **完全一致** |
| 文件不存在/服务端问题 | 文件在（155,619 B）；PC 上同一 chip 正常出图（`readBytes`+`stat`+blob） |
| 安全上下文差异 | PC 同样 `isSecureContext:false / subtle:false`（`/__diag/ctx000100` vs 手机 `ctx001100`，仅差我们自己的 mediaDevices shim） |
| 手机缺请求 | 启动请求集与 PC 一致（预装的 3 个合并插件包 + 4 个 assets 全部命中） |
| 脚本加载失败 | 无资源加载错误；唯一"错误"是 `ResizeObserver loop limit exceeded`（良性通知，误报） |
| polyfill 没跑到 | `/__diag/pf1101`：`withResolvers`/`AbortSignal.any` 都就绪、`dsh-polyfill` 在 |
| `__DSH_BOOT_READY__` 缺失 | **误报**：它在 PC 上也不是 promise（`Promise.withResolvers()` 返回 `{promise,resolve,reject}`），两边一致 |

**下一步候选**：怀疑是 `remote.workspaceFiles` 这个服务在手机端未就绪（可能与会话/握手时机有关）。
替代方案（不依赖该 provider）：把会话里的文件 chip 点击改成走本仓库自己的预览层
（`50-fileview.js` + 代理 `/f`），代理需要支持工作区相对路径与按文件名唯一匹配。
"""


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def main():
    for name in TESTS:
        src = os.path.join(W, name)
        if not os.path.exists(src):
            print("missing " + name)
            continue
        dst = os.path.join(E, "tools", name)
        if os.path.exists(dst):
            os.remove(dst)
        shutil.copy2(src, dst)
        print("copied " + name)

    s = open(REPORT, encoding="utf-8", newline="").read()
    if "## 18. 事故与修复：整页变空白" in s:
        print("report already has §18")
    else:
        open(REPORT, "w", encoding="utf-8", newline="\n").write(s.rstrip("\n") + "\n" + SECTION)
        print("report §18/§19 appended")

    lines = ["# establish 仓库清单（自动生成）", ""]
    n = 0
    for dp, dn, fn in sorted(os.walk(E)):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git", "evidence", "__pycache__")]
        for f in sorted(fn):
            if f == "MANIFEST.txt":
                continue
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, E).replace("\\", "/")
            lines.append("%s  %8d B  sha256=%s" % (rel, os.path.getsize(p), sha256(p)[:16]))
            n += 1
    open(os.path.join(E, "MANIFEST.txt"), "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
    print("MANIFEST: %d files" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
