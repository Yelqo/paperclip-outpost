#!/bin/bash
set -eu
ssh-keygen -q -t ed25519 -N '' -f /tmp/fixture-key
cp /tmp/fixture-key.pub /guest/root/.ssh/authorized_keys
chmod 700 /guest/root/.ssh
chmod 600 /guest/root/.ssh/authorized_keys
mkdir -p /guest/srv
cp "/input/outpost-$OUTPOST_TEST_RELEASE-linux-amd64" /guest/srv/selected-outpost
chmod 755 /guest/srv/selected-outpost
truncate -s 3G /tmp/guest.img
mkfs.ext4 -q -F -d /guest /tmp/guest.img
exec qemu-system-x86_64 -machine accel=tcg -cpu max -m 768 -smp 2 \
    -kernel /guest/boot/vmlinuz-* -initrd /guest/boot/initrd.img-* \
    -append 'root=/dev/vda rw console=ttyS0 net.ifnames=1' \
    -drive file=/tmp/guest.img,format=raw,if=virtio \
    -netdev user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:32222-:22 \
    -device virtio-net-pci,netdev=net0 -nographic
