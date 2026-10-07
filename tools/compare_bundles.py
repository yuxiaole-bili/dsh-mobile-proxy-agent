# -*- coding: utf-8 -*-
"""比对：当前 DSH 页面要的客户端插件包 URL vs APK 里预装的 URL。
（预装只在 URL 完全相同时命中；否则手机会去服务器取新的。）"""
import html
import json
import os
import re
import sys
import urllib.request

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
PRELOAD = r"D:\code\dsh-android\appassets\index.json"


def fetch(path):
    req = urllib.request.Request("http://<PC-LAN-IP>:19390" + path,
                                 headers={"Cookie": "dshcap=" + KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def main():
    page = fetch("/")
    print("HTML bytes:", len(page))
    cur = [html.unescape(u) for u in re.findall(r'src="(/plugins/\?\?[^"]+)"', page)]
    print("\n=== 当前页面里的 /plugins/?? URL：%d 条 ===" % len(cur))
    for u in cur:
        print("  len=%d  模块数=%d" % (len(u), len(u.split("??", 1)[1].split(","))))

    pre = json.load(open(PRELOAD, encoding="utf-8"))
    prek = [k for k in pre if k.startswith("/plugins/??")]
    print("\n=== APK 预装的 /plugins/?? URL：%d 条 ===" % len(prek))
    for k in prek:
        print("  len=%d  模块数=%d" % (len(k), len(k.split("??", 1)[1].split(","))))

    if not cur or not prek:
        print("\n(无法比对)")
        return 1

    # 用"模块集合"比对（URL 里模块顺序/组合可能随时变）
    cset = set()
    for u in cur:
        cset |= set(u.split("??", 1)[1].split(","))
    aset = set()
    for k in prek:
        aset |= set(k.split("??", 1)[1].split(","))

    print("\n当前模块总数=%d  APK 预装模块总数=%d" % (len(cset), len(aset)))
    missing = sorted(cset - aset)
    extra = sorted(aset - cset)
    print("\n=== 当前需要、但 APK 预装里没有的客户端模块（手机会拿不到）=== %d 个" % len(missing))
    for n in missing:
        print("   +", n)
    print("\n=== APK 预装多出来的 === %d 个" % len(extra))
    for n in extra:
        print("   -", n)

    same = set(cur) & set(prek)
    print("\nURL 完全相同的条数：%d / 当前 %d 条" % (len(same), len(cur)))
    for u in cur:
        hit = u in pre
        print("  %s  %s" % ("命中预装" if hit else "**未命中**", u[:90]))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
