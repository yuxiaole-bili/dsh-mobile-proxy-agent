# -*- coding: utf-8 -*-
"""1) 用 Node 直接导入插件包，看模块本身是否干净
   2) 列出 dsh-plugin hub 的全部路由（找 reload/rescan 之类能触发 recompose 的）
   3) hub.log 尾部"""
import io
import json
import os
import re
import subprocess
import sys
import urllib.request

PLUGIN = "file:///<REPO>/plugin"
HUB = os.path.join(os.environ["USERPROFILE"], ".dsh", "profiles", "desktop", "node_modules", "dsh-plugin")
HUBLOG = os.path.join(os.environ["USERPROFILE"], ".dsh", "profiles", "desktop", "hub.log")


def main():
    print("=== 1) Node 直接导入 %s ===" % PLUGIN)
    js = ("import(process.argv[1]).then(function(m){"
          "console.log('OK exports=' + Object.keys(m).join(',') + ' name=' + m.name + "
          "' inject=' + JSON.stringify(m.inject) + ' apply=' + typeof m.apply);"
          "}).catch(function(e){console.log('FAIL ' + (e && e.message));});")
    r = subprocess.run(["node", "-e", js, PLUGIN], capture_output=True, text=True, timeout=60)
    print("  " + (r.stdout or "").strip())
    if r.stderr.strip():
        print("  stderr: " + r.stderr.strip()[:300])

    print("\n=== 2) hub 路由清单 ===")
    found = set()
    for dp, dn, fn in os.walk(HUB):
        dn[:] = [x for x in dn if x != "node_modules"]
        for f in fn:
            if not f.endswith(".js"):
                continue
            p = os.path.join(dp, f)
            try:
                if os.path.getsize(p) > 6 * 1024 * 1024:
                    continue
                s = io.open(p, encoding="utf-8", errors="replace").read()
            except Exception:
                continue
            for m in re.finditer(r"[\"'`](/dsh-plugin-hub/[A-Za-z0-9_\-/]+)[\"'`]", s):
                found.add(m.group(1))
    for x in sorted(found):
        print("   " + x)

    print("\n=== 3) hub.log 尾部 ===")
    if os.path.isfile(HUBLOG):
        for l in io.open(HUBLOG, encoding="utf-8", errors="replace").read().splitlines()[-6:]:
            print("   " + l[:220])
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
