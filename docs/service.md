# Standalone installation and systemd

The operator selects a standalone Linux release and installs a **system service**
with `User=worker`. The worker is an existing dedicated, unprivileged account on
a prepared machine. There is no user login or linger requirement. A Go compiler,
Node and npm are not required on the worker. Bubblewrap and permitted Linux user
namespaces remain prerequisites for executing agent work.

## Select and verify a release

Tagged releases matching the repository's package version publish static Go
binaries for Linux amd64 and arm64, with `SHA256SUMS`. Select the release matching
the instance's plugin and pinned patched Paperclip host. Release publication
starts when a maintainer pushes the matching `vVERSION` tag; adding this workflow
does not publish a release by itself.

For example, after release `v0.8.0` has been published:

```sh
release=0.8.0
arch=amd64 # use arm64 for a Linux ARM64 worker
asset="outpost-$release-linux-$arch"
base="https://github.com/Yelqo/paperclip-outpost/releases/download/v$release"
curl --fail --location --output "$asset" "$base/$asset"
curl --fail --location --output SHA256SUMS "$base/SHA256SUMS"
awk -v asset="$asset" '$2 == asset' SHA256SUMS > selected.sha256
test -s selected.sha256
sha256sum --check selected.sha256
chmod 755 "$asset"
./"$asset" version
```

These commands explicitly download the selected version. Checksums detect
damaged downloads; obtain both files from the trusted release source. Development
maintainers can build the same artifacts with `pnpm build:release`. Workers
receive the precompiled binary.

## Register as the worker, then install

Prepare the worker and its existing workspace, scratch and local runtime roots.
Use [connection setup and registration](connection.md#operator-workflow) as that
worker, invoking the downloaded standalone binary instead of `bin/outpost`.
Supply operator authentication and optional connection headers through private
stdin, never a command-line argument. Connection state and execution history
stay in the same protected directory across installation and reboot.

After registration, confirm the connection as the worker before installation:

```sh
sudo -H -u worker /absolute/download/outpost-0.8.0-linux-amd64 check \
  --private-dir /home/worker/.outpost-private
sudo /absolute/download/outpost-0.8.0-linux-amd64 service-install \
  --binary /absolute/download/outpost-0.8.0-linux-amd64 \
  --version 0.8.0 --worker worker \
  --private-dir /home/worker/.outpost-private
sudo /opt/paperclip-outpost/0.8.0/outpost service-status
```

Root is required for installation and system service status. Binary release
verification and protected registration validation subprocesses run as the worker.
The installer copies the binary into
`/opt/paperclip-outpost/0.8.0/outpost`, writes the system unit and installation
metadata, reloads systemd and enables/starts the service. The binary and its
parent directories must be root-owned and not writable by the worker. Installation
paths must be canonical and contain only letters, digits, dot, underscore,
slash and hyphen; the worker's home must also use these characters. Source
download paths may contain spaces. The original download, including an npm/npx
cache copy if used for management, can then be removed.

Initial installation refuses any existing service/installation or selected
destination binary. It does not replace or restart an existing installation.
New installation directories use mode 0755 even with a restrictive operator
umask. Existing parents must already allow worker traversal; the installer
does not loosen their permissions.
Ordinary drain/upgrade management belongs to the subsequent lifecycle milestone.
If enable/start fails after files are installed, inspect `service-status` and
the journal, correct the local problem, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-outpost.service
```

## Installed unit and unattended startup

`/etc/systemd/system/paperclip-outpost.service` takes this form (the group is the
worker's numeric primary group):

```ini
[Unit]
Description=Paperclip Outpost
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=worker
Group=1001
WorkingDirectory=/home/worker
Environment=HOME=/home/worker
Environment=PATH=/home/worker/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/home/worker/.outpost-private/service.env
ExecStart=/opt/paperclip-outpost/0.8.0/outpost daemon --private-dir /home/worker/.outpost-private
Restart=on-failure
RestartSec=5s
KillMode=control-group
TimeoutStopSec=30s
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Systemd starts the installed version after boot, using the persisted outpost
credential and optional access headers. The daemon reconnects after transient
network loss. Neither systemd nor daemon startup looks up releases or downloads
updates. Rejected registration or compatibility appears in the service journal;
correct credentials or the selected compatible release before restarting.

The service supplies the worker home and executable search path without loading
shell profiles. If runtime configuration relies on environment variables,
create mode 0600 `service.env` inside the mode 0700 protected private directory,
with systemd `NAME=value` assignments for the required Pi configuration and
locally selected provider variables. Use a private editor/secret manager; do not
put values in the unit, shell arguments or diagnostics. The existing runtime
allowlist still controls what reaches agent work. Do not override `HOME` or
redirect local runtime credentials into a workspace. Machine connection secrets
continue to come from `connection.json`.

`KillMode=control-group` stops remaining runtime processes when the service
stops. The unit preserves bubblewrap's mount/PID namespace protection; it does
not add restrictions that prevent the prepared host's bubblewrap from working.
See the upstream [service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[execution](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
and [process termination](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
documentation for the unit settings.

## Diagnosis and recovery

`service-status` prints selected version, durable binary path, worker, private
directory, systemd load/active/substate/enablement/exit information, and public
registration plus connection status. `outpost status --private-dir ...`, run as
the worker, shows the local connection state independently. Status contains no
credentials, connection headers or runtime environment values. It checks boot
and process identity to avoid showing a crashed or rebooted daemon as connected.
It is a local observation; Paperclip's outpost API remains authoritative for
server-side connection, execution readiness and recovered history.

```sh
sudo /opt/paperclip-outpost/0.8.0/outpost service-status
sudo -H -u worker /opt/paperclip-outpost/0.8.0/outpost status \
  --private-dir /home/worker/.outpost-private
sudo journalctl -u paperclip-outpost.service --boot
```

After reboot during execution, the daemon compares durable launch receipts to
the machine boot/process evidence and reconciles with the registered instance.
It reports the prior attempt interrupted and never launches it again. Workspace
files, Git history, receipts and buffered output remain authoritative. Recovery
retains conflicting-work exclusion when termination cannot be proved. See
[recovery without replay](adr/0004-recovery-without-replay.md).

## Linux acceptance

CI builds an isolated Ubuntu 24.04 VM using QEMU inside an unprivileged Docker
container, then enables `OUTPOST_SYSTEMD_ACCEPTANCE=1` for the public workflow.
The VM has its own Linux kernel and actual systemd. It uses the authenticated
Paperclip host, actual plugin and standalone daemon; no provider account is
needed. SSH is fixture control only, with a reverse loopback forward to the
isolated host, and is not part of Outpost's connection model.
Guest Internet access is disabled, so boot acceptance cannot depend on an update
lookup or download.

To run the same test locally after the development build:

```sh
pnpm build:release
docker build -t outpost-systemd-acceptance:local tests/fixtures/systemd
OUTPOST_SYSTEMD_ACCEPTANCE=1 node --test \
  --test-name-pattern='selected standalone installation' tests/workflow.test.mjs
```

The test removes the downloaded binary, observes the durable service under the
worker UID, records a workspace effect and Git history, forces an actual VM
reboot and verifies changed boot identity, unattended startup, same registration,
interrupted history and one launch effect. This verifies local Linux installation
and reboot acceptance; it does not claim live deployed-instance or Cloudflare
acceptance.

Local acceptance on 2026-10-12 passed this workflow with the static `0.8.0`
Linux amd64 artifact, the pinned authenticated Paperclip host and actual plugin.
The VM changed boot identity, restarted the worker service without login or
Internet access, reported the run interrupted, retained its Git commit and
workspace effect, and did not repeat that effect.
