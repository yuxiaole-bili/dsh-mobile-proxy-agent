# -*- coding: utf-8 -*-
"""proxy.py：让 /f /d /dl 也接受"工作区相对路径"和"裸文件名（唯一匹配）"。

起因：会话里的文件 chip 只给得到 `out/t54_ortho3b.png`（相对）或 `t54_ortho3b.png`（裸名），
而 _file_ok 以前只认绝对路径（相对一律 403），所以自建预览层拿不到文件。

安全边界不变：仍要求解析后的 realpath 落在白名单根目录内；`..` 仍然一律拒绝；
裸文件名只在**唯一匹配**时才放行；遍历有深度/条目上限并跳过 node_modules/.git 等。
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

PROXY = os.path.join(os.environ["LOCALAPPDATA"], "dsh-gui-forward", "proxy.py")
TS = time.strftime("%Y%m%d-%H%M%S")

HELPER = '''
def _file_resolve_relative(p):
    """工作区相对路径 / 裸文件名 -> 绝对路径；解析不到或不唯一返回 None。

    · 相对路径：逐个白名单根目录拼接，命中且仍在根内才返回；
    · 裸文件名：在根目录下浅层找同名文件，**只有唯一匹配**才返回；
    · 跳过 node_modules/.git/__pycache__ 等目录，并有深度与条目上限，避免卡住。
    """
    rel = p.replace("/", os.sep).replace("\\\\", os.sep).lstrip("\\\\/")
    if not rel:
        return None
    roots = _file_roots()
    for _r, _rl in roots:
        try:
            cand = os.path.realpath(os.path.join(_r, rel))
        except Exception:
            continue
        low = cand.lower()
        if (low == _rl or low.startswith(_rl + os.sep)) and os.path.isfile(cand):
            return cand
    if os.sep in rel:
        return None
    skip = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", ".next"}
    want = rel.lower()
    hits = []
    budget = [20000]
    for _r, _rl in roots:
        for base, dirs, files in os.walk(_r):
            dirs[:] = [d for d in dirs if d.lower() not in skip]
            depth = os.path.relpath(base, _r).count(os.sep)
            if depth >= 4:
                dirs[:] = []
            budget[0] -= len(files) + 1
            if budget[0] <= 0:
                return None
            for f in files:
                if f.lower() == want:
                    hits.append(os.path.join(base, f))
                    if len(hits) > 1:
                        return None
    if len(hits) == 1:
        return os.path.realpath(hits[0])
    return None


def _file_ok(uri, cookie_key_ok=False):'''

OLD_UNCHANGED = '''def _file_ok(uri, cookie_key_ok=False):'''

ANCHOR_ABS = '''    if not re.match(r"^[A-Za-z]:[\\\\/]", p) and not os.path.isabs(p):
        return False, None, "path must be absolute"
'''

NEW_ABS = '''    if not re.match(r"^[A-Za-z]:[\\\\/]", p) and not os.path.isabs(p):
        # 工作区相对路径或裸文件名：交给 _file_resolve_relative 解析（仍受白名单约束）
        relp = _file_resolve_relative(p)
        if relp is None:
            return False, None, "path must be absolute (relative not resolved)"
        p = relp
'''


def md5(path):
    return hashlib.md5(open(path, "rb").read()).hexdigest()


def main():
    s = open(PROXY, encoding="utf-8", newline="").read()
    if "_file_resolve_relative" in s:
        print("already patched")
        return 0
    if s.count(OLD_UNCHANGED) != 1:
        print("ABORT: _file_ok definition occurs %d times" % s.count(OLD_UNCHANGED))
        return 1
    if s.count(ANCHOR_ABS) != 1:
        print("ABORT: absolute-path anchor occurs %d times" % s.count(ANCHOR_ABS))
        return 1

    before = md5(PROXY)
    s = s.replace(OLD_UNCHANGED, HELPER, 1)
    s = s.replace(ANCHOR_ABS, NEW_ABS, 1)
    bak = PROXY + ".bak_relpath_" + TS
    shutil.copy2(PROXY, bak)
    open(PROXY, "w", encoding="utf-8", newline="\n").write(s)
    print("proxy.py %d -> %d B  md5 %s -> %s" % (len(s.encode("utf-8")), os.path.getsize(PROXY), before, md5(PROXY)))
    print("backup: %s" % os.path.basename(bak))

    r = subprocess.run([sys.executable, "-m", "py_compile", PROXY], capture_output=True, text=True)
    print("py_compile rc=%d %s" % (r.returncode, (r.stdout + r.stderr).strip()[:200]))
    if r.returncode != 0:
        shutil.copy2(bak, PROXY)
        print("!! 回滚（语法不过）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
