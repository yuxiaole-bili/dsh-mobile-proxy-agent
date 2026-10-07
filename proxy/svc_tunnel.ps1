# Keep an SSH tunnel alive so this Windows PC can reach the yuxiaole
# svc_restart endpoint (127.0.0.1:19395 on the server, firewalled from outside).
$SSH = "$env:SystemRoot\System32\OpenSSH\ssh.exe"
if (-not (Test-Path $SSH)) { $SSH = "ssh.exe" }
$KEY = "$env:USERPROFILE\.ssh\id_ed25519_opencode"
while ($true) {
    try {
        & $SSH -N -o BatchMode=yes -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes `
               -o ServerAliveInterval=20 -o ServerAliveCountMax=3 `
               -i $KEY -L 19395:127.0.0.1:19395 OPENCODE@<SRV-LAN-IP>
    } catch { }
    Start-Sleep -Seconds 3
}
