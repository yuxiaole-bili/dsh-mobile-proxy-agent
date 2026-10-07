# -*- coding: utf-8 -*-
"""测 dsh-mobile-kit 的 client 半边：
   1) 它有没有进 DSH 的启动清单 __DSH_BOOT__.entries
   2) 客户端包能不能取到
   3) （配合无头浏览器脚本）页面里 window.__dshMobileKit 是否存在
"""
import html
import io
import json
import os
import re
import sys
import urllib.request

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = io.open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()


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
    print("启动清单：%d 个客户端插件，boot rev=%s" % (len(entries), boot.get("rev")))
    hit = [e for e in entries if "mobile" in str(e.get("id", "")).lower()]
    print("含 mobile 的条目：%d" % len(hit))
    for e in hit:
        print("   ", json.dumps(e, ensure_ascii=False)[:200])
    if not hit:
        print("   ❌ client 半边没有进启动清单（说明 loader 没从 package.json 读到 dsh.client）")
        return 1
    url = hit[0].get("url", "")
    try:
        data = get("/" + html.unescape(url))
        print("客户端包: %d B  %s" % (len(data), html.unescape(url)[:80]))
        for probe in ("__ModuleLoader__.load", "dsh-mobile-kit", "withResolvers", "dsh-mobile-kit-css"):
            print("   含 %-22s : %s" % (probe, probe in data))
    except Exception as ex:
        print("客户端包取不到:", ex)
        return 1
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
