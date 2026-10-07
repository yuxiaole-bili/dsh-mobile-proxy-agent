# -*- coding: utf-8 -*-
"""读 dsh-plugin hub 的自检接口（GET 全量 + POST 诊断），并汇总它记录的插件日志。"""
import io
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:19387"
GETS = ["/dsh-plugin-hub/env", "/dsh-plugin-hub/installed", "/dsh-plugin-hub/installed-version",
        "/dsh-plugin-hub/active", "/dsh-plugin-hub/logs", "/dsh-plugin-hub/debug/loader-entries"]
POSTS = ["/dsh-plugin-hub/diagnostics"]


def call(path, method="GET", data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=body,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200]
    except Exception as ex:
        return "ERR", str(ex)[:120]


def brief(txt, limit=900):
    try:
        d = json.loads(txt)
    except Exception:
        return txt[:limit]
    return json.dumps(d, ensure_ascii=False, indent=1)[:limit]


def main():
    for p in GETS:
        st, txt = call(p)
        print("=== GET %s -> %s (%d B) ===" % (p, st, len(txt)))
        print(brief(txt))
        print()
    for p in POSTS:
        st, txt = call(p, "POST", {})
        print("=== POST %s -> %s (%d B) ===" % (p, st, len(txt)))
        print(brief(txt, 1200))
        print()
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
