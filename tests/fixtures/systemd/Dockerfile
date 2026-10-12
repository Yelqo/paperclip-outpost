FROM ubuntu:24.04 AS guest
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install --yes --no-install-recommends \
    linux-image-virtual initramfs-tools systemd systemd-sysv openssh-server bubblewrap git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN update-initramfs -c -k all
RUN useradd --create-home --shell /bin/bash worker \
    && passwd --delete root \
    && mkdir -p /root/.ssh /home/worker/workspaces /home/worker/scratch \
    && chown -R worker:worker /home/worker \
    && systemctl enable ssh systemd-networkd \
    && printf '[Match]\nName=en*\n[Network]\nDHCP=yes\n' > /etc/systemd/network/20-ethernet.network \
    && printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/fixture.conf \
    && printf 'kernel.apparmor_restrict_unprivileged_userns=0\n' > /etc/sysctl.d/99-fixture.conf

FROM ubuntu:24.04
RUN apt-get update && apt-get install --yes --no-install-recommends \
    qemu-system-x86 e2fsprogs openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=guest / /guest/
COPY boot.sh /boot.sh
COPY vm-exec /usr/local/bin/vm-exec
ENTRYPOINT ["/bin/bash", "/boot.sh"]
