# -*- coding: utf-8 -*-
"""把 patch_fileview_highlight.py 里的内嵌 HL 字符串换成"读取 hl_block.js"。"""
import io
import sys

P = r"<REPO>\patch_fileview_highlight.py"
START = "HL = r'''"
END = "\nANCHOR_A = "

def main():
    s = io.open(P, encoding="utf-8", newline="").read()
    i = s.find(START)
    j = s.find(END)
    if i < 0 or j < 0 or j < i:
        print("anchors not found: i=%d j=%d" % (i, j))
        return 1
    new = ('HL = io.open(r"<REPO>\\hl_block.js", encoding="utf-8").read()\n')
    s2 = s[:i] + new + s[j:]
    if "import io" not in s2:
        s2 = s2.replace("import hashlib", "import hashlib\nimport io", 1)
    io.open(P, "w", encoding="utf-8", newline="\n").write(s2)
    print("patched: HL now read from hl_block.js (removed %d chars)" % (j - i - len(new)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
