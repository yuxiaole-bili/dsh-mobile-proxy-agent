# -*- coding: utf-8 -*-
"""收尾：① 打印剩余命中的确切位置（区分"真泄露/范围判断/仅在本地未开源"）
        ② 核对线上热补丁 vs 仓库是否一致
        ③ 写入 docs/SECURITY.md，README 追加本轮变更段，重建 MANIFEST"""
import hashlib
import io
import os
import re
import sys

FW = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward")
REPO = r"<REPO>\establish"
KEY = io.open(os.path.join(FW, "cap.key"), encoding="utf-8").read().strip()
SKIP_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico", ".zip", ".apk", ".pyc"}


def hits(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__")]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in SKIP_EXT:
                continue
            p = os.path.join(dirpath, fn)
            try:
                s = io.open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            rel = os.path.relpath(p, root)
            for pat, name in ((re.escape(KEY), "**cap.key 明文**") if KEY else (r"(?!x)x", "-"),
                              (r"\b192\.168\.\d{1,3}\.\d{1,3}\b", "内网 IP"),
                              (r"\b100\.(?:8[0-9]|9[0-9]|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b", "Tailscale IP"),
                              (r"<USER>", "个人目录")):
                for m in re.finditer(pat, s):
                    line = s[:m.start()].count("\n") + 1
                    out.append((rel, line, name, m.group(0)[:26]))
    return out


def main():
    print("=" * 66)
    print("剩余命中明细")
    print("=" * 66)
    h = hits(REPO)
    print("\n[开源库 establish/]  %d 处" % len(h))
    for rel, ln, name, frag in h:
        print("   %-52s L%-5d %-14s %s" % (rel, ln, name, frag))
    print("\n[线上 hotpatch/]（本地运行目录，未开源）")
    h2 = hits(os.path.join(FW, "hotpatch"))
    files = sorted({r for r, _, _, _ in h2})
    for f in files:
        print("   " + f)
    print("   共 %d 处，全部位于：%s" % (len(h2), "已停用的补丁与说明文档" if all(("disabled" in f or f.endswith(".md")) for f in files) else "见上"))

    print("\n" + "=" * 66)
    print("线上 vs 仓库 热补丁一致性")
    print("=" * 66)
    live = os.path.join(FW, "hotpatch")
    dst = os.path.join(REPO, "proxy", "hotpatch")
    bad = 0
    for fn in sorted(os.listdir(live)):
        if ".bak" in fn or fn.endswith(".md"):
            continue
        target = fn.replace(".disabled_", ".disabled.") if ".disabled_" in fn else fn
        a, b = os.path.join(live, fn), os.path.join(dst, target)
        if not os.path.exists(b):
            print("   仓库缺失: %s" % target)
            bad += 1
            continue
        ha = hashlib.md5(open(a, "rb").read()).hexdigest()[:10]
        hb = hashlib.md5(open(b, "rb").read()).hexdigest()[:10]
        if ha != hb:
            print("   不一致: %-30s live=%s repo=%s" % (fn, ha, hb))
            bad += 1
    print("   %s" % ("✅ 全部一致" if bad == 0 else "⚠ %d 处不一致" % bad))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
