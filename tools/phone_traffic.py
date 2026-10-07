# -*- coding: utf-8 -*-
"""手机（经 <SRV-LAN-IP> 进来）到底在请求什么 —— 只读日志画像。"""
import collections
import os
import re

LOG = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "proxy.log")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "evidence", "phone_traffic.txt")

RE_REQ = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) proxied (GET|POST|PUT|DELETE) (\S+) host=\S+ from (\S+)")
RE_RES = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) <- HTTP/1\.1 (\d{3}) \S+ \| (GET|POST|PUT|DELETE) (\S+)")

by_path = collections.Counter()
interesting = []
last_lines = []
status_by_path = collections.defaultdict(collections.Counter)
tail = collections.deque(maxlen=60)

with open(LOG, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        m = RE_REQ.match(line)
        if m:
            ts, meth, path, ip = m.groups()
            if ip.startswith("<SRV-LAN-IP>"):
                p = path.split("?")[0]
                by_path[meth + " " + p] += 1
                if re.search(r"open|file|path|workspace|download|speech|voice|upload|dl\b|attach", p, re.I):
                    interesting.append((ts, meth, path[:120]))
                tail.append((ts, meth + " " + path[:100]))
        m2 = RE_RES.match(line)
        if m2:
            ts, code, meth, path = m2.groups()
            status_by_path[meth + " " + path.split("?")[0]][code] += 1

L = []
L.append("手机流量画像（client = <SRV-LAN-IP>，即经 Tailscale 进来的手机）")
L.append("日志: %s" % LOG)
L.append("=" * 74)
total = sum(by_path.values())
L.append("手机请求总数: %d，不同路径: %d" % (total, len(by_path)))
L.append("")
L.append("Top 30 路径:")
for k, v in by_path.most_common(30):
    codes = dict(status_by_path.get(k, {}))
    L.append("  %6d  %-52s %s" % (v, k[:52], codes))
L.append("")
L.append("与 打开/文件/下载/语音 相关的请求（全部 %d 条，最多显示 60）:" % len(interesting))
for ts, meth, path in interesting[:60]:
    L.append("  %s  %s %s" % (ts, meth, path))
L.append("")
L.append("最近 60 条手机请求:")
for ts, req in list(tail)[-60:]:
    L.append("  %s  %s" % (ts, req))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(L) + "\n")
print("written:", OUT)
print("phone requests total =", total, " distinct =", len(by_path))
print("top 15:")
for k, v in by_path.most_common(15):
    print("   %6d  %-50s %s" % (v, k[:50], dict(status_by_path.get(k, {}))))
print("open/file/speech-ish requests =", len(interesting))
for ts, meth, path in interesting[:15]:
    print("   ", ts, meth, path)
