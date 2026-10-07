#!/usr/bin/env bash
# Create a dedicated attacker VM with libvirt/KVM on the LAN bridge. Needs sudo. ASCII only.
# Authorized use: drills against the owner's own assets.
set -u
NAME=attacker
BASE=/mnt/data/kvm/iso/ubuntu-22.04-cloudimg.img
DISK=/var/lib/libvirt/images/$NAME.qcow2
SEED=/var/lib/libvirt/images/$NAME-seed.iso
LOG=/tmp/prov_attacker_kvm.log

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== 0. checks ==="
[ -r /dev/kvm ] && say "kvm rw ok" || { say "FATAL /dev/kvm not rw"; exit 1; }
[ -r "$BASE" ] && say "base image ok ($(du -h "$BASE" | cut -f1))" || { say "FATAL base image missing"; exit 1; }
PUB=$(cat /tmp/attacker_pubkey 2>/dev/null || echo "")
[ -z "$PUB" ] && { say "FATAL /tmp/attacker_pubkey missing"; exit 1; }
say "pubkey bytes: ${#PUB}"

if virsh dominfo "$NAME" >/dev/null 2>&1; then
  say "VM exists: $(virsh domstate "$NAME")"
else
  say "=== 1. seed ==="
  cat >/tmp/$NAME-user-data <<EOF
#cloud-config
hostname: $NAME
manage_etc_hosts: true
users:
  - name: pentest
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $PUB
ssh_pwauth: false
package_update: true
packages: [curl, nmap, netcat-openbsd, tcpdump, jq, python3-pip, dnsutils]
runcmd:
  - [ sh, -c, "pip3 install --no-cache-dir requests >/dev/null 2>&1 || true" ]
  - [ sh, -c, "echo ready > /tmp/ready" ]
EOF
  printf 'instance-id: %s-001\nlocal-hostname: %s\n' "$NAME" "$NAME" >/tmp/$NAME-meta-data
  cloud-localds "$SEED" /tmp/$NAME-user-data /tmp/$NAME-meta-data && say "seed ok"
  say "=== 2. disk overlay ==="
  [ -f "$DISK" ] || qemu-img create -f qcow2 -b "$BASE" -F qcow2 "$DISK" 24G
  chown libvirt-qemu:kvm "$DISK" "$SEED" 2>/dev/null
  say "disk: $(du -h "$DISK" | cut -f1)"
  say "=== 3. virt-install (LAN bridge + default NAT) ==="
  virt-install --name "$NAME" --memory 6144 --vcpus 4 --cpu host-passthrough \
    --disk path="$DISK",format=qcow2,bus=virtio \
    --disk path="$SEED",device=cdrom \
    --os-variant ubuntu22.04 \
    --network network=hostbr0,model=virtio \
    --network network=default,model=virtio \
    --graphics none --import --noautoconsole 2>&1 | tee -a "$LOG"
fi

say "=== 4. wait for an address ==="
for i in $(seq 1 40); do
  ip1=$(virsh domifaddr "$NAME" --source arp 2>/dev/null | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -1)
  lease=$(virsh net-dhcp-leases default 2>/dev/null | awk '/ipv4/ {print $5}' | cut -d/ -f1 | head -1)
  [ -n "$ip1$lease" ] && { say "ip(arp)=${ip1:-none} ip(default-nat)=${lease:-none}"; break; }
  sleep 10
done
say "=== 5. state ==="
virsh list --all | sed -n '1,6p'
virsh domiflist "$NAME" 2>/dev/null
say "=== ssh:  ssh -J ss_100 pentest@<ip>  (key id_ed25519) ==="
