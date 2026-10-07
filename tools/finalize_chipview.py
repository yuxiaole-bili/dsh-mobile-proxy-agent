# -*- coding: utf-8 -*-
"""收尾：45-chipview.js / 代理相对路径补丁 / 验收脚本进仓库 + 报告补 §20 + MANIFEST。"""
import hashlib
import os
import shutil
import sys

HOT = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "hotpatch")
E = r"<REPO>\establish"
REPO_HOT = os.path.join(E, "proxy", "hotpatch")
W = r"<REPO>"
REPORT = r"<REPO>\REPORT_takeover.md"

SECTION = """
---

## 20. 文件预览改走自建预览层（2026-10-06，用户选定方案 1）

**背景**：DSH 自带的文档预览在手机上有两个死结 —— 窄屏右栏列宽 0、面板排到屏幕外（§15）；
手机端文件资源 provider 未注册、面板只显示"文件资源服务不可用"（§19）。
所以不再依赖它：**把会话里文件 chip 的点击接管过来**，走本仓库自己的轻量预览层。

**三处改动**：

| 文件 | 改动 |
|---|---|
| `proxy.py` | `/f` `/d` `/dl` 现在也接受**工作区相对路径**与**裸文件名**（新增 `_file_resolve_relative`）。安全边界不变：解析后仍须落在白名单根内、`..` 一律拒绝、裸名**唯一匹配**才放行、遍历有深度(≤4)与条目(≤20000)上限并跳过 `node_modules/.git/...` |
| `hotpatch/45-chipview.js`（新） | 捕获阶段监听 `button[class*="_fileLink"/"_fileMention"]` 的点击 → 取路径（`title` → 附近带目录的文本 → chip 文本）→ 调 `window.__dshFileView.open(path,{file:true})`；**只有预览真的打开成功才吃掉点击**，否则原样放行。**只在手机 UA 生效**，桌面浏览器不动 |
| 线上停用 | `30-rboverlay.js`（§18 事故源）与 `80-diag.js` 已改名停用，不再进链路 |

**实测（`evidence/chipview_test.txt`，13/13 PASS）**：

```
A 图片 chip（title 为空、只有文件名 t54_ortho3b.png）
  -> 我的浮层 display=flex，图片 x=0 w=360 全宽可见
  -> 请求 GET /f?path=t54_ortho3b.png&k=***（代理裸名解析 200 / 155,619 B / image/png）
  -> DSH 自带右栏预览未打开（rightbarCol 宽度 0）
B 文本 chip（LESSONS.md）-> 同样走我的浮层，接管计数 2
C 普通按钮点击不被吞（放行）
console 0 报错
```

代理侧直接验（`curl`）：`t54_ortho3b.png` / `out/t54_ortho3b.png` / 绝对路径 **全部 200**，
`no_such_file_xyz.png` **403**（不猜文件）。

**回滚**：删 `hotpatch/45-chipview.js`（或地址加 `?no-chipview=1`）；
代理回滚 `proxy.py.bak_relpath_20261006-142720`。

**追加（同日晚些时候）**：`30-rboverlay.js` 与 `80-diag.js` 保持停用状态，
文件名带 `.disabled_20261006-142438` 后缀；补丁包稳定在 43,234 B + 45-chipview。
"""


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def main():
    for name in ("45-chipview.js",):
        src = os.path.join(HOT, name)
        dst = os.path.join(REPO_HOT, name)
        if os.path.exists(dst):
            os.remove(dst)
        shutil.copy2(src, dst)
        print("synced hotpatch/%s (%d B)" % (name, os.path.getsize(dst)))

    for name in ("chipview_test.js", "patch_proxy_relpath.py", "finalize_incident.py"):
        src = os.path.join(W, name)
        if not os.path.exists(src):
            continue
        dst = os.path.join(E, "tools", name)
        if os.path.exists(dst):
            os.remove(dst)
        shutil.copy2(src, dst)
        print("copied tools/%s" % name)

    s = open(REPORT, encoding="utf-8", newline="").read()
    if "## 20. 文件预览改走自建预览层" in s:
        print("report already has §20")
    else:
        open(REPORT, "w", encoding="utf-8", newline="\n").write(s.rstrip("\n") + "\n" + SECTION)
        print("report §20 appended")

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
