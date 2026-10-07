import os
import subprocess
import sys
import time

D = os.path.dirname(os.path.abspath(__file__))
# 用 pythonw.exe + CREATE_NO_WINDOW 启动 proxy.py：
# 之前这里把 pythonw 换成了 python.exe，父进程无控制台而子进程有，
# Windows 每次都要新建控制台 → 每次重启（关窗后 3 秒 / 开机登录）弹黑窗。
PY = sys.executable
if PY.lower().endswith("python.exe"):
    cand = PY[: -len("python.exe")] + "pythonw.exe"
    if os.path.exists(cand):
        PY = cand
CREATE_NO_WINDOW = 0x08000000
while True:
    try:
        subprocess.run([PY, os.path.join(D, "proxy.py")], creationflags=CREATE_NO_WINDOW)
    except Exception:
        pass
    time.sleep(3)
