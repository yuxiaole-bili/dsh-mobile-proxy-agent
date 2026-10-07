# VM feasibility recon (read-only, ASCII only to avoid PS5.1 encoding issues)
$ErrorActionPreference = 'SilentlyContinue'
function Line($s) { Write-Output $s }

Line "===== 1. PC virtualization capability ====="
$os = Get-CimInstance Win32_OperatingSystem
Line ("  OS: {0}  RAM: {1:N1} GB" -f $os.Caption, ($os.TotalVisibleMemorySize/1MB))
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Line ("  CPU: {0}" -f $cpu.Name)
Line ("  VirtualizationFirmwareEnabled: {0}  SLAT: {1}" -f $cpu.VirtualizationFirmwareEnabled, $cpu.SecondLevelAddressTranslationExtensions)
foreach ($b in @('VBoxManage','vmrun','qemu-system-x86_64','docker','wsl')) {
  $c = Get-Command $b -ErrorAction SilentlyContinue
  if ($c) { Line ("  {0,-22} INSTALLED: {1}" -f $b, $c.Source) } else { Line ("  {0,-22} not installed" -f $b) }
}
foreach ($f in @('Microsoft-Hyper-V-All','VirtualMachinePlatform','Microsoft-Windows-Subsystem-Linux')) {
  $s = (Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction SilentlyContinue).State
  if ($s) { Line ("  feature {0,-38} {1}" -f $f, $s) } else { Line ("  feature {0,-38} query failed" -f $f) }
}
Line "  Disk free:"
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -gt 0 } | ForEach-Object {
  Line ("    {0}: {1:N1} GB free" -f $_.Name, ($_.Free/1GB))
}

Line ""
Line "===== 2. Existing ISO images on PC ====="
$dirs = @("$env:USERPROFILE\Downloads", "D:\", "D:\iso", "D:\vms", "C:\iso")
$found = @()
foreach ($d in $dirs) { if (Test-Path $d) { $found += Get-ChildItem -Path $d -Filter *.iso -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 5 } }
if ($found.Count -gt 0) { $found | ForEach-Object { Line ("  {0}  {1:N2} GB" -f $_.FullName, ($_.Length/1GB)) } } else { Line "  no .iso found" }

Line ""
Line "===== 3. Server (ss_100) capability ====="
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Line "  no ssh client"; exit 0 }
$remote = @'
echo "  --- OS ---"; (uname -a 2>/dev/null || ver) | head -2
echo "  --- CPU virt flags ---"; grep -m1 -o -E "vmx|svm" /proc/cpuinfo 2>/dev/null || echo "  none"
echo "  --- mem/disk ---"; free -m 2>/dev/null | head -2; df -h / 2>/dev/null | tail -1
echo "  --- hypervisors ---"
for b in virsh VBoxManage qemu-system-x86_64 docker vmrun; do
  if command -v $b >/dev/null 2>&1; then echo "  INSTALLED $b -> $(command -v $b)"; else echo "  missing $b"; fi
done
echo "  --- images ---"; ls -1 /var/lib/libvirt/images/ 2>/dev/null | head -5
find / -maxdepth 4 \( -name "*.iso" -o -name "*.qcow2" \) 2>/dev/null | head -5
echo "  --- internet ---"
for u in https://mirrors.aliyun.com https://github.com; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 "$u" 2>/dev/null); echo "  $u -> ${code:-000}"
done
'@
Line ($remote | ssh -o BatchMode=yes -o ConnectTimeout=10 ss_100 "bash -s" 2>&1 | Out-String)
Line "===== recon done ====="
