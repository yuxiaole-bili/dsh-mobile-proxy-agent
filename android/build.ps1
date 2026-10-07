# 完全离线构建 DSH WebView APK（不需要 Gradle / 不需要网络）
$ErrorActionPreference = "Stop"
# 路径默认值可用环境变量覆盖（GitHub Actions: DSH_JDK / DSH_SDK / DSH_SRC / DSH_OUT）
$SRC  = if ($env:DSH_SRC) { $env:DSH_SRC } else { $PSScriptRoot }
$JDK  = if ($env:DSH_JDK) { $env:DSH_JDK } elseif ($env:JAVA_HOME) { $env:JAVA_HOME } else { "D:\Android\jdk-17.0.2" }
$SDK  = if ($env:DSH_SDK) { $env:DSH_SDK } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "D:\Android\sdk" }
$OUT  = if ($env:DSH_OUT) { $env:DSH_OUT } else { Join-Path $SRC "out" }
$BT   = (Get-ChildItem "$SDK\build-tools" -Directory -EA SilentlyContinue | Sort-Object Name | Select-Object -Last 1).FullName
if (-not $BT) { throw "find build-tools failed" }
$AJAR = (Get-ChildItem "$SDK\platforms\android-*\android.jar" -EA SilentlyContinue | Sort-Object FullName | Select-Object -Last 1).FullName
if (-not $AJAR) { throw "find android.jar failed" }


# —— 工具解析：Windows 用 .exe/.bat，Linux/macOS 用同名脚本 ——
function Resolve-Tool([string]$dir, [string]$name) {
  foreach ($c in @((Join-Path $dir "$name.exe"), (Join-Path $dir "$name.bat"), (Join-Path $dir $name))) {
    if (Test-Path $c) { return $c }
  }
  throw "找不到工具: $name (在 $dir)"
}
$IS_WIN = ($env:OS -eq "Windows_NT")
$PYEXE  = if ($IS_WIN) { "python" } else { "python3" }

$AAPT2 = Resolve-Tool $BT "aapt2"
$D8 = Resolve-Tool $BT "d8"
$ZIPALIGN = Resolve-Tool $BT "zipalign"
$APKSIGNER = Resolve-Tool $BT "apksigner"
$JAVAC = Resolve-Tool (Join-Path $JDK "bin") "javac"
$KEYTOOL = Resolve-Tool (Join-Path $JDK "bin") "keytool"

$env:JAVA_HOME = $JDK
$env:PATH = "$JDK\bin;$env:PATH"

Write-Host "=== 0) 清理 ==="
Remove-Item $OUT -Recurse -Force -EA SilentlyContinue
New-Item -ItemType Directory -Path "$OUT\classes","$OUT\dex" -Force | Out-Null

Write-Host "=== 1) aapt2 compile 资源 ==="
& $AAPT2 compile --dir "$SRC\res" -o "$OUT\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "=== 2) javac 编译 Java ==="
# javac prints an informational "uses or overrides a deprecated API" note on stderr
# (Theme_Holo_Light / onBackPressed are pre-existing). Windows PowerShell 5.1 turns any
# native stderr into a terminating NativeCommandError while $ErrorActionPreference=Stop,
# which aborted the build even though javac exited 0. Relax it for this call only and
# keep judging success by $LASTEXITCODE, which is the real signal.
$eap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $JAVAC -source 8 -target 8 -nowarn -encoding UTF-8 -bootclasspath $AJAR -classpath $AJAR `
  -d "$OUT\classes" "$SRC\java\ai\deepseek\dsh\mobile\MainActivity.java"
$ErrorActionPreference = $eap
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "=== 3) d8 -> classes.dex ==="
$classes = (Get-ChildItem "$OUT\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& $D8 --lib $AJAR --min-api 24 --output "$OUT\dex" @classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "=== 4) aapt2 link -> base.apk ==="
& $AAPT2 link -o "$OUT\base.apk" -I $AJAR --manifest "$SRC\AndroidManifest.xml" `
  --min-sdk-version 24 --target-sdk-version 34 --auto-add-overlay "$OUT\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "=== 5) 把 classes.dex + 预装资源打进 apk（Python zipfile，避免依赖 zip 工具）==="
$ASSETS = if ($env:DSH_ASSETS) { $env:DSH_ASSETS } else { Join-Path (Split-Path $SRC -Parent) "appassets" }
$py = @'
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
[System.IO.File]::WriteAllText("$OUT\_pack.py", ($py -replace "`r`n","`n"))
& $PYEXE "$OUT\_pack.py" "$OUT\base.apk" "$OUT\dex\classes.dex" "$OUT\unsigned.apk" "$ASSETS"
if ($LASTEXITCODE -ne 0) { throw "pack failed" }

Write-Host "=== 6) zipalign ==="
& $ZIPALIGN -f 4 "$OUT\unsigned.apk" "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "=== 7) 生成调试签名密钥 ==="
$ks = "$SRC\debug.keystore"
if (-not (Test-Path $ks)) {
  & $KEYTOOL -genkeypair -keystore $ks -storepass android -keypass android `
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
    -dname "CN=Android Debug,O=Android,C=US"
  if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

Write-Host "=== 8) apksigner 签名 ==="
& $APKSIGNER sign --ks $ks --ks-pass pass:android --key-pass pass:android `
  --out "$OUT\DSH.apk" "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

Write-Host "=== 9) 校验 ==="
& $APKSIGNER verify --print-certs "$OUT\DSH.apk"
if (Test-Path (Join-Path $BT ($(if ($IS_WIN) {"aapt.exe"} else {"aapt"})))) { & (Resolve-Tool $BT "aapt") dump badging "$OUT\DSH.apk" | Select-Object -First 4
Write-Host ("`nAPK: " + "$OUT\DSH.apk" + "  (" + (Get-Item "$OUT\DSH.apk").Length + " bytes)")
