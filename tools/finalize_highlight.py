# -*- coding: utf-8 -*-
"""收尾：高亮版 50-fileview.js + hl_block.js + 测试进仓库，报告补 §21，重生成 MANIFEST。"""
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

## 21. 代码文件上色（2026-10-06，用户要求"打开代码文件需要具备上色功能"）

**原来**：预览层对非图片文件是丢给 `<iframe>` 直接显示纯文本（浏览器默认样式，没有颜色）。

**现在**：代码/文本类文件改成"**取回文本 → 自己着色 → 渲染到 `<pre>`**"。

| 项 | 说明 |
|---|---|
| 实现 | `hotpatch/50-fileview.js` 内置 tokenizer（源码块备份在 `tools/hl_block.js`），**不引第三方库、不联网** |
| 着色维度 | 注释 / 字符串（含 Python 三引号 docstring、模板串）/ 数字 / 关键字 / 类型(大写开头) / 函数调用(后随 `(`) / 标点 |
| 语言表 | Python、Shell/PowerShell/Bat、JSON、YAML/TOML/INI、Markdown、HTML/XML/Vue/Svelte、CSS/SCSS、SQL，其余 C 系（js/ts/java/go/rs/c/cpp/cs/kt/swift/php…）走同一套关键字表 |
| 专门规则 | Markdown：标题/围栏代码块/行内码/粗体/链接/引用/列表；HTML-XML：注释/标签名/属性名/属性值 |
| 标题 | 显示 `文件名 · 语言`（如 `section.py · Python`） |
| 换行开关 | 底部新增「换行」按钮（`pre` ↔ `pre-wrap`），手机上读长行代码用得上 |
| 大文件保护 | 超过 400 KB 只着色前 400 KB，并提示"文件较大" |
| 失败兜底 | 高亮函数抛异常时退回纯转义文本（不白屏）；取文件失败显示错误 + 文件名 |

**实测**（`evidence/highlight_test.txt`，**15/15 PASS**，360×780 无头 + 合成 chip）：

```
A section.py（裸文件名）-> 浮层 display=flex、标题 "section.py · Python"
   着色 span 共 2351 个：关键字 240 / 字符串 63 / 注释 11 / 数字 192 / 类型 25 / 函数 128 / 标点 1081
B 「换行」按钮：white-space pre -> pre-wrap，再点回 pre
C LESSONS.md -> 标题 "LESSONS.md · Markdown"，488 个 span（标题 46 / 粗体 190 / 代码 130 / 关键字 120）
D 图片回归：仍走 <img>（x=0 w=360），文本层自动隐藏
console 0 报错
```

**性能**：单次正则在 10 KB 源文件上毫秒级；400 KB 上限避免手机上卡顿。

**回滚**：`hotpatch/50-fileview.js.bak_hl_20261006-144539`。
"""


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def main():
    src = os.path.join(HOT, "50-fileview.js")
    dst = os.path.join(REPO_HOT, "50-fileview.js")
    shutil.copy2(src, dst)
    print("synced hotpatch/50-fileview.js (%d B)" % os.path.getsize(dst))

    for name in ("hl_block.js", "highlight_test.js", "patch_fileview_highlight.py",
                 "finalize_chipview.py", "fix_patch_script.py"):
        s = os.path.join(W, name)
        if not os.path.exists(s):
            continue
        t = os.path.join(E, "tools", name)
        if os.path.exists(t):
            os.remove(t)
        shutil.copy2(s, t)
        print("copied tools/%s" % name)

    s = open(REPORT, encoding="utf-8", newline="").read()
    if "## 21. 代码文件上色" in s:
        print("report already has §21")
    else:
        open(REPORT, "w", encoding="utf-8", newline="\n").write(s.rstrip("\n") + "\n" + SECTION)
        print("report §21 appended")

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
