# Versioned releases and operator installation

Outpost ships **one npm package**, `@yelqo/paperclip-outpost`, containing the
instance-side plugin, the `outpost` management command and both precompiled
Linux daemon binaries. All three installation routes select an explicit release.
No worker needs a Go compiler. Startup never resolves a release, runs npm/npx,
or downloads an update.

## Supported release

| Component | Supported selection for Outpost 0.9.0 |
| --- | --- |
| Paperclip host | `f858207161ba29c01c82f4674aef83d91b74480f` plus `upstream/plugin-transport.patch` |
| Plugin SDK / shared | `1.0.0+outpost.9` / `0.3.1` |
| Outpost npm package / plugin / daemon | `0.9.0` |
| Outpost transport | `9` |
| Pi | `@earendil-works/pi-coding-agent@1.0.3` |
| pi-config | `8f3a5726a254909a3100d8f719febc868237cd27` plus `upstream/pi-config.patch` |
| Pi worker Node / pi-config pnpm | `22.22.1` / `11.9.0` |
| npm management and Paperclip Node | `24.19.0` or newer |

[The generated compatibility record](../release/compatibility.json) ships as
`COMPATIBILITY.json` in the npm package and with every GitHub release. It records
the supported pins and SHA-256 digests of the carried host and pi-config patches.
The host reports its installed shared-package version; transport admission checks
it alongside the host commit, SDK, protocol and exact plugin/daemon release.
Unsupported combinations cannot accept work. The Pi launcher checks actual
Node/Pi versions and its prepared host/pi-config declarations before starting
callbacks or agent work. `pnpm prepare:pi` verifies the checkout pin, applies the
selected patch and installs that declaration with the callback gateway.
When replacing a carried integration patch, preserve an older prepared checkout
and prepare a fresh cache directory; preparation refuses mismatched checkouts.
These declarations are compatibility checks, not cryptographic attestation of
an operator-owned installation.

## Release artifacts

| Artifact | Purpose |
| --- | --- |
| `yelqo-paperclip-outpost-0.9.0.tgz` | The same single package published to npm |
| `outpost-0.9.0-linux-amd64` | Standalone static Linux x86-64 binary |
| `outpost-0.9.0-linux-arm64` | Standalone static Linux ARM64 binary |
| `COMPATIBILITY.json` | Supported integration versions and patch digests |
| `SHA256SUMS` | Checksums of the package, binaries and compatibility record |

The npm package bundles both binaries and selects the local Linux architecture.
It has no dependencies or installation scripts. The plugin is bundled too;
the published package has no links to a developer's SDK checkout. Linux x64 and
arm64 are the supported targets. The standalone route needs neither Node nor
npm. npm/npx management requires Node 24.19.0 or newer, visible to the operator
and worker. After service installation the daemon runs directly; Node is only
needed separately if the selected agent runtime requires it.

## Prepare the instance and worker

