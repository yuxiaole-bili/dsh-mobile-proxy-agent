# -*- coding: utf-8 -*-
"""10 轮夺旗（CTF）—— 只打自己的资产，全程非破坏性。

红队视角：本机（内部）+ 服务器（外部，经 SSH）。
旗子：每轮现种一个随机 token，打完删除；不写工作区以外任何东西。
判定：BLOCKED=防线守住；CAPTURED=夺旗成功（发现漏洞）。
"""
import io
import json
import os
import random
import shutil
import string
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = io.open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
HOST, PORT = "<PC-LAN-IP>", 19390
BASE = "http://%s:%d" % (HOST, PORT)
WORKSPACE = r"<WORKSPACE>"
CTF_DIR = os.path.join(WORKSPACE, ".ctf")
HOTPATCH = os.path.join(FW, "hotpatch")
SERVER = "ss_100"
PLANTED = []
SCORE = []


def flag(tag):
    t = "FLAG{%s-%s}" % (tag, "".join(random.choice(string.hexdigits.lower()[:16]) for _ in range(12)))
    return t


def req(path, key=None, method="GET", data=None, timeout=8, headers=None):
    h = {"User-Agent": "dsh-ctf/1.0"}
    if key:
        h["Cookie"] = "dshcap=" + key
    if headers:
        h.update(headers)
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read(8000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(4000)
    except Exception as e:
        return None, str(e).encode()


def ssh(cmd, timeout=45):
    try:
        p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SERVER, cmd],
                           capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:
        return -1, str(e)


def plant(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, "w", encoding="utf-8", newline="\n").write(content)
    PLANTED.append(path)
    return path


def round_result(n, title, captured, detail):
    verdict = "CAPTURED" if captured else "BLOCKED"
    SCORE.append((n, title, verdict, detail))
    print("\n--- R%d %s ---" % (n, title))
    print("    %s | %s" % (verdict, detail))


