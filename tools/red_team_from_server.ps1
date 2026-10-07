# External (red-team) probe from the server against the proxy + VM provisioning readiness.
# ASCII only. Does NOT copy any credential to the server: unauthenticated probes only.
$ErrorActionPreference = 'SilentlyContinue'
function Line($s) { Write-Output $s }

$remote = @'
TARGET="http://<PC-LAN-IP>:19390"
echo "===== A. reachability from server (external attacker view) ====="
curl -s -o /dev/null -w "  /__health        -> %{http_code}  %{time_total}s\n" --max-time 8 "$TARGET/__health"
curl -s -o /dev/null -w "  /                -> %{http_code}  %{time_total}s\n" --max-time 8 "$TARGET/"
curl -s -o /dev/null -w "  /__hot/patch.js  -> %{http_code}\n" --max-time 8 "$TARGET/__hot/patch.js"
curl -s -o /dev/null -w "  /api/session/list-> %{http_code}\n" --max-time 8 -X POST -H "content-type: application/json" -d '{}' "$TARGET/api/session/list"
curl -s -o /dev/null -w "  /f?path=...      -> %{http_code}\n" --max-time 8 "$TARGET/f?path=C:%5CWindows%5Cwin.ini"
echo "  --- port scan of PC (top ports) ---"
for p in 19390 19387 19395 3389 445 22 5900; do
  timeout 3 bash -c "echo > /dev/tcp/<PC-LAN-IP>/$p" 2>/dev/null && echo "  OPEN  $p" || echo "  closed $p"
done
echo "  --- what leaks without auth (first 200 bytes of the 403 body) ---"
curl -s --max-time 8 "$TARGET/__hot/patch.js" | head -c 200; echo
echo "  --- is the key guessable? try common values (3 only, non-bruteforce) ---"
for k in test 123456 dsh; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 "$TARGET/f?path=README.md&k=$k")
  echo "  k=$k -> $code"
done

echo ""
echo "===== B. VM provisioning readiness ====="
echo "  --- internet ---"
for u in https://mirrors.aliyun.com https://cloud-images.ubuntu.com https://github.com; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$u" 2>/dev/null)
  echo "  $u -> ${code:-000}"
done
echo "  --- kvm device ---"
ls -l /dev/kvm 2>/dev/null || echo "  /dev/kvm MISSING"
echo "  --- libvirt state ---"
virsh list --all 2>/dev/null | head -5
virsh net-list --all 2>/dev/null | head -5
echo "  --- virt-install / cloud-init ---"
for b in virt-install cloud-localds qemu-img wget curl python3; do
  command -v $b >/dev/null 2>&1 && echo "  have $b" || echo "  missing $b"
done
echo "  --- docker local images ---"
docker images 2>/dev/null | head -8
echo "  --- free space for images ---"
df -h /var/lib/libvirt 2>/dev/null | tail -1
'@
Line ($remote | ssh -o BatchMode=yes -o ConnectTimeout=10 ss_100 "bash -s" 2>&1 | Out-String)
