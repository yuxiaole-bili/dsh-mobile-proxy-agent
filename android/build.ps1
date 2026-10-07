# 构建 DSH WebView APK —— 跨平台（Windows / Linux / macOS，pwsh 7 或 Windows PowerShell 5.1）
# 不需要 Gradle、不需要联网。流程：aapt2 compile -> javac -> d8 -> aapt2 link -> 打包 -> zipalign -> apksigner
#
# 可用环境变量覆盖：DSH_SRC / DSH_OUT / DSH_JDK / DSH_SDK / DSH_ASSETS / KEYSTORE / KS_PASS / KEY_PASS / KS_ALIAS
$ErrorActionPreference = "Stop"
$IS_WIN = ($env:OS -eq "Windows_NT")
$PYEXE  = if ($IS_WIN) { "python" } else { "python3" }

# 路径全部用 Join-Path，避免 Linux 上反斜杠不被识别
$SRC     = if ($env:DSH_SRC) { $env:DSH_SRC } else { $PSScriptRoot }
$JDK     = if ($env:DSH_JDK) { $env:DSH_JDK } elseif ($env:JAVA_HOME) { $env:JAVA_HOME } else { "D:\Android\jdk-17.0.2" }
$SDK     = if ($env:DSH_SDK) { $env:DSH_SDK } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "D:\Android\sdk" }
$OUT     = if ($env:DSH_OUT) { $env:DSH_OUT } else { Join-Path $SRC "out" }
$ASSETS  = if ($env:DSH_ASSETS) { $env:DSH_ASSETS } else { Join-Path (Split-Path $SRC -Parent) "appassets" }
$RESDIR  = Join-Path $SRC "res"
$MANIFEST = Join-Path $SRC "AndroidManifest.xml"
$MAINJAVA = Join-Path $SRC "java/ai/deepseek/dsh/mobile/MainActivity.java"

function Resolve-Tool([string]$dir, [string]$name) {
  foreach ($c in @((Join-Path $dir ($name + ".exe")), (Join-Path $dir ($name + ".bat")), (Join-Path $dir $name))) {
    if (Test-Path $c) { return $c }
  }
  throw "找不到工具: $name （在 $dir）"
}

$BTDIR = Get-ChildItem (Join-Path $SDK "build-tools") -Directory -ErrorAction SilentlyContinue |
         Sort-Object Name | Select-Object -Last 1
if (-not $BTDIR) { throw "找不到 build-tools，请先安装（sdkmanager 'build-tools;34.0.0'）" }
$BT = $BTDIR.FullName
$AJAR = Get-ChildItem (Join-Path $SDK "platforms") -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name | ForEach-Object { Join-Path $_.FullName "android.jar" } |
        Where-Object { Test-Path $_ } | Select-Object -Last 1
if (-not $AJAR) { throw "找不到 platforms/android-*/android.jar" }

$AAPT2    = Resolve-Tool $BT "aapt2"
$D8       = Resolve-Tool $BT "d8"
$ZIPALIGN = Resolve-Tool $BT "zipalign"
$APKSIGNER = Resolve-Tool $BT "apksigner"
$JAVAC    = Resolve-Tool (Join-Path $JDK "bin") "javac"
$KEYTOOL  = Resolve-Tool (Join-Path $JDK "bin") "keytool"

$env:JAVA_HOME = $JDK
$env:PATH = (Join-Path $JDK "bin") + [IO.Path]::PathSeparator + $env:PATH

Write-Host "=== 0) 环境 ==="
Write-Host "  SRC=$SRC"
Write-Host "  OUT=$OUT"
Write-Host "  BT=$BT"
Write-Host "  assets=$ASSETS $(if (Test-Path $ASSETS) { '(存在)' } else { '(缺失，将产出联网版)' })"

Write-Host "=== 1) 清理 ==="
Remove-Item $OUT -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $OUT "classes"), (Join-Path $OUT "dex") -Force | Out-Null

Write-Host "=== 2) aapt2 compile 资源 ==="
& $AAPT2 compile --dir $RESDIR -o (Join-Path $OUT "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "=== 3) javac 编译 Java ==="
$eap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $JAVAC -source 8 -target 8 -nowarn -encoding UTF-8 -bootclasspath $AJAR -classpath $AJAR -d (Join-Path $OUT "classes") $MAINJAVA
$ErrorActionPreference = $eap
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "=== 4) d8 -> classes.dex ==="
$classes = (Get-ChildItem (Join-Path $OUT "classes") -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& $D8 --lib $AJAR --min-api 24 --output (Join-Path $OUT "dex") @classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "=== 5) aapt2 link -> base.apk ==="
& $AAPT2 link -o (Join-Path $OUT "base.apk") -I $AJAR --manifest $MANIFEST --min-sdk-version 24 --target-sdk-version 34 --auto-add-overlay (Join-Path $OUT "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "=== 6) 打包 classes.dex + 预装资源 ==="
$pack = @'
import sys, zipfile, shutil, os
base, dex, out, assets = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
shutil.copyfile(base, out)
with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
    n = 0
    if os.path.isdir(assets):
        for name in sorted(os.listdir(assets)):
            p = os.path.join(assets, name)
            if os.path.isfile(p):
                z.write(p, "assets/bundle/" + name)
                n += 1
    print("packed assets:", n)
print("packed classes.dex ->", out)
'@
$packPath = Join-Path $OUT "_pack.py"
[IO.File]::WriteAllText($packPath, ($pack -replace "`r`n", "`n"))
& $PYEXE $packPath (Join-Path $OUT "base.apk") (Join-Path $OUT "dex/classes.dex") (Join-Path $OUT "unsigned.apk") $ASSETS
if ($LASTEXITCODE -ne 0) { throw "pack failed" }

Write-Host "=== 7) zipalign ==="
& $ZIPALIGN -f 4 (Join-Path $OUT "unsigned.apk") (Join-Path $OUT "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "=== 8) 签名 ==="
$KS = if ($env:KEYSTORE) { $env:KEYSTORE } else { Join-Path (Split-Path $SRC -Parent) "debug.keystore" }
$KS_PASS  = if ($env:KS_PASS)  { $env:KS_PASS }  else { "android" }
$KEY_PASS = if ($env:KEY_PASS) { $env:KEY_PASS } else { "android" }
$KS_ALIAS = if ($env:KS_ALIAS) { $env:KS_ALIAS } else { "androiddebugkey" }
if (-not (Test-Path $KS)) {
  Write-Host "  生成 debug keystore（仅调试/尝鲜用；正式发布请用固定 keystore）"
  & $KEYTOOL -genkeypair -keystore $KS -storepass $KS_PASS -keypass $KEY_PASS -alias $KS_ALIAS -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
  if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

Write-Host "=== 9) apksigner 签名 + 校验 ==="
$SIGNED = Join-Path $OUT "DSH.apk"
& $APKSIGNER sign --ks $KS --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" --out $SIGNED (Join-Path $OUT "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }
& $APKSIGNER verify --print-certs $SIGNED | Select-Object -First 3
$size = (Get-Item $SIGNED).Length
Write-Host ("APK: " + $SIGNED + "  (" + $size + " bytes / " + [math]::Round($size / 1MB, 2) + " MB)")
