# -*- coding: utf-8 -*-
"""把 dsh-mobile-kit 作为 **DSH 插件**装进 profile 并验证（用户要求"测试你自己作为 dsh 的插件"）。

做法（本机没有外网，跑不了 pnpm/registry）：
  在 profile 的 cordis.patch.yml 末尾追加一条 insert 行，name 用**绝对路径** ——
  dsh-app-boot 支持 insert 行的 name 写绝对路径 / file: URL / ./ 相对路径。
  HMR 默认开启，改完即时生效，不需要重启 DSH。

安全：先备份 cordis.patch.yml；只追加，不改动原有行。
"""
import io
import os
import shutil
import sys
import time

PROFILE = os.path.join(os.environ["USERPROFILE"], ".dsh", "profiles", "desktop")
PATCH = os.path.join(PROFILE, "cordis.patch.yml")
PLUGIN = r"<REPO>/plugin"
TS = time.strftime("%Y%m%d-%H%M%S")

ROW = """
# dsh-mobile-kit：手机端工具包（旧内核 polyfill + 移动端布局 + /mobile-kit 接口）
# 用绝对路径挂载 —— 本机无外网、不动 node_modules；删掉这一段即可卸载。
- insert:
    - id: mobile-kit
      name: '{plugin}'
""".format(plugin=PLUGIN)


def main():
    if not os.path.isfile(PATCH):
        print("找不到 %s" % PATCH)
        return 1
    s = io.open(PATCH, encoding="utf-8", newline="").read()
    if "mobile-kit" in s:
        print("cordis.patch.yml 里已经有 mobile-kit 行，跳过安装")
        return 0
    bak = PATCH + ".bak_mobilekit_" + TS
    shutil.copy2(PATCH, bak)
    print("备份: %s" % os.path.basename(bak))
    io.open(PATCH, "w", encoding="utf-8", newline="\n").write(s.rstrip("\n") + "\n" + ROW)
    print("已追加 insert 行 -> name = %s" % PLUGIN)
    print("---- 文件末尾 ----")
    tail = io.open(PATCH, encoding="utf-8").read().splitlines()[-8:]
    for l in tail:
        print("   " + l)
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
