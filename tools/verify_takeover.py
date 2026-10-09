# -*- coding: utf-8 -*-
"""接手复核脚本（独立第三方验收，不信任既有证据文件）。

只做只读 HTTP GET：/__health、/m/、/apk、/?UA、/f、/d、/dl、/__hot/*、WS 握手。
不创建 DSH 会话、不发送消息、不写工作区文件（硬规则 4）。

用法: python verify_takeover.py [输出文件]
"""
import hashlib
import http.client
import json
import os
import socket
import sys
from urllib.parse import quote

HOST = "<PC-LAN-IP>"
PORT = 19390
VIEW_HOST = "<TAILSCALE-IP>:19390"
APK = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "DSH.apk")
KEYFILE = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "cap.key")
ROOT = r"<WORKSPACE>"
UA_MOBILE = ("Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) "
             "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
             "移动浏览器.0.5735.196 Mobile Safari/537.36")
APK_SHA_EXPECTED = os.environ.get("DSH_APK_SHA", "")   # 可选：钉住你自己的构建产物

KEY = open(KEYFILE, encoding="utf-8").read().strip()

LINES = []
RESULTS = []


def out(s=""):
    print(s)
    LINES.append(s)


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    out("%-5s %s%s" % ("PASS" if ok else "FAIL", name, ("  | " + detail) if detail else ""))


def req(path, key=True, headers=None, host=None):
    c = http.client.HTTPConnection(HOST, PORT, timeout=30)
    h = {"Connection": "close"}
    if key:
        h["Cookie"] = "dshcap=" + KEY
    if headers:
        h.update(headers)
    if host:
        h["Host"] = host
    c.request("GET", path, headers=h)
    r = c.getresponse()
    body = r.read()
    hdrs = {k.lower(): v for k, v in r.getheaders()}
    st = r.status
    c.close()
    return st, hdrs, body


def find_first(exts, limit=8000):
    """在允许根内找一个指定后缀的真实文件（有界遍历）。"""
    n = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__")]
        for fn in filenames:
            n += 1
            if n > limit:
                return None
            if os.path.splitext(fn)[1].lower() in exts:
                return os.path.join(dirpath, fn)
    return None


