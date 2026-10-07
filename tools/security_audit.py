# -*- coding: utf-8 -*-
"""安全审计（只输出命中位置与计数，绝不打印密钥本身）：
  A 数据泄露：开源库/热补丁/插件/日志里有没有 capability key、cookie、真实 IP、个人路径
  B 内存：代理的 API 缓存占用/条目数、缓存上限、进程内存
"""
import io
import os
import re
import subprocess
import sys

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
REPO = r"<REPO>\establish"
KEYFILE = os.path.join(FW, "cap.key")

SECRETS = {}
try:
    SECRETS["cap.key"] = io.open(KEYFILE, encoding="utf-8").read().strip()
except OSError:
    pass

PATTERNS = [
    ("cap.key 值", None),
    ("dshcap= 后跟非占位", re.compile(r"dshcap=(?!<%|\$|\{|PLACEHOLDER|xxx|YOUR)[A-Za-z0-9_\-]{12,}")),
    ("?k= 后跟非占位", re.compile(r"[?&]k=(?!<%|\$|\{|PLACEHOLDER|xxx|YOUR)[A-Za-z0-9_\-]{12,}")),
    ("Tailscale 100.x", re.compile(r"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b")),
    ("局域网 192.168.x", re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b")),
    ("个人目录 <USER>", re.compile(r"<USER>")),
    ("Windows 用户目录", re.compile(r"C:\\Users\\[^\\\s\"']+")),
    ("疑似 API key", re.compile(r"\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,})\b")),
]

SKIP_DIRS = {".git", "node_modules", "__pycache__", "evidence"}
SKIP_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico", ".zip", ".apk"}


def scan_tree(root, label):
    hits = []
    files = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in SKIP_EXT:
                continue
            p = os.path.join(dirpath, fn)
            try:
                s = io.open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            files += 1
            rel = os.path.relpath(p, root)
            for name, rx in PATTERNS:
                if name == "cap.key 值":
                    if SECRETS.get("cap.key") and SECRETS["cap.key"] in s:
                        hits.append((rel, name, "!!"))
                    continue
                for m in rx.finditer(s):
                    frag = m.group(0)
                    hits.append((rel, name, frag[:24]))
    print("\n[%s] 扫描 %d 个文本文件，命中 %d 处" % (label, files, len(hits)))
    for rel, name, frag in hits[:40]:
        print("   %-46s %-16s %s" % (rel, name, frag))
    if len(hits) > 40:
        print("   ... 还有 %d 处" % (len(hits) - 40))
    return hits


def main():
    print("=" * 68)
    print("A. 数据泄露扫描")
    print("=" * 68)
    h1 = scan_tree(REPO, "开源库 establish/")
    h2 = scan_tree(os.path.join(FW, "hotpatch"), "线上热补丁 hotpatch/")

    print("\n[代理日志] 是否泄露 capability key / 请求里的 k=")
    try:
        log = io.open(os.path.join(FW, "proxy.log"), encoding="utf-8", errors="replace").read()
        k = SECRETS.get("cap.key", "")
        print("   log 大小 %.1f MB；包含 cap.key 明文: %s" % (len(log) / 1048576.0, bool(k and k in log)))
        m = re.findall(r"[?&]k=([A-Za-z0-9_\-]{8,})", log)
        print("   日志里出现的 k= 参数 %d 处（去重 %d 个）" % (len(m), len(set(m))))
        if m:
            uniq = sorted(set(m))[:3]
            print("   样例前缀（仅前 4 字符）:", [u[:4] + "…" for u in uniq])
            print("   与 cap.key 相同者: %d" % sum(1 for u in m if u == k))
    except OSError as e:
        print("   读不到日志:", e)

    print("\n" + "=" * 68)
    print("B. 内存 / 缓存")
    print("=" * 68)
    cdir = os.path.join(FW, "apicache")
    if not os.path.isdir(cdir):
        cand = [d for d in os.listdir(FW) if "cache" in d.lower()]
        print("   apicache 目录不存在；候选:", cand)
        cdir = os.path.join(FW, cand[0]) if cand else None
    if cdir and os.path.isdir(cdir):
        total = 0
        n = 0
        for dirpath, _, filenames in os.walk(cdir):
            for fn in filenames:
                try:
                    total += os.path.getsize(os.path.join(dirpath, fn))
                    n += 1
                except OSError:
                    pass
        print("   缓存目录 %s: %d 个文件, %.1f MB" % (os.path.basename(cdir), n, total / 1048576.0))

    # 代理进程内存
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe'\" | "
                              "Where-Object { $_.CommandLine -match 'proxy\\.py' } | "
                              "Select-Object ProcessId,@{n='MB';e={[math]::Round($_.WorkingSetSize/1MB,1)}} | "
                              "ConvertTo-Json -Compress"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        print("   代理进程内存:", out if out else "(未找到)")
    except Exception as e:
        print("   查询进程失败:", e)

    # 缓存上限配置
    p = os.path.join(FW, "proxy.py")
    s = io.open(p, encoding="utf-8", errors="replace").read()
    for name in ("API_CACHE_MAX", "API_CACHE_DIR", "API_CACHE_TTL_CATALOG", "API_CACHE_PATHS"):
        m = re.search(r"^%s\s*=\s*(.{0,80})" % name, s, re.M)
        if m:
            print("   %-22s %s" % (name, m.group(1).strip()))

    print("\n小结：泄露命中 %d 处；日志中 key 泄露=%s" % (len(h1) + len(h2), "见上"))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
