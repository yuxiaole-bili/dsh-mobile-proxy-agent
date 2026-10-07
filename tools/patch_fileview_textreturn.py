# -*- coding: utf-8 -*-
"""修 50-fileview.js：文本/代码模式必须提前返回，不能再落到"设置 frameEl.src"那段公共尾巴上。

现象（真机截图）：先看过图片，再点 .py 文件，浮层里显示
"打不开这个图片（可能不在允许的目录里）· tool/game/mesh_check.py" —— 代码没显示出来。
原因：show() 的公共尾巴仍执行 `frameEl.src = url`，把 .py 的 URL 塞给了上一次残留的 <img>，
img 解码失败触发 onerror -> setStatus(...) -> 按新逻辑把文本层也隐藏了。
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

FILE = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "hotpatch", "50-fileview.js")
TS = time.strftime("%Y%m%d-%H%M%S")

OLD = """      if (isText) {
        showText(url);
      } else if (isImg) {
"""

NEW = """      if (isText) {
        /* 文本/代码：只走文本层并**立即返回** —— 绝不能落到下面那段公共尾巴，
           否则会把 .py 的 URL 塞给上一次残留的 <img>，解码失败报"打不开这个图片"盖住代码。 */
        if (frameEl) { frameEl.style.display = "none"; }
        statusEl.style.display = "none";
        root.style.display = "flex";
        showText(url);
        return true;
      }
      if (isImg) {
"""


def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def main():
    s = open(FILE, encoding="utf-8", newline="").read()
    if "绝不能落到下面那段公共尾巴" in s:
        print("already fixed")
        return 0
    n = s.count(OLD)
    if n != 1:
        print("ABORT: anchor occurs %d times (want 1)" % n)
        return 1
    before = md5(FILE)
    s2 = s.replace(OLD, NEW, 1)
    bak = FILE + ".bak_textreturn_" + TS
    shutil.copy2(FILE, bak)
    open(FILE, "w", encoding="utf-8", newline="\n").write(s2)
    print("50-fileview.js %d -> %d B  md5 %s -> %s" % (len(s.encode("utf-8")), len(s2.encode("utf-8")), before, md5(FILE)))
    print("backup: %s" % os.path.basename(bak))
    r = subprocess.run(["node", "--check", FILE], capture_output=True, text=True)
    print("node --check rc=%d %s" % (r.returncode, (r.stdout + r.stderr).strip()[:200]))
    if r.returncode != 0:
        shutil.copy2(bak, FILE)
        print("!! 回滚")
        return 1
    shutil.copy2(FILE, r"<REPO>\establish\proxy\hotpatch\50-fileview.js")
    print("synced to repo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