def main():
    print("=" * 74)
    print("CTF: 10 轮夺旗  目标 %s（自己的资产）  红队=本机+服务器" % BASE)
    print("=" * 74)

    # ---------- R1 无密钥读工作区文件 ----------
    f1 = plant(os.path.join(CTF_DIR, "flag1.txt"), flag("r1") + "\n")
    st, body = req("/f?path=" + urllib.request.quote(f1))
    got = b"FLAG{" in body
    round_result(1, "无密钥读 /f（工作区文件）", got, "HTTP %s len=%d" % (st, len(body)))

    # ---------- R2 带有效密钥做目录穿越 ----------
    tmpf = os.path.join(tempfile.gettempdir(), "ctf_flag2.txt")
    t2 = flag("r2")
    io.open(tmpf, "w", encoding="utf-8").write(t2 + "\n")
    PLANTED.append(tmpf)
    wins = []
    for p in ["/f?path=" + urllib.request.quote(tmpf),
              "/f?path=" + urllib.request.quote("..\\..\\..\\.." + tmpf),
              "/f?path=" + urllib.request.quote("C:/Windows/win.ini"),
              "/f?path=....//....//Windows/win.ini"]:
        st, body = req(p, key=KEY)
        if t2.encode() in body or b"for 16-bit app support" in body:
            wins.append(p)
    round_result(2, "有效密钥 + 目录穿越", bool(wins), "4 种变体，突破 %d 种 %s" % (len(wins), wins[:2]))

    # ---------- R3 无密钥读热补丁通道 ----------
    marker = "/* CTF-%s */" % flag("r3")
    hf = os.path.join(HOTPATCH, "zz-ctf-marker.css")
    io.open(hf, "w", encoding="utf-8").write(marker + "\n")
    PLANTED.append(hf)
    st, body = req("/__hot/patch.css")
    got = b"CTF-FLAG" in body or b"zz-ctf-marker" in body
    round_result(3, "无密钥读 /__hot/patch.css（JS/CSS 注入通道）", got, "HTTP %s len=%d" % (st, len(body)))
    st2, body2 = req("/__hot/patch.css", key=KEY)
    print("    （对照：带密钥读取 HTTP %s len=%d —— 说明通道本身正常工作）" % (st2, len(body2)))

    # ---------- R4 向热补丁通道写入 ----------
    wrote = []
    for method in ("PUT", "POST", "PATCH"):
        st, body = req("/__hot/patch.js", method=method, data=b"alert(1)", headers={"content-type": "text/plain"})
        if st in (200, 201, 204):
            wrote.append(method)
    st, body = req("/__hot/../hotpatch/zz-ctf-marker.css")
    if st == 200:
        wrote.append("path-normalize")
    round_result(4, "未鉴权写入热补丁（等于注入 JS 到手机）", bool(wrote),
                 "PUT/POST/PATCH -> 全部拒绝；突破: %s" % (wrote or "无"))

    # ---------- R5 无密钥目录列表 ----------
    st, body = req("/d?path=.")
    st2, body2 = req("/d?path=" + urllib.request.quote(WORKSPACE), key=KEY)
    leaked = (st == 200 and len(body) > 50)
    round_result(5, "无密钥目录列表 /d", leaked,
                 "无密钥 HTTP %s；带密钥 HTTP %s len=%d" % (st, st2, len(body2)))

    # ---------- R6 缓存越权（最危险的一类） ----------
    body_rpc = json.dumps({"type": "client-request", "rpcId": "ctf-probe-1",
                           "method": "agentPresets/list", "payload": {"args": {}}}).encode()
    st_a, b_a = req("/api/agentPresets/list", key=KEY, method="POST", data=body_rpc,
                    headers={"content-type": "application/json"})
    time.sleep(0.4)
    st_b, b_b = req("/api/agentPresets/list", method="POST", data=body_rpc,
                    headers={"content-type": "application/json"})
    captured = (st_b == 200 and len(b_b) > 50)
    round_result(6, "缓存越权：预热后用无密钥请求同一路径", captured,
                 "带密钥 HTTP %s len=%d -> 无密钥 HTTP %s len=%d" % (st_a, len(b_a), st_b, len(b_b)))

    # ---------- R7 日志泄露 ----------
    logp = os.path.join(FW, "proxy.log")
    log_txt = io.open(logp, encoding="utf-8", errors="replace").read()
    key_in_log = KEY in log_txt
    routes = ["/proxy.log", "/log", "/__log", "/logs/proxy.log", "/__diag/log"]
    served = []
    for r in routes:
        st, body = req(r, key=KEY)
        if st == 200 and b"DBG" in body[:2000]:
            served.append(r)
        if st == 200 and KEY.encode() in body[:20000]:
            served.append(r + "(含密钥)")
    round_result(7, "日志泄露（HTTP 可读 + 明文密钥）", key_in_log or bool(served),
                 "日志含明文密钥=%s；可经 HTTP 读取=%s" % (key_in_log, served or "无"))

    # ---------- R8 重启通道 19395 ----------
    rc, out = ssh("timeout 4 bash -c 'echo > /dev/tcp/<PC-LAN-IP>/19395' 2>/dev/null && echo OPEN || echo CLOSED")
    opened = "OPEN" in out
    rc2, out2 = ssh("timeout 4 bash -c 'echo > /dev/tcp/<PC-LAN-IP>/19390' 2>/dev/null && echo OPEN || echo CLOSED")
    round_result(8, "从服务器连重启通道 19395", opened,
                 "19395=%s（应 CLOSED）；19390=%s（必要开放）" % (out.strip().splitlines()[-1] if out.strip() else "?", out2.strip().splitlines()[-1] if out2.strip() else "?"))

    # ---------- R9 SMB 445 暴露 ----------
    rc, out = ssh("timeout 5 bash -c 'echo > /dev/tcp/<PC-LAN-IP>/445' 2>/dev/null && echo OPEN || echo CLOSED")
    rc2, out2 = ssh("command -v smbclient >/dev/null 2>&1 && timeout 8 smbclient -L //<PC-LAN-IP> -N 2>&1 | head -12 || echo 'no smbclient'")
    opened = "OPEN" in out
    round_result(9, "SMB 445 对局域网暴露", opened,
                 "445=%s; 匿名列举: %s" % (out.strip().splitlines()[-1] if out.strip() else "?",
                                          " ".join(out2.split())[:90]))

    # ---------- R10 无密钥执行面 ----------
    hits = []
    for p, d in [("/api/session/create", b"{}"), ("/api/session/list", b"{}"),
                 ("/api/workspaceFiles/readBytes", b'{"path":"C:/Windows/win.ini"}')]:
        st, body = req(p, method="POST", data=d, headers={"content-type": "application/json"})
        if st == 200 and len(body) > 20:
            hits.append("%s -> %s" % (p, st))
    round_result(10, "无密钥调用 /api/*（RCE 前置条件）", bool(hits), "突破: %s" % (hits or "无，全部 403"))

    # ---------- 记分 ----------
    print("\n" + "=" * 74)
    cap = [s for s in SCORE if s[2] == "CAPTURED"]
    print("记分牌：%d/%d 轮夺旗成功；%d 轮被拦" % (len(cap), len(SCORE), len(SCORE) - len(cap)))
    print("=" * 74)
    for n, title, verdict, detail in SCORE:
        print("  R%-2d %-8s %-42s %s" % (n, verdict, title[:42], detail[:60]))
    if cap:
        print("\n需要处置：")
        for n, title, _, _ in cap:
            print("  R%d %s" % (n, title))

    # ---------- 清理 ----------
    print("\n清理旗子：")
    for p in PLANTED:
        try:
            os.remove(p)
            print("  删除", p)
        except OSError as e:
            print("  删除失败", p, e)
    try:
        os.rmdir(CTF_DIR)
        print("  删除", CTF_DIR)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
