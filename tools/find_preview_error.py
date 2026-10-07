# -*- coding: utf-8 -*-
"""从 __DSH_BOOT__ 拿到每个客户端插件的真实 URL，抓下来找"文件资源服务不可用"的来源。"""
import json
import os
import re
import sys
import urllib.request

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
NEEDLE = "文件资源服务不可用"
ESC = "".join("\\u%04x" % ord(c) for c in NEEDLE)
WANT = ("documentpreview", "sidebar-right", "sidebar-files", "client-resources",
        "ui-renderer", "ui-tool", "workspace-files", "ui-workspace")


def get(path):
    req = urllib.request.Request("http://<PC-LAN-IP>:19390/" + path.lstrip("/"),
                                 headers={"Cookie": "dshcap=" + KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    page = get("/").decode("utf-8", "replace")
    # __DSH_BOOT__ 里是一大坨 JSON，直接按括号配平截取（正则会被内部字符串里的 }; 骗到）
    entries = []
    i = page.find('globalThis["__DSH_BOOT__"]')
    if i >= 0:
        k = page.find("{", i)
        depth = 0
        end = -1
        for n in range(k, min(len(page), k + 4_000_000)):
            c = page[n]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = n + 1
                    break
        if end > k:
            try:
                boot = json.loads(page[k:end])
                entries = boot.get("entries") or []
                print("插件条目数:", len(entries), " boot rev:", boot.get("rev"))
            except Exception as ex:
                print("解析 __DSH_BOOT__ 失败:", ex)
        else:
            print("括号配平失败")
    else:
        print("HTML 里没有 __DSH_BOOT__（长度 %d）" % len(page))

    # 兜底：直接从 HTML 文本里抓每条插件 URL
    if not entries:
        for mm in re.finditer(r'"(plugins/\?\?[^"]+client\.js[^"]*)"', page):
            entries.append({"id": mm.group(1).split("??")[1].split("/")[0], "url": mm.group(1)})
        print("从文本兜底抓到条目:", len(entries))

    hits = []
    for e in entries:
        pid = e.get("id", "")
        if not any(w in pid for w in WANT):
            continue
        url = e.get("url", "")
        try:
            data = get("/" + url)
        except Exception as ex:
            print("  抓取失败 %-52s %s" % (pid, ex))
            continue
        s = data.decode("utf-8", "replace")
        found = []
        if NEEDLE in s:
            found.append("literal")
        if ESC in s:
            found.append("escaped")
        print("  %-52s %7d B  含该提示: %s" % (pid, len(data), ",".join(found) or "no"))
        if found:
            k = s.find(NEEDLE)
            if k < 0:
                k = s.find(ESC)
            hits.append((pid, s[max(0, k - 600):k + 260]))
    print()
    for pid, ctx in hits[:3]:
        print("=== 来源：%s ===" % pid)
        print(ctx.replace("\n", " ")[:900])
        print()
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
