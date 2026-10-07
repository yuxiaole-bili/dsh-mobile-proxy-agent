# -*- coding: utf-8 -*-
"""功能层测试：从三个插件的 host 半边里找出注册的 HTTP 路由并逐个请求。"""
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request

HOME = os.environ["USERPROFILE"]
NM = os.path.join(HOME, ".dsh", "profiles", "desktop", "node_modules")
FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = io.open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
TARGETS = ["dsh-context", "dsh-better-sidebar", "dsh-plugin"]


def http(path, method="GET"):
    req = urllib.request.Request("http://127.0.0.1:19387" + path, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read(400)
            return r.status, len(body), body[:120].decode("utf-8", "replace").replace("\n", " ")
    except urllib.error.HTTPError as e:
        return e.code, 0, ""
    except Exception as ex:
        return "ERR", 0, str(ex)[:80]


def routes_of(pkg_dir):
    """在 host 半边里找 webServer.register({ ... path: '...' })"""
    out = set()
    for dp, dn, fn in os.walk(pkg_dir):
        dn[:] = [d for d in dn if d != "node_modules"]
        for f in fn:
            if not f.endswith(".js"):
                continue
            p = os.path.join(dp, f)
            try:
                if os.path.getsize(p) > 4 * 1024 * 1024:
                    continue
                s = io.open(p, encoding="utf-8", errors="replace").read()
            except Exception:
                continue
            for m in re.finditer(r"path:\s*[`'\"]([^`'\"]+)[`'\"]", s):
                v = m.group(1)
                if v.startswith("/"):
                    out.add(v)
    return sorted(out)


def main():
    total = 0
    for name in TARGETS:
        d = os.path.join(NM, name)
        pj = os.path.join(d, "package.json")
        if not os.path.isfile(pj):
            print("%-22s 未安装" % name)
            continue
        ver = json.load(io.open(pj, encoding="utf-8")).get("version")
        rs = routes_of(d)
        print("=== %s v%s ===  host 路由 %d 条" % (name, ver, len(rs)))
        for r in rs[:14]:
            st, n, head = http(r)
            total += 1
            flag = "OK " if st == 200 else ("-- " if st in (401, 403, 404, 405, 501) else "!! ")
            print("   %s %-42s -> %s %s %s" % (flag, r, st, ("%dB" % n) if n else "", head[:60]))
        if not rs:
            print("   （没有注册 HTTP 路由，属于纯客户端/纯服务型插件）")
        print()
    print("共探测 %d 条路由" % total)
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