def main():
    out("== 0. 环境 ==")
    out("proxy      : http://%s:%d" % (HOST, PORT))
    out("key        : %d chars, sha256[:12]=%s" % (len(KEY), hashlib.sha256(KEY.encode()).hexdigest()[:12]))
    out("allowed root (stated): %s  exists=%s" % (ROOT, os.path.isdir(ROOT)))

    out("\n== 1. 基础可用性 ==")
    st, h, b = req("/__health", key=False)
    check("health 200", st == 200, "status=%d bytes=%d" % (st, len(b)))
    st, h, b = req("/", key=False)
    check("no-key root 403", st == 403, "status=%d" % st)
    st, h, b = req("/?k=WRONG-KEY", key=False)
    check("wrong-key root 403", st == 403, "status=%d" % st)
    st, h, b = req("/m/")
    check("/m/ 200", st == 200, "status=%d bytes=%d" % (st, len(b)))

    st, h, b = req("/apk", key=True)
    disk_size = os.path.getsize(APK)
    disk_sha = hashlib.sha256(open(APK, "rb").read()).hexdigest()
    served = hashlib.sha256(b).hexdigest()
    check("/apk 200 + size", st == 200 and len(b) == disk_size,
          "status=%d served=%d disk=%d" % (st, len(b), disk_size))
    check("/apk bytes == on-disk file", served == disk_sha,
          "served=%s disk=%s" % (served[:16], disk_sha[:16]))
    if APK_SHA_EXPECTED:
        check("/apk sha256 == pinned (DSH_APK_SHA)", served == APK_SHA_EXPECTED,
              "served=%s expected=%s" % (served[:16], APK_SHA_EXPECTED[:16]))
    else:
        out("SKIP  /apk sha256 pin (set DSH_APK_SHA to pin your own build)")

    out("\n== 2. 移动端注入（手机 UA 取完整版）==")
    st, h, b = req("/", key=True, headers={"User-Agent": UA_MOBILE})
    html = b.decode("utf-8", "replace")
    check("full page 200", st == 200, "status=%d bytes=%d" % (st, len(b)))
    for marker in ("dsh-polyfill", "dsh-keeper", "dsh-pager", "dsh-gestures", "dsh-hot", "dsh-mobile-adapt"):
        check("inject marker %s" % marker, marker in html)

    # /__hot/status 是 text/plain 诊断文本（不是 JSON）——见 hotpatch/README.md
    st, h, b = req("/__hot/status", key=True)
    txt = b.decode("utf-8", "replace")
    check("/__hot/status 200", st == 200, "status=%d bytes=%d" % (st, len(b)))
    check("/__hot/status is text/plain", h.get("content-type", "").startswith("text/plain"),
          h.get("content-type", ""))
    check("hotpatch enabled", "hotpatch=1" in txt and "exists=1" in txt,
          txt.splitlines()[0] if txt else "")
    check("hotpatch lists 50-fileview.js", "50-fileview.js" in txt)
    check("hotpatch lists 10-base.js", "10-base.js" in txt)
    st, h, b = req("/__hot/patch.js", key=True)
    pj = b.decode("utf-8", "replace")
    check("/__hot/patch.js 200", st == 200, "status=%d bytes=%d" % (st, len(b)))
    check("patch.js carries fileview", "dshFileView" in pj)
    check("patch.js carries 10-base runtime", "__dshHot" in pj)

    out("\n== 3. 只读文件接口 ==")
    md = find_first({".md"})
    png = find_first({".png"})
    pyf = find_first({".py"})
    htmlf = find_first({".html"})
    out("sample md   = %s" % (md,))
    out("sample png  = %s" % (png,))
    out("sample py   = %s" % (pyf,))
    out("sample html = %s" % (htmlf,))

    if md:
        st, h, b = req("/f?path=%s&k=%s" % (quote(md), KEY))
        disk = open(md, "rb").read()
        check("/f md 200", st == 200, "status=%d" % st)
        check("/f md mime", h.get("content-type", "").startswith("text/markdown"), h.get("content-type", ""))
        check("/f md inline", "inline" in h.get("content-disposition", ""), h.get("content-disposition", ""))
        check("/f md no-store", h.get("cache-control", "") == "no-store", h.get("cache-control", ""))
        check("/f md nosniff", h.get("x-content-type-options", "") == "nosniff", h.get("x-content-type-options", ""))
        check("/f md bytes == disk", b == disk, "served=%d disk=%d sha=%s" % (
            len(b), len(disk), hashlib.sha256(b).hexdigest()[:12]))
    if png:
        st, h, b = req("/f?path=%s&k=%s" % (quote(png), KEY))
        check("/f png 200", st == 200, "status=%d" % st)
        check("/f png mime", h.get("content-type", "").startswith("image/png"), h.get("content-type", ""))
        check("/f png magic", b[:8] == b"\x89PNG\r\n\x1a\n", repr(b[:8]))
    if pyf:
        st, h, b = req("/f?path=%s&k=%s" % (quote(pyf), KEY))
        check("/f py mime text/plain", h.get("content-type", "").startswith("text/plain"), h.get("content-type", ""))
    if htmlf:
        st, h, b = req("/f?path=%s&k=%s" % (quote(htmlf), KEY))
        check("/f html forced text/plain (anti-XSS)", h.get("content-type", "").startswith("text/plain"),
              h.get("content-type", ""))

    st, h, b = req("/d?path=%s&k=%s" % (quote(ROOT), KEY))
    dpage = b.decode("utf-8", "replace")
    check("/d 200 html", st == 200 and h.get("content-type", "").startswith("text/html"),
          "status=%d ct=%s bytes=%d" % (st, h.get("content-type", ""), len(b)))
    check("/d links /f", "/f?path=" in dpage)
    check("/d links /dl", "/dl?path=" in dpage)
    if md:
        st, h, b = req("/dl?path=%s&k=%s" % (quote(md), KEY))
        check("/dl attachment", st == 200 and "attachment" in h.get("content-disposition", ""),
              "status=%d cd=%s" % (st, h.get("content-disposition", "")))

    out("\n== 4. 安全边界（越权/无密钥/不存在）==")
    bad = [
        ("traversal ..Windows win.ini", "/f?path=" + quote("..\\..\\Windows\\win.ini") + "&k=" + KEY),
        ("absolute C:Windows win.ini", "/f?path=" + quote("C:\\Windows\\win.ini") + "&k=" + KEY),
        ("escape via allowed root", "/f?path=" + quote(ROOT + "\\..\\..\\Windows\\win.ini") + "&k=" + KEY),
        ("url-encoded C:Windows", "/f?path=C%3A%5CWindows%5Cwin.ini&k=" + KEY),
        ("url-encoded traversal", "/f?path=..%5C..%5CWindows%5Cwin.ini&k=" + KEY),
        ("prefix spoof yuagentx", "/f?path=" + quote(ROOT + "x\\a.txt") + "&k=" + KEY),
        ("dir outside root", "/d?path=C%3A%5CWindows&k=" + KEY),
        ("download outside root", "/dl?path=C%3A%5CWindows%5Cwin.ini&k=" + KEY),
        ("bare dotdot", "/f?path=" + quote("..") + "&k=" + KEY),
    ]
    for name, path in bad:
        st, h, b = req(path)
        check("403 %s" % name, st == 403, "status=%d" % st)

    # NUL 字节：代理以 400 拒（不是 403），关键属性是"被拒且未泄露内容"
    st, h, b = req("/f?path=" + quote(ROOT + "\\a\x00b") + "&k=" + KEY)
    check("NUL byte rejected (400/403)", st in (400, 403), "status=%d bytes=%d" % (st, len(b)))

    if md:
        st, h, b = req("/f?path=%s&k=WRONG-KEY" % quote(md), key=False)
        check("403 wrong key (no cookie)", st == 403, "status=%d" % st)
        st, h, b = req("/f?path=%s&k=%s" % (quote(md), KEY), key=True)
        check("200 right key", st == 200, "status=%d" % st)
        st, h, b = req("/f?path=%s" % quote(md), key=False)
        check("403 no key /f", st == 403, "status=%d" % st)
        st, h, b = req("/dl?path=%s" % quote(md), key=False)
        check("403 no key /dl", st == 403, "status=%d" % st)
    st, h, b = req("/d?path=%s" % quote(ROOT), key=False)
    check("403 no key /d", st == 403, "status=%d" % st)

    missing = os.path.join(ROOT, "docs", "__no_such_file_%d__.md" % os.getpid())
    st, h, b = req("/f?path=%s&k=%s" % (quote(missing), KEY))
    check("404 missing file", st == 404, "status=%d" % st)
    st, h, b = req("/f?path=%s&k=%s" % (quote(ROOT), KEY))
    check("400 /f on a directory", st == 400, "status=%d" % st)

    out("\n== 5. WebSocket 中继握手 ==")
    try:
        s = socket.create_connection((HOST, PORT), timeout=15)
        raw = (
            "GET /api/remote.mux HTTP/1.1\r\n"
            "Host: %s\r\nOrigin: http://%s\r\nCookie: dshcap=%s\r\n"
            "Connection: Upgrade\r\nUpgrade: websocket\r\n"
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        ) % (VIEW_HOST, VIEW_HOST, KEY)
        s.sendall(raw.encode())
        first = s.recv(200).decode("latin-1", "replace").split("\r\n")[0]
        s.close()
        check("WS upgrade 101", "101" in first, first)
    except Exception as e:
        check("WS upgrade 101", False, repr(e))

    ok = sum(1 for _, p in RESULTS if p)
    out("\n== SUMMARY: %d/%d PASS ==" % (ok, len(RESULTS)))
    failed = [n for n, p in RESULTS if not p]
    if failed:
        out("FAILED: " + " | ".join(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    rc = main()
    dest = sys.argv[1] if len(sys.argv) > 1 else None
    if dest:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(LINES) + "\n")
        print("written: " + dest)
    sys.exit(rc)
