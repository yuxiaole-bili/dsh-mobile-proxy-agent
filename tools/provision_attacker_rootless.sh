#!/usr/bin/env bash
# Rootless attacker VM on the server: plain qemu + user-mode networking (no sudo, no libvirt).
# Authorized use only: drills against the owner's own assets. ASCII only.
set -u
VMDIR="$HOME/vms"
BASE="$VMDIR/jammy-base.img"
DISK="$VMDIR/attacker.qcow2"
SEED="$VMDIR/seed.iso"
SER="$VMDIR/serial.log"
URL=https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
SSHPORT=2222
LOG="$VMDIR/provision.log"
mkdir -p "$VMDIR"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== 0. environment ==="
say "user=$(id -un) home=$HOME dir=$VMDIR"
if id -nG | tr ' ' '\n' | grep -qx kvm; then ACCEL="-enable-kvm"; say "kvm group: yes -> $ACCEL"; else ACCEL=""; say "kvm group: no -> TCG (slower)"; fi
command -v qemu-system-x86_64 >/dev/null || { say "FATAL no qemu"; exit 1; }
command -v cloud-localds >/dev/null || { say "FATAL no cloud-localds"; exit 1; }
avail=$(df -BG --output=avail "$VMDIR" | tail -1 | tr -dc 0-9); say "free: ${avail} GB"

if [ -f "$VMDIR/attacker.pid" ] && kill -0 "$(cat "$VMDIR/attacker.pid")" 2>/dev/null; then
  say "VM already running pid=$(cat "$VMDIR/attacker.pid")"
  exit 0
fi

say "=== 1. base image ==="
if [ ! -s "$BASE" ]; then
  wget -q -c -O "$BASE.part" "$URL" || { say "download FAILED"; exit 1; }
  mv "$BASE.part" "$BASE"
fi
say "base: $(du -h "$BASE" | cut -f1)"

say "=== 2. overlay + seed ==="
[ -f "$DISK" ] || qemu-img create -f qcow2 -b "$BASE" -F qcow2 "$DISK" 24G >/dev/null
PUB=$(cat /tmp/attacker_pubkey 2>/dev/null || echo "")
[ -z "$PUB" ] && { say "FATAL no /tmp/attacker_pubkey"; exit 1; }
cat >"$VMDIR/user-data" <<EOF
#cloud-config
hostname: attacker
users:
  - name: pentest
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $PUB
package_update: true
packages: [curl, nmap, netcat-openbsd, tcpdump, jq, python3-pip]
runcmd:
  - [ sh, -c, "pip3 install --no-cache-dir requests >/dev/null 2>&1 || true" ]
  - [ sh, -c, "touch /tmp/ready" ]
EOF
printf 'instance-id: attacker-001\nlocal-hostname: attacker\n' >"$VMDIR/meta-data"
[ -f "$SEED" ] || cloud-localds "$SEED" "$VMDIR/user-data" "$VMDIR/meta-data" >/dev/null
say "seed: $(du -h "$SEED" | cut -f1)"

say "=== 3. launch (user-mode net, ssh on 127.0.0.1:$SSHPORT) ==="
qemu-system-x86_64 $ACCEL -m 4096 -smp 2 -cpu max \
  -drive file="$DISK",if=virtio,format=qcow2 \
  -drive file="$SEED",media=cdrom \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$SSHPORT-:22 \
  -device virtio-net-pci,netdev=n0 \
  -display none -serial "file:$SER" -daemonize -pidfile "$VMDIR/attacker.pid"
say "qemu pid: $(cat "$VMDIR/attacker.pid" 2>/dev/null)"

say "=== 4. wait for ssh ==="
for i in $(seq 1 60); do
  if timeout 4 bash -c "echo > /dev/tcp/127.0.0.1/$SSHPORT" 2>/dev/null; then say "ssh port UP after $((i*10))s"; break; fi
  sleep 10
done
say "=== done: ssh -i <key> -p $SSHPORT pentest@127.0.0.1 ==="
tail -5 "$SER" 2>/dev/null
