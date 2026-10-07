# -*- coding: utf-8 -*-
"""测试 profile 里安装的第三方插件：
   1) manifest（dsh.bundle.patch / dsh.client / 入口文件是否存在）
   2) 是否真的进了 DSH 的启动清单 __DSH_BOOT__.entries
   3) 客户端半边能不能取到（HTTP 200、大小）
   4) cordis.patch.yml 里有没有覆盖/禁用行
   5) 顺带列出所有非 @deepseek-ai 的第三方插件条目
"""
import html
import io
import json
import os
import re
import sys
import urllib.request

HOME = os.environ["USERPROFILE"]
PROFILE = os.path.join(HOME, ".dsh", "profiles", "desktop")
NM = os.path.join(PROFILE, "node_modules")
FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = io.open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
TARGETS = ["dsh-context", "dsh-better-sidebar", "dsh-plugin"]


def get(path):
    req = urllib.request.Request("http://<PC-LAN-IP>:19390/" + path.lstrip("/"),
                                 headers={"Cookie": "dshcap=" + KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def boot_entries(page):
    i = page.find('globalThis["__DSH_BOOT__"]')
    if i < 0:
        return []
    k = page.find("{", i)
    depth = 0
    for n in range(k, len(page)):
        c = page[n]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(page[k:n + 1]).get("entries") or []
                except Exception:
                    return []
    return []


def main():
    page = get("/")
    entries = boot_entries(page)
    ids = [e.get("id", "") for e in entries]
    print("DSH 启动清单：%d 个客户端插件\n" % len(entries))

    third = [e for e in entries if not str(e.get("id", "")).startswith("@deepseek-ai/")]
    print("非 @deepseek-ai 的第三方插件（%d 个）：" % len(third))
    for e in third:
        print("   %-34s rev=%s" % (e.get("id"), e.get("rev")))
    print()

    patch_txt = ""
    p = os.path.join(PROFILE, "cordis.patch.yml")
    if os.path.isfile(p):
        patch_txt = io.open(p, encoding="utf-8", errors="replace").read()

    ok_all = True
    for name in TARGETS:
        print("=" * 68)
        d = os.path.join(NM, name)
        pj = os.path.join(d, "package.json")
        if not os.path.isfile(pj):
            print("%-22s 未安装" % name)
            ok_all = False
            continue
        m = json.load(io.open(pj, encoding="utf-8"))
        dsh = m.get("dsh") or {}
        print("%-22s v%s" % (m.get("name"), m.get("version")))
        print("   main            : %s" % m.get("main"))
        print("   exports         : %s" % list((m.get("exports") or {}).keys()))
        print("   dsh.bundle.patch: %s" % ((dsh.get("bundle") or {}).get("patch")))
        print("   dsh.client      : %s" % dsh.get("client"))
        print("   meta            : %s" % m.get("meta"))
        # 入口文件存在性
        for key, rel in (("main", m.get("main")), ("client", (m.get("exports") or {}).get("./client"))):
            if not rel:
                continue
            if isinstance(rel, dict):
                rel = rel.get("default")
            fp = os.path.join(d, str(rel))
            print("   %-15s : %s %s" % (key, rel, "存在" if os.path.isfile(fp) else "**缺失**"))
            if not os.path.isfile(fp):
                ok_all = False
        # 是否进了启动清单（客户端半边）
        cid = [i for i in ids if i == name or i.startswith(name + "/")]
        print("   在启动清单里    : %s" % (cid if cid else "否（没有客户端半边，或是纯 host 插件）"))
        # 客户端模块能否取到
        if cid:
            e = [x for x in entries if x.get("id") == cid[0]][0]
            url = e.get("url", "")
            try:
                data = get("/" + html.unescape(url))
                print("   客户端包        : %d B  %s" % (len(data), url[:70]))
            except Exception as ex:
                print("   客户端包        : **取不到** %s" % ex)
                ok_all = False
        # patch 里的行
        rows = [l.strip() for l in patch_txt.splitlines() if name in l or (m.get("name", "") in l)]
        print("   cordis.patch 行 : %s" % (rows[:3] if rows else "无（用自带 patch 或未插入）"))
        # 自带 patch 内容
        bp = (dsh.get("bundle") or {}).get("patch")
        if bp:
            f = os.path.join(d, str(bp))
            if os.path.isfile(f):
                txt = io.open(f, encoding="utf-8", errors="replace").read().strip()
                print("   自带 patch      : %s" % txt.replace("\n", " | ")[:160])
            else:
                print("   自带 patch      : **缺失** %s" % bp)
                ok_all = False
    print("=" * 68)
    print("结论:", "基本正常" if ok_all else "**有问题，见上面标记**")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
