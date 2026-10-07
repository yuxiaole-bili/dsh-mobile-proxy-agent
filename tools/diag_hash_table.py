# -*- coding: utf-8 -*-
"""算出 PC 侧的对照哈希：__DSH_BOOT__.rev 与每个客户端插件 URL 的 hash6。
手机打的 /__diag/rev<hash> 与 /__diag/e<idx>-<hash> 用它反查。"""
import json
import os
import re
import sys
import urllib.request

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
OUT = r"<REPO>\evidence\diag_hash_table.txt"


def hash6(s):
    h = 5381
    for ch in str(s or ""):
        h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
    return ("000000" + format(h, "x"))[-6:]


def get(path):
    req = urllib.request.Request("http://<PC-LAN-IP>:19390/" + path.lstrip("/"),
                                 headers={"Cookie": "dshcap=" + KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def main():
    page = get("/")
    i = page.find('globalThis["__DSH_BOOT__"]')
    k = page.find("{", i)
    depth = 0
    end = -1
    for n in range(k, len(page)):
        c = page[n]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = n + 1
                break
    boot = json.loads(page[k:end])
    entries = boot.get("entries") or []

    lines = []
    lines.append("PC __DSH_BOOT__.rev = %s   -> /__diag/rev%s" % (boot.get("rev"), hash6(boot.get("rev"))))
    lines.append("PC entries          = %d      -> /__diag/n%d" % (len(entries), len(entries)))
    lines.append("")
    lines.append("每个客户端插件 URL 的 hash6（手机若报脚本错误，会打 e<idx>-<hash>）：")
    for e in entries:
        pid = e.get("id", "")
        for u in {e.get("url", "")}:
            full = "/" + u
            lines.append("  %s  %s" % (hash6(full), pid))
    text = "\n".join(lines) + "\n"
    open(OUT, "w", encoding="utf-8", newline="\n").write(text)
    print(text[:1500])
    print("...\n表已写入 " + OUT)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
