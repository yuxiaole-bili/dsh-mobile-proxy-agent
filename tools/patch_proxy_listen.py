# -*- coding: utf-8 -*-
"""proxy.py：监听地址改为可配置（默认 0.0.0.0），让手机在"局域网直连"和"VPN 转发"两条路都能到。

现状：LISTEN = ("<PC-LAN-IP>", 19390) —— 只绑有线网卡那一个地址，
手机连 WiFi（192.168.71.x）或走别的网段时根本连不上，只能用服务器 Tailscale 转发那条慢路。

改法：LISTEN 由环境变量决定，默认 0.0.0.0（所有网卡）。
  DSH_LISTEN_HOST / DSH_LISTEN_PORT 可覆盖（例如只想绑某个地址时）。
安全性：代理本身对一切路由都要访问密钥（只有 /__health 免密钥），
       绑 0.0.0.0 不改变鉴权行为。

锚点增量 + 备份 + py_compile。
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

P = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "proxy.py")
TS = time.strftime("%Y%m%d-%H%M%S")

ANCHOR = 'LISTEN = ("<PC-LAN-IP>", 19390)\n'
NEW = '''# 监听地址：默认绑所有网卡，让手机无论走"局域网直连"还是"VPN/服务器转发"都能到。
# 只想绑某个地址时用环境变量覆盖，例如 DSH_LISTEN_HOST=<PC-LAN-IP>。
# （鉴权不受影响：除 /__health 外所有路由都要访问密钥。）
LISTEN = (os.environ.get("DSH_LISTEN_HOST", "0.0.0.0"),
          int(os.environ.get("DSH_LISTEN_PORT", "19390")))
'''


def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def main():
    raw = open(P, "rb").read()
    eol = "\r\n" if raw.count(b"\r\n") * 2 > raw.count(b"\n") else "\n"
    t = raw.decode("utf-8").replace("\r\n", "\n")
    before = md5(P)
    n = t.count(ANCHOR)
    if n != 1:
        raise SystemExit("ABORT: LISTEN anchor occurs %d times" % n)
    print("  anchor OK  proxy/LISTEN (1 match)")
    t = t.replace(ANCHOR, NEW, 1)
    if "DSH_LISTEN_HOST" not in t:
        raise SystemExit("ABORT: post-check failed")
    bak = P + ".bak_listen_" + TS
    shutil.copy2(P, bak)
    open(P, "wb").write((t if eol == "\n" else t.replace("\n", eol)).encode("utf-8"))
    print("  backup : %s" % os.path.basename(bak))
    print("  md5    : %s -> %s" % (before, md5(P)))
    r = subprocess.run([sys.executable, "-m", "py_compile", P], capture_output=True, text=True)
    print("  py_compile rc=%d %s" % (r.returncode, (r.stderr or "").strip()[:160]))
    if r.returncode != 0:
        shutil.copy2(bak, P)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
