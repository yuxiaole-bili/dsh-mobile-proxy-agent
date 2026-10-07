# -*- coding: utf-8 -*-
"""定位 proxy.log 里 cap.key 的来源（输出时把密钥替换成 <KEY>）。同时查缓存上限配置。"""
import io
import os
import re
import sys

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
KEY = io.open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
LOG = os.path.join(FW, "proxy.log")


def redact(s):
    return s.replace(KEY, "<KEY>") if KEY else s


def main():
    s = io.open(LOG, encoding="utf-8", errors="replace").read()
    n = s.count(KEY)
    print("日志中出现密钥 %d 次" % n)
    lines = s.splitlines()
    hits = [(i, l) for i, l in enumerate(lines) if KEY in l]
    # 归类：按前缀（时间戳之后的部分）分组
    groups = {}
    for i, l in hits:
        m = re.match(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)?\s*(.{0,46})", l)
        head = (m.group(2) if m else l[:46])
        head = re.sub(r"[0-9a-f]{8,}", "<hex>", head)
        groups.setdefault(head, []).append(i)
    print("共 %d 条命中，归类 %d 种前缀：" % (len(hits), len(groups)))
    for head, idx in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:12]:
        print("   x%-5d 行号样例 %-9s | %s" % (len(idx), idx[:2], redact(head)[:90]))

    print("\n=== 头尾两条完整脱敏示例 ===")
    for i in ([hits[0][0]] if hits else []) + ([hits[-1][0]] if hits else []):
        print("   行%d: %s" % (i + 1, redact(lines[i])[:200]))

    print("\n=== 缓存上限配置 ===")
    p = os.path.join(FW, "proxy.py")
    src = io.open(p, encoding="utf-8", errors="replace").read()
    for name in re.findall(r"^(API_CACHE[A-Z_]*)\s*=", src, re.M):
        m = re.search(r"^%s\s*=\s*(.{0,90})" % name, src, re.M)
        print("   %-24s %s" % (name, m.group(1).strip() if m else ""))

    print("\n=== 日志脱敏会写回 ===")
    print("   规则：把 <KEY> 替换回原文即可（不动其它内容）；先备份 proxy.log")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
