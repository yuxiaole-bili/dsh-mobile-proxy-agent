# -*- coding: utf-8 -*-
"""给 50-fileview.js 的预览层加"代码上色"。

做法：代码/文本类文件不再丢给 iframe 显示纯文本，而是取回文本、**自己着色**后渲染到 <pre>。
用户要求："打开代码文件需要具备上色功能"。
纯手写 tokenizer（不引第三方库、不联网）：注释 / 字符串 / 数字 / 关键字 / 类型 / 函数 / 标点，
Markdown 与 HTML/XML 走专门规则。文件 > 400 KB 只着色前 400 KB（手机端保护）。
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys
import time

FILE = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "hotpatch", "50-fileview.js")
TS = time.strftime("%Y%m%d-%H%M%S")

HL = io.open(r"<REPO>\hl_block.js", encoding="utf-8").read()

ANCHOR_A = "  var IMG = /\\.(png|jpe?g|jfif|webp|gif|bmp|ico)$/i;\n  var PDF = /\\.pdf$/i;\n"
ANCHOR_B = '  var curUrl = "", curPath = "", isImg = false, isPdf = false;\n'
ANCHOR_C = "    isImg = IMG.test(curPath); isPdf = PDF.test(curPath);\n"
ANCHOR_D = "      if (isImg) {\n"
ANCHOR_E = "    if (frameEl) { frameEl.style.display = \"none\"; }\n"
ANCHOR_F = "    foot.appendChild(pathEl); foot.appendChild(dl); foot.appendChild(ext); foot.appendChild(br);\n"


def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def sub_once(s, anchor, repl, label):
    n = s.count(anchor)
    if n != 1:
        raise SystemExit("ABORT: anchor %s occurs %d times (want 1)" % (label, n))
    print("  anchor OK  %-22s" % label)
    return s.replace(anchor, repl, 1)


def main():
    s = open(FILE, encoding="utf-8", newline="").read()
    if "dsh-hl-kw" in s:
        print("already patched")
        return 0
    before = md5(FILE)
    print("50-fileview.js %d B" % len(s.encode("utf-8")))

    s = sub_once(s, ANCHOR_A, ANCHOR_A + HL, "highlighter block")
    s = sub_once(s, ANCHOR_B, '  var curUrl = "", curPath = "", isImg = false, isPdf = false, isText = false;\n', "isText var")
    s = sub_once(s, ANCHOR_C,
                 "    isImg = IMG.test(curPath); isPdf = PDF.test(curPath);\n"
                 "    isText = !isImg && !isPdf && CODE_RE.test(curPath);\n", "isText calc")
    s = sub_once(s, ANCHOR_D, "      if (isText) {\n        showText(url);\n      } else if (isImg) {\n", "text branch")
    s = sub_once(s, ANCHOR_E,
                 "    if (frameEl) { frameEl.style.display = \"none\"; }\n"
                 "    if (textEl) { textEl.style.display = \"none\"; }\n", "setStatus hides text")
    s = sub_once(s, ANCHOR_F,
                 "    var wrapBtn = D.createElement(\"a\");\n"
                 "    wrapBtn.textContent = \"换行\"; wrapBtn.href = \"javascript:void(0)\";\n"
                 "    wrapBtn.setAttribute(\"data-dsh-fv\", \"wrap\");\n"
                 "    css(wrapBtn, { color: \"#7fb2ff\", fontSize: \"13px\", textDecoration: \"none\", padding: \"6px 4px\" });\n"
                 "    wrapBtn.onclick = function () { toggleWrap(); };\n"
                 "    foot.appendChild(pathEl); foot.appendChild(dl); foot.appendChild(ext); foot.appendChild(wrapBtn); foot.appendChild(br);\n",
                 "footer wrap button")

    # 打开图片/其它类型时，把文本层藏起来
    s = s.replace("      frameEl.style.display = \"block\";\n",
                  "      if (textEl) { textEl.style.display = \"none\"; }\n      frameEl.style.display = \"block\";\n", 1)

    for need in ("dsh-hl-kw", "showText(url)", "toggleWrap", "isText = "):
        if need not in s:
            raise SystemExit("ABORT: post-check missing " + need)

    bak = FILE + ".bak_hl_" + TS
    shutil.copy2(FILE, bak)
    open(FILE, "w", encoding="utf-8", newline="\n").write(s)
    print("  backup %s" % os.path.basename(bak))
    print("  md5 %s -> %s   bytes %d -> %d" % (before, md5(FILE), len(s.encode("utf-8")), os.path.getsize(FILE)))

    r = subprocess.run(["node", "--check", FILE], capture_output=True, text=True)
    print("  node --check rc=%d %s" % (r.returncode, (r.stdout + r.stderr).strip()[:200]))
    if r.returncode != 0:
        shutil.copy2(bak, FILE)
        print("  !! 回滚（语法不过）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
