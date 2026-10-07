# -*- coding: utf-8 -*-
"""把 insert 行的 name 从"目录"改成"入口文件"，然后重测 host 路由。"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

PROFILE = os.path.join(os.environ["USERPROFILE"], ".dsh", "profiles", "desktop")
PATCH = os.path.join(PROFILE, "cordis.patch.yml")
OLD = "name: '<REPO>/plugin'"
NEW = "name: '<REPO>/plugin/index.js'"


def probe(paths=("/mobile-kit/health", "/mobile-kit/info")):
    out = []
    for p in paths:
        try:
            r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:19387" + p), timeout=15)
            out.append((p, r.status, r.read().decode("utf-8", "replace")[:160]))
        except urllib.error.HTTPError as e:
            out.append((p, e.code, ""))
        except Exception as e:
            out.append((p, "ERR", str(e)[:80]))
    return out


def main():
    s = io.open(PATCH, encoding="utf-8", newline="").read()
    if NEW in s:
        print("已经是入口文件形态")
    else:
        n = s.count(OLD)
        if n != 1:
            print("ABORT: 旧行出现 %d 次" % n)
            return 1
        io.open(PATCH, "w", encoding="utf-8", newline="\n").write(s.replace(OLD, NEW, 1))
        print("已改为: %s" % NEW)

    for wait in (6, 8, 10):
        time.sleep(wait)
        res = probe()
        line = "  ".join("%s=%s" % (p.split("/")[-1], st) for p, st, _ in res)
        print("等待 %2ds 后: %s" % (wait, line))
        if all(st == 200 for _, st, _ in res):
            for p, st, body in res:
                print("   %s -> %s %s" % (p, st, body))
            print("==> host 半边已激活")
            return 0
    print("==> 仍未激活；下面看 loader 条目与各响应体")
    for p, st, body in probe():
        print("   %s -> %s %s" % (p, st, body))
    try:
        b = urllib.request.urlopen("http://127.0.0.1:19387/dsh-plugin-hub/debug/loader-entries", timeout=20).read().decode()
        es = json.loads(b).get("entries") or []
        for e in es:
            if "mobile" in json.dumps(e, ensure_ascii=False).lower():
                print("   loader:", json.dumps(e, ensure_ascii=False)[:200])
    except Exception as e:
        print("   loader 查询失败", e)
    return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
