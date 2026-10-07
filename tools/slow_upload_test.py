# -*- coding: utf-8 -*-
"""验证 proxy.py 的"大 body 先收完再连上游"：慢速上传对照实验。

阶段 A：300 KB（> REQ_BUFFER_MIN=256KB）→ 期望代理先收完 body 才连上游
阶段 B：200 KB（< 阈值）→ 期望维持原来的边收边转发（对照组）

判定看两处：
  1) 客户端是否在 body 还没发完时就收到响应（提前响应 = 没在缓冲）；
  2) proxy.log 里是否出现 "req buffer:" 行，以及它与 "proxied POST" 行的先后/时间差。
"""
import os
import socket
import sys
import time

HOST, PORT = "<PC-LAN-IP>", 19390
KEY = open(os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "cap.key"),
           encoding="utf-8").read().strip()
CHUNK = 4096
DELAY = 0.4


def slow_post(path, total, label):
    s = socket.create_connection((HOST, PORT), timeout=180)
    head = ("POST %s HTTP/1.1\r\nHost: <TAILSCALE-IP>:19390\r\n"
            "Cookie: dshcap=%s\r\nContent-Type: application/json\r\n"
            "Content-Length: %d\r\nConnection: close\r\n\r\n" % (path, KEY, total))
    s.sendall(head.encode("latin-1"))
    t0 = time.time()
    sent = 0
    early = None
    body = b"x" * CHUNK
    while sent < total:
        s.sendall(body)
        sent += len(body)
        time.sleep(DELAY)
        if early is None:
            s.settimeout(0.01)
            try:
                d = s.recv(4096)
                if d:
                    early = time.time() - t0
            except socket.timeout:
                pass
            except Exception:
                pass
    t_body_done = time.time() - t0
    s.settimeout(60)
    after = b""
    try:
        after = s.recv(65536)
    except Exception as e:
        after = ("ERR %s" % e).encode()
    s.close()
    print("[%s] path=%s total=%dB" % (label, path, total))
    print("   body 发完用时      : %.1fs" % t_body_done)
    print("   body 期间提前响应  : %s" % ("无（=先收完才转发）" if early is None else "有！%.1fs" % early))
    print("   发完后的响应       : %r" % after[:100])
    return early, t_body_done


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("代理: http://%s:%d   阈值 REQ_BUFFER_MIN=262144" % (HOST, PORT))
    print("=" * 70)
    slow_post("/api/__slowtestA", 307200, "A 300KB 超阈值")
    print("-" * 70)
    slow_post("/api/__slowtestB", 204800, "B 200KB 不超阈值")
    return 0


if __name__ == "__main__":
    sys.exit(main())
