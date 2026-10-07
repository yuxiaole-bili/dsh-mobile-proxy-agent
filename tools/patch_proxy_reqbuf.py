# -*- coding: utf-8 -*-
"""proxy.py：大请求体先收完再连上游（修"发图片被吞"）。

现场（proxy.log 2026-10-04 16:27:41）：
  <- HTTP/1.1 408 Request Timeout | POST /api/session/prompt (317.38s)
  keepalive: reuse=False ka=False POST /api/session/prompt clen=980312 have=945560

原因：代理在 line 3282 先连上游，再 line 3294 边收边转发。手机经 Tailscale 上行只有
~3 KB/s，980 KB 的图片消息要传 317 秒，而**上游 DSH 的请求超时约 300 秒**在中途触发，
回了 408 并断连 —— 客户端侧就是"消息被吞"。API_CACHE_MAXREQ=256KB 只覆盖小 body。

改法：非 chunked 且 body 大于阈值的请求，先把客户端 body 完整收下来，再连上游转发。
这样慢上传的那段时间不计入上游超时（上游只在 body 齐了之后才开始等）。

锚点增量 + count==1 断言 + 备份 + py_compile。
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

P = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "proxy.py")
TS = time.strftime("%Y%m%d-%H%M%S")

ANCHOR_CONST = "API_CACHE_MAXREQ = 262144   # never cache a request body bigger than this\n"
NEW_CONST = """API_CACHE_MAXREQ = 262144   # never cache a request body bigger than this
# 大请求体（图片消息等）：超过下限就先把客户端整个 body 收完，再连上游。
# 起因 2026-10-04 16:27:41 —— 手机经 Tailscale 上行 ~3 KB/s，980 KB 的图片消息传了
# 317 秒，中途被**上游 DSH 约 300 秒的请求超时**判 408 并断连（clen=980312 have=945560），
# 客户端表现为"消息被吞"。先收完再转发，慢的那段就不算在上游超时里。
REQ_BUFFER_MIN = int(os.environ.get("DSH_REQ_BUFFER_MIN", "262144"))       # 256 KB
REQ_BUFFER_MAX = int(os.environ.get("DSH_REQ_BUFFER_MAX", str(16 * 1024 * 1024)))
"""

ANCHOR_OPEN = """        tr, tw = await asyncio.open_connection(*TARGET)
        tw.write(out)
        if api_body_read:
"""
NEW_BLOCK = """        # 大 body：先收完再连上游（见 REQ_BUFFER_MIN 的说明）。收完再转发，
        # 上游的请求超时才开始计，慢链路才不会把请求判死。
        if (not api_body_read and not chunked_req
                and REQ_BUFFER_MIN < clen <= REQ_BUFFER_MAX):
            api_body = await _read_req_body(reader, rest, clen)
            rest = b""
            api_body_read = True
            log("req buffer: %s %s %d B (wait for full body before upstream)"
                % (parts[0], target[:32], clen))

        tr, tw = await asyncio.open_connection(*TARGET)
        tw.write(out)
        if api_body_read:
"""


def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def main():
    raw = open(P, "rb").read()
    eol = "\r\n" if raw.count(b"\r\n") * 2 > raw.count(b"\n") else "\n"
    t = raw.decode("utf-8").replace("\r\n", "\n")
    before = md5(P)
    print("proxy.py bytes=%d eol=%s" % (len(raw), repr(eol)))

    for anchor, repl, label in ((ANCHOR_CONST, NEW_CONST, "const"),
                                (ANCHOR_OPEN, NEW_BLOCK, "open-connection")):
        n = t.count(anchor)
        if n != 1:
            raise SystemExit("ABORT: anchor %r occurs %d times (want 1)" % (label, n))
        print("  anchor OK  %-16s (1 match)" % label)
        t = t.replace(anchor, repl, 1)

    for need in ("REQ_BUFFER_MIN", "REQ_BUFFER_MAX", "wait for full body before upstream"):
        if need not in t:
            raise SystemExit("ABORT: post-check missing " + need)

    bak = P + ".bak_reqbuf_" + TS
    shutil.copy2(P, bak)
    open(P, "wb").write((t if eol == "\n" else t.replace("\n", eol)).encode("utf-8"))
    print("  backup : %s" % os.path.basename(bak))
    print("  md5    : %s -> %s" % (before, md5(P)))
    print("  bytes  : %d -> %d" % (len(raw), os.path.getsize(P)))

    r = subprocess.run([sys.executable, "-m", "py_compile", P], capture_output=True, text=True)
    print("  py_compile rc=%d %s" % (r.returncode, (r.stderr or "").strip()[:200]))
    if r.returncode != 0:
        shutil.copy2(bak, P)
        print("  !! 回滚（编译不过）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