Install the selected patched Paperclip host and the same pinned package as the
Outpost plugin. Use the authenticated operator API `POST /api/plugins/install`
with `{"packageName":"@yelqo/paperclip-outpost","version":"0.9.0"}`.
Paperclip requires the package name and selected version as separate fields;
its current installation UI does not expose that version selection. Do not mix
a new plugin with an old daemon.
[Drain before changing the instance pins](service.md#operator-managed-upgrades).

Prepare a dedicated existing unprivileged `worker` account, its workspace and
scratch directories, bubblewrap and permitted user namespaces. Prepare any
machine-owned runtime assets, policy and provider credentials separately; see
[Pi setup](pi.md). Keep connection state in the worker-owned protected directory.

## Global npm route

After the selected release is published:

```sh
cd / # use a working directory accessible to the worker
sudo npm install --global --ignore-scripts @yelqo/paperclip-outpost@0.9.0
outpost version
sudo -H -u worker outpost configure \
  --instance https://paperclip.example.com \
  --private-dir /home/worker/.outpost-private \
  --workspace-root /home/worker/workspaces --scratch-root /home/worker/scratch \
  < /secure/connection-headers.json
sudo -H -u worker outpost register --company COMPANY_ID --name linux-worker \
  --private-dir /home/worker/.outpost-private < /secure/registration.json
sudo -H -u worker outpost check --private-dir /home/worker/.outpost-private
sudo outpost service-install --worker worker \
  --private-dir /home/worker/.outpost-private
sudo /opt/paperclip-outpost/0.9.0/outpost service-status
```

Supply `{"headers":{}}` on private stdin when no optional access headers are
needed. The registration input contains operator bearer authentication and any
runtime-root/environment selection described in the
[connection workflow](connection.md#operator-workflow). Use private files or a
secret manager; never put credentials in command arguments. Resolve an absolute
`outpost` path if the npm global bin directory is absent from sudo's PATH.

The package automatically supplies its bundled binary and release version to
`service-install` and `service-upgrade`; omit `--binary` and `--version` for these
npm commands. The installer copies the selected executable to
`/opt/paperclip-outpost/0.9.0/outpost` and installs the worker-account systemd
service. The global package and npm caches can subsequently be removed.

## Optional npx route

Use the same pinned package for each one-off command. For example:

```sh
cd / # npx must run from a working directory accessible to the worker
sudo -H -u worker npx --yes --ignore-scripts \
  --package=@yelqo/paperclip-outpost@0.9.0 outpost configure \
  --instance https://paperclip.example.com \
  --private-dir /home/worker/.outpost-private \
  --workspace-root /home/worker/workspaces --scratch-root /home/worker/scratch \
  < /secure/connection-headers.json
sudo -H -u worker npx --yes --ignore-scripts \
  --package=@yelqo/paperclip-outpost@0.9.0 outpost register \
  --company COMPANY_ID --name linux-worker \
  --private-dir /home/worker/.outpost-private < /secure/registration.json
sudo -H -u worker npx --yes --ignore-scripts \
  --package=@yelqo/paperclip-outpost@0.9.0 outpost check \
  --private-dir /home/worker/.outpost-private
sudo npx --yes --ignore-scripts --package=@yelqo/paperclip-outpost@0.9.0 \
  outpost service-install --worker worker --private-dir /home/worker/.outpost-private
```

npx may fetch that explicit package during these operator commands. The service
always references the durable copy under `/opt`, outside every npm/npx cache.
Cache cleanup followed by `sudo systemctl restart paperclip-outpost.service`
retains the selected version and registration. Later management can use the
durable standalone command even after removing Node/npm.

## Standalone route and updates

Download and verify the selected Linux artifact with `SHA256SUMS`, then use its
`configure`, `register`, `check` and `service-install` commands. The complete
[standalone/systemd workflow](service.md) includes architecture selection,
protected installation paths, startup and recovery. Standalone installation
requires explicit `--binary` and `--version`; it shares the same service installer
and daemon as npm/npx.

For npm/npx upgrades, select the desired exact package and invoke
`outpost service-upgrade`. For standalone upgrades, download and verify the exact
binary and supply its path and version. All routes follow the existing
[drain and compatibility checks](service.md#operator-managed-upgrades).

## Build, acceptance and publication

After development setup, `pnpm build:release` creates the artifacts. CI installs
the pinned tarball globally and through npx with no compiler or registry access,
installs the plugin from that same tarball, and tests actual systemd installation
in isolated Ubuntu guests. It removes npm/npx caches, global installation and
setup tools, restarts the service, and verifies the same durable executable,
version and registration. The standalone test also verifies unattended reboot
and recovery. Guest Internet access is disabled. Both architectures are built;
systemd execution acceptance runs on amd64.

The release workflow requires a `vVERSION` tag matching `package.json` and fresh
compatibility declarations. It builds and tests the package, publishes GitHub
assets, then publishes that exact tarball to npm. Configure the repository's
`NPM_TOKEN` secret with publish authority for `@yelqo/paperclip-outpost` before
tagging. The source package stays private to prevent publishing its development
dependencies; only the generated release tarball is publishable. No release is
published merely by merging this implementation. See npm's
[tarball publishing documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

If npm publication fails after GitHub publication, correct registry authorization
and publish the checksum-verified tarball from that GitHub release. A published
name/version is immutable; do not rebuild or silently replace an already
published selection.
