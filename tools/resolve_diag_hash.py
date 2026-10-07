# -*- coding: utf-8 -*-
"""反查手机报的脚本错误哈希 bdca1d —— 手机上的 ev.target.src 是绝对 URL，
   而且主机是 <TAILSCALE-IP>:19390，所以要把各种可能形态都算一遍。"""
import json
import os
import re
import sys
import urllib.request

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
TARGET = "bdca1d"


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
    hosts = ["http://<TAILSCALE-IP>:19390", "http://<PC-LAN-IP>:19390", ""]
    cands = []

    # 1) 页面本身
    for h in hosts:
        cands.append(h + "/")
        cands.append(h + "/?k=" + KEY)
    # 2) 页面里出现的所有 src/href
    for m in re.finditer(r'(?:src|href)="([^"]+)"', page):
        u = m.group(1).replace("&amp;", "&")
        for h in hosts:
            cands.append(h + "/" + u.lstrip("/"))
            cands.append(u)
    # 3) __DSH_BOOT__ 里的每个插件 URL（相对形态与绝对形态）
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
    for e in boot.get("entries") or []:
        u = e.get("url", "")
        for h in hosts:
            cands.append(h + "/" + u)
            cands.append(u)
            cands.append("/" + u)

    seen = set()
    hits = []
    for c in cands:
        if c in seen:
            continue
        seen.add(c)
        if hash6(c) == TARGET:
            hits.append(c)
    print("候选数:", len(seen))
    print("命中 bdca1d 的候选:", len(hits))
    for h in hits[:10]:
        print("   ", h[:150])
    if not hits:
        print("\n没命中 —— 说明错误来自资源以外的来源（例如 JS 运行时错误的消息文本）。")
        print("最可能是 message 形态；下面列出常见候选：")
        for msg in ["Script error.", "Uncaught (in promise)", "Load failed", "NetworkError when attempting to fetch resource."]:
            print("   %s -> %s" % (hash6(msg), msg))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
