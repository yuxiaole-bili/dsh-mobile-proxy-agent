#!/usr/bin/env bash
# 跨平台构建 DSH WebView APK（Linux/macOS/Git-Bash/WSL），不需要 Gradle、不需要联网。
# 与 android/build.ps1 等价：aapt2 compile -> javac -> d8 -> aapt2 link -> 打包 -> zipalign -> apksigner
#
# 环境变量：
#   JAVA_HOME     JDK 17 目录（必须）
#   ANDROID_HOME  Android SDK 目录（必须），需要 build-tools 与 platforms/android-34
#   APPASSETS     预装资源目录（可选，缺省用 <repo>/appassets，不存在就跳过）
#   KEYSTORE      keystore 路径（可选）。不给则自动生成 debug.keystore 并签名
#   KS_PASS/KEY_PASS/KS_ALIAS  默认 android/android/androiddebugkey
#   OUT           输出目录（默认 <repo>/out）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # <repo>/android
ROOT="$(cd "$SRC/.." && pwd)"
OUT="${OUT:-$ROOT/out}"
APPASSETS="${APPASSETS:-$ROOT/appassets}"

: "${JAVA_HOME:?请设置 JAVA_HOME（JDK 17）}"
: "${ANDROID_HOME:?请设置 ANDROID_HOME（Android SDK）}"

BT="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$BT" ] || { echo "找不到 build-tools，请先 sdkmanager 'build-tools;34.0.0'"; exit 1; }
AJAR="$(ls "$ANDROID_HOME"/platforms/android-*/android.jar 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$AJAR" ] || { echo "找不到 platforms/android-*/android.jar，请先 sdkmanager 'platforms;android-34'"; exit 1; }

# 兼容 .exe（Git-Bash/Windows 下的 SDK 只有 .exe/.bat）
pick() { for c in "$@"; do [ -x "$c" ] && { echo "$c"; return; }; [ -f "$c" ] && { echo "$c"; return; }; done; }
AAPT2="$(pick "$BT/aapt2" "$BT/aapt2.exe")"
D8="$(pick "$BT/d8" "$BT/d8.bat")"
ZIPALIGN="$(pick "$BT/zipalign" "$BT/zipalign.exe")"
APKSIGNER="$(pick "$BT/apksigner" "$BT/apksigner.bat")"
KEYTOOL="$(pick "$JAVA_HOME/bin/keytool" "$JAVA_HOME/bin/keytool.exe")"
JAVAC="$(pick "$JAVA_HOME/bin/javac" "$JAVA_HOME/bin/javac.exe")"
JAR="$(pick "$JAVA_HOME/bin/jar" "$JAVA_HOME/bin/jar.exe")"
for v in AAPT2 D8 ZIPALIGN APKSIGNER KEYTOOL JAVAC; do
  [ -n "${!v}" ] || { echo "缺少工具: $v（检查 ANDROID_HOME/JAVA_HOME）"; exit 1; }
done

echo "=== 0) 清理 ==="
rm -rf "$OUT"; mkdir -p "$OUT/classes" "$OUT/dex"

echo "=== 1) aapt2 compile 资源 ==="
"$AAPT2" compile --dir "$SRC/res" -o "$OUT/res.zip"

echo "=== 2) javac 编译 Java ==="
"$JAVAC" -source 8 -target 8 -nowarn -encoding UTF-8 -bootclasspath "$AJAR" -classpath "$AJAR" \
  -d "$OUT/classes" "$SRC/java/ai/deepseek/dsh/mobile/MainActivity.java" 2>&1 | grep -v 'deprecat' || true
[ -f "$OUT/classes/ai/deepseek/dsh/mobile/MainActivity.class" ] || { echo "javac 未产出 class"; exit 1; }

echo "=== 3) d8 -> classes.dex ==="
CLASSES=$(find "$OUT/classes" -name '*.class')
if [ -n "$JAR" ]; then ( cd "$OUT/classes" && find . -name '*.class' -print0 | xargs -0 "$JAR" cf "$OUT/classes.jar" ); fi
"$D8" --lib "$AJAR" --min-api 24 --output "$OUT/dex" $CLASSES
[ -f "$OUT/dex/classes.dex" ] || { echo "d8 未产出 classes.dex"; exit 1; }

echo "=== 4) aapt2 link -> base.apk ==="
"$AAPT2" link -o "$OUT/base.apk" -I "$AJAR" --manifest "$SRC/AndroidManifest.xml" \
  --min-sdk-version 24 --target-sdk-version 34 --auto-add-overlay "$OUT/res.zip"

echo "=== 5) 打包 classes.dex + 预装资源 ==="
python3 - "$OUT/base.apk" "$OUT/dex/classes.dex" "$OUT/unsigned.apk" "$APPASSETS" <<'PY'
import sys, zipfile, shutil, os
base, dex, out, assets = sys.argv[1:5]
shutil.copyfile(base, out)
with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
    n = 0
    if os.path.isdir(assets):
        for name in sorted(os.listdir(assets)):
            p = os.path.join(assets, name)
            if os.path.isfile(p):
                z.write(p, "assets/bundle/" + name); n += 1
    print("packed assets:", n)
print("packed classes.dex ->", out)
PY

echo "=== 6) zipalign ==="
"$ZIPALIGN" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "=== 7) 签名 ==="
KS="${KEYSTORE:-$ROOT/debug.keystore}"
KS_PASS="${KS_PASS:-android}"; KEY_PASS="${KEY_PASS:-android}"; KS_ALIAS="${KS_ALIAS:-androiddebugkey}"
if [ ! -f "$KS" ]; then
  echo "  生成 debug keystore（仅本地调试用；正式发布请用 Secrets 提供固定 keystore）"
  "$KEYTOOL" -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KEY_PASS" \
    -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US"
fi
SIGNED="$OUT/DSH.apk"
"$APKSIGNER" sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" --out "$SIGNED" "$OUT/aligned.apk"

echo "=== 8) 校验 ==="
"$APKSIGNER" verify --print-certs "$SIGNED" | head -4
ls -l "$SIGNED"
echo "APK: $SIGNED"
