# -*- coding: utf-8 -*-
"""代理日志审计：找错误、5xx、慢请求、异常关闭（只读）。

日志行样例：
  2026-10-04 14:12:40 proxied GET /alert-chime/events?since=60 host=<TAILSCALE-IP>:19390 from <SRV-LAN-IP>
  2026-10-04 14:12:40 <- HTTP/1.1 200 OK | POST /api/session/openWorkspacePath (0.00s)
  2026-10-04 14:12:39 chime /alert-chime/events?since= -> 22 B (was 22 B) 0.00s
"""
import collections
import os
import re
import sys

LOG = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "proxy.log")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "evidence", "proxy_log_audit.txt")

RE_TS = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
RE_STATUS = re.compile(r"<-\s+HTTP/1\.1\s+(\d{3})")
RE_DUR = re.compile(r"\((\d+\.\d+)s\)")
RE_PATH = re.compile(r"<-\s+HTTP/1\.1\s+\d+\s+\S+\s+\|\s+(\S+)\s+(\S+)")

L = []


def w(s=""):
    L.append(s)


def main():
    size = os.path.getsize(LOG)
    lines = 0
    first_ts = last_ts = None
    status = collections.Counter()
    by_status5xx = collections.Counter()
    slow = []
    traces = []
    trace_buf = []
    err_kw = collections.Counter()
    deny = collections.Counter()
    ws_events = collections.Counter()
    dur_buckets = collections.Counter()
    path_5xx = collections.Counter()

    with open(LOG, "r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            lines += 1
            line = raw.rstrip("\n")
            m = RE_TS.match(line)
            if m:
                if first_ts is None:
                    first_ts = m.group(1)
                last_ts = m.group(1)

            # Traceback / python 异常块
            if "Traceback (most recent call last)" in line:
                if trace_buf:
                    traces.append(trace_buf[:6])
                trace_buf = [line]
            elif trace_buf:
                trace_buf.append(line)
                if len(trace_buf) > 6:
                    traces.append(trace_buf[:6])
                    trace_buf = []
            if re.search(r"\b(ERROR|CRITICAL)\b", line):
                err_kw["ERROR/CRITICAL"] += 1
            if "handler error" in line:
                err_kw["handler error"] += 1
            if "address already in use" in line:
                err_kw["address already in use"] += 1
            if "ConnectionResetError" in line:
                err_kw["ConnectionResetError"] += 1
            if "BrokenPipe" in line:
                err_kw["BrokenPipe"] += 1

            ms = RE_STATUS.search(line)
            if ms:
                code = ms.group(1)
                status[code] += 1
                if code.startswith("5"):
                    mp = RE_PATH.search(line)
                    key = (mp.group(1) + " " + mp.group(2)) if mp else "?"
                    by_status5xx[code] += 1
                    path_5xx[key[:70]] += 1
                md = RE_DUR.search(line)
                if md:
                    d = float(md.group(1))
                    dur_buckets["<0.1s" if d < 0.1 else "0.1-0.5s" if d < 0.5 else
                                "0.5-2s" if d < 2 else "2-5s" if d < 5 else ">=5s"] += 1
                    if d >= 2.0:
                        slow.append((d, line.strip()[:160]))

            if "DENY" in line:
                deny[line.split("DENY", 1)[1].strip()[:60]] += 1
            if "ws " in line:
                ws_events[line.split("ws ", 1)[1].strip()[:40]] += 1

    if trace_buf:
        traces.append(trace_buf[:6])

    w("代理日志审计（只读）")
    w("文件: %s" % LOG)
    w("大小: %.2f MB   行数: %s" % (size / 1048576.0, lines))
    w("时间跨度: %s  →  %s" % (first_ts, last_ts))
    w("=" * 74)
    w("HTTP 状态码分布: %s" % dict(status.most_common()))
    w("耗时分布: %s" % dict(dur_buckets.most_common()))
    w("5xx 总数: %d  %s" % (sum(by_status5xx.values()), dict(by_status5xx)))
    if path_5xx:
        w("5xx 路径 Top:")
        for k, v in path_5xx.most_common(15):
            w("   %6d  %s" % (v, k))
    w("")
    w("异常/错误关键字: %s" % (dict(err_kw) or "无"))
    w("Python Traceback 块数: %d" % len(traces))
    for i, t in enumerate(traces[:4]):
        w("  --- traceback #%d ---" % (i + 1))
        for ln in t:
            w("    " + ln[:150])
    w("")
    w("DENY（无密钥/错密钥被拒）: %s" % (dict(deny.most_common(6)) or "无"))
    w("WS 事件: %s" % (dict(ws_events.most_common(8)) or "无"))
    w("")
    slow.sort(reverse=True)
    w("慢请求 (>=2s) 共 %d 条，最慢 10 条:" % len(slow))
    for d, ln in slow[:10]:
        w("   %6.2fs  %s" % (d, ln))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L) + "\n")
    print("written:", OUT)
    print("lines=%s size_MB=%.2f span=%s..%s" % (lines, size / 1048576.0, first_ts, last_ts))
    print("status_codes=", dict(status.most_common()))
    print("5xx_total=", sum(by_status5xx.values()), dict(by_status5xx))
    print("durations=", dict(dur_buckets.most_common()))
    print("errors=", dict(err_kw) or "none")
    print("tracebacks=", len(traces))
    print("slow>=2s=", len(slow))
    return 0


if __name__ == "__main__":
    sys.exit(main())
