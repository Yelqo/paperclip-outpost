# Registration and authenticated connection

Issue #3 implements registration, named environment selection and the outbound
connection. Issue #4 adds [bounded process command execution](execution.md).
Issue #5 adds [Pi with machine-owned assets and scoped callbacks](pi.md).
Issue #8 adds local access-layer configuration, correction and connectivity checks.
Issue #14 adds [standalone installation and the worker-account systemd service](service.md).

## Supported development installation

The supported Paperclip source commit and required host/SDK patch are recorded
in [the upstream lock](../upstream/paperclip.lock.json). Unpatched Paperclip does
not expose the transport. This repository carries the patch; it has not been
submitted or released upstream.

```sh
mise trust
mise install
pnpm prepare:host
pnpm prepare:pi
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

The test suite starts an isolated authenticated Paperclip server and embedded
PostgreSQL under temporary directories. It uses actual operator login, a board
API key, plugin installation, Go registration and the outbound daemon. It needs
Linux user namespaces and `bubblewrap` for the local protection test. No paid
provider, deployed instance or Cloudflare account is needed. Tests use loopback
HTTP; remote connections require HTTPS/WSS with normal TLS verification.

GitHub Actions runs these checks on pushes and pull requests; the `CI` workflow
also supports manual runs. It installs the toolchain from `mise.toml`, prepares
the pinned host/SDK patch with frozen dependencies, builds the plugin and daemon,
checks plugin and host TypeScript plus Go, and runs the host routing/authorization
regressions and public workflow suite. The Ubuntu 24.04 runner installs bubblewrap
and permits unprivileged user namespaces for the protection tests. This setting
applies only to the disposable CI runner. Pi preparation requires the read-only
`PI_CONFIG_READ_TOKEN` secret because pi-config is private. No model-provider or
external service account is required for the deterministic acceptance fixture.

Install the built plugin directory through Paperclip's existing instance-admin
plugin installation API or UI. Use the pinned, patched host for that instance;
`pnpm prepare:host` prepares its source and TypeScript prerequisites. Normal
Paperclip deployment setup remains operator owned.

## Operator workflow

Prepare a dedicated, unprivileged worker account and existing workspace and
scratch directories. Choose a private directory outside both roots. The CLI
requires absolute paths, resolves aliases, rejects overlapping private and
writable roots, and creates mode 0700 private state with a mode 0600 connection
file. Registration refuses an existing registered identity; configuration
updates replace the private file atomically.
Only one `configure` or `register` command can use a private directory at a time.
An overlapping command fails locally; retry after the active command finishes.

### Optional access layer

For an instance behind an existing access layer, configure its connection
credentials before registration:

```sh
bin/outpost configure --instance https://paperclip.example.com \
  --private-dir /home/worker/.outpost-private \
  --workspace-root /home/worker/workspaces --scratch-root /home/worker/scratch
bin/outpost check --private-dir /home/worker/.outpost-private
```

Supply a JSON object on `configure` stdin through a private input pipe or secret
manager. Existing Cloudflare Access service tokens use this shape (replace the
placeholder values in the private input source):

```json
{"headers":{"CF-Access-Client-Id":"EXISTING_SERVICE_TOKEN_ID","CF-Access-Client-Secret":"EXISTING_SERVICE_TOKEN_SECRET"}}
```

The accepted optional headers are these two Cloudflare Access headers. Outpost
does not create or manage Cloudflare resources, applications, policies or tokens,
and never needs access-provider account or management API credentials. The
operator maintains the existing service token and its access policy.

`configure` saves mode 0600 state inside the mode 0700 private directory. It
prints only a status, and checks and diagnostics omit the header values.
Before registration, `check` requests `/api/health` through the saved HTTPS
origin and headers without operator authentication. Success reports `reachable`;
it verifies reachability and the health response, while registration and the
post-registration check verify their own routes. The access policy must cover
both the registration API routes and the WebSocket transport route. Outpost
never retries without the configured headers or through a different origin.

Register using the saved settings; supply only Paperclip operator authentication
and any local runtime options on stdin:

```sh
bin/outpost register --private-dir /home/worker/.outpost-private \
  --company COMPANY_UUID --name 'Ubuntu worker'
bin/outpost check --private-dir /home/worker/.outpost-private
```

Registration inherits the saved instance, roots and headers. Passing a different
instance or roots, or attempting to override configured headers in registration
input, fails locally. After registration, `check` verifies an authenticated
WebSocket connection, including machine identity and version compatibility,
and reports `connected` before exiting. Stop a running daemon before using
`check` or `connect`: only one authenticated connection is allowed for an
outpost. If the daemon is already connected, the standalone check reports an
HTTP 409 conflict and leaves the daemon's connection active.

To correct or rotate existing access credentials, stop the daemon, run
`configure --private-dir /home/worker/.outpost-private` with the new headers on
stdin, run `check`, then restart the daemon. The update atomically replaces the
private connection file while retaining its outpost identity, credential,
runtime options and roots. A running daemon retains the settings it loaded at
startup, so a restart is required. Failed validation preserves the previous
settings. Use `{"headers":{}}` to clear optional headers when the instance no
longer requires an access layer. The saved instance and roots remain fixed.

An HTTP 401/403 rejection can come from the access layer or Paperclip: verify the
existing service token and policy, and the operator or outpost authorization.
Redirects (including an access login page) are rejected without following the
`Location` header. Network failures report DNS, TLS trust and connectivity checks;
an unexpected health response calls for checking the instance origin and access
configuration. Response bodies, redirects, credentials and raw network errors
are excluded from diagnostics. Normal TLS certificate verification remains on.

### Ordinary registration

Instances without an optional access layer can register directly with no
`configure` step, optional headers or Cloudflare dependency:

```sh
bin/outpost register --instance https://paperclip.example.com \
  --company COMPANY_UUID --name 'Ubuntu worker' \
  --private-dir /home/worker/.outpost-private \
  --workspace-root /home/worker/workspaces --scratch-root /home/worker/scratch
```

Supply one JSON object on stdin, containing `operatorAuthorization` with the
existing Paperclip CLI/board bearer authentication. A secret manager or private
input pipe can supply it without putting it in command arguments or shell
history. For compatibility, direct registration without prior configuration can
also accept optional `headers` with existing `CF-Access-Client-Id` and
`CF-Access-Client-Secret` values; these are retained for daemon connections and
can subsequently be updated with `configure`. Redirects are
rejected so credentials cannot be forwarded to another origin.

Registration issues a random 256-bit outpost credential, stores only its SHA-256
digest in company-scoped plugin state, and creates the named execution
environment through Paperclip's existing authenticated API. The operator
credential is used in memory and is never written into connection state or
passed to the daemon. If environment creation or local persistence fails, the
CLI attempts to revoke the newly issued credential. A failed network cleanup
requires operator revocation through the API; registration is not a distributed
transaction.

The CLI prints public IDs only. Select the named environment in existing agent
configuration (`defaultEnvironmentId`); there is no Outpost workspace catalog
or placement scheduler. Provider keys are unique within a plugin manifest. If
multiple installed plugins declare the same provider key, the host rejects
environment selection because company ownership is ambiguous. Remove the
conflicting plugin declaration to restore selection; disabled plugins still
count toward this check.

Then run:

```sh
bin/outpost connect --private-dir /home/worker/.outpost-private
bin/outpost diagnose --private-dir /home/worker/.outpost-private
bin/outpost daemon --private-dir /home/worker/.outpost-private
```

`connect` validates one connection and exits. `daemon` reconnects after transient
failures with a bounded backoff, and stops on authentication/version rejection.
SIGTERM/SIGINT closes its connection. `diagnose` emits identity and version
metadata without credentials or optional access headers. `check` after
registration performs the same authenticated connection check as `connect`.

Revoke using the operator-authenticated API:
`POST /api/plugins/yelqo.outpost/api/outposts/OUTPOST_UUID/revoke`, with
`{"companyId":"COMPANY_UUID"}`. Subsequent connections are rejected. Connected
daemons also encounter revocation on their next application heartbeat.
Persistence failures close the transport with a retryable failure; the daemon
reconnects after persistence recovers.
`GET /api/plugins/yelqo.outpost/api/outposts/OUTPOST_UUID?companyId=COMPANY_UUID`
returns public registration and connection status.

## Transport and compatibility

The plugin declares the `transport` route and the
`transport.websockets.register` capability. Paperclip core upgrades
`/api/plugins/yelqo.outpost/ws/transport` under its existing origin. Company and
outpost IDs are metadata in the query; bearer authentication and supported
versions are headers. Cookies and query tokens cannot authorize the transport.
An outpost credential is not registered as an operator token or agent API key
and is rejected by ordinary board and work-agent APIs.

The plugin authenticates the outpost, checks revocation and exact host commit,
SDK transport revision, plugin version, daemon version and protocol version,
then returns the bound identity. The daemon validates that identity and the
same version tuple before declaring itself connected. Packaged hosts must carry
Paperclip's build commit stamp. Compatibility is a pinned declaration, not
cryptographic attestation of the machine's executable.

Maintain host, SDK and protocol pins in `upstream/paperclip.lock.json`, and the
Outpost release version in `package.json`. The plugin and daemon ship together
with that release version. `pnpm generate:versions` generates their committed
TypeScript/Go constants and updates the carried host's SDK/transport declarations.
Preparation and builds run generation; `pnpm check` rejects stale declarations.
Workflow tests reuse the generated contract, and the plugin manifest derives its
version from it. Committed Go constants also support standalone `go build`.

Core limits connections to 64 (including admissions and unfinished cleanup) and
outstanding admission work separately to 64. Closed peers retain their connection
permit until the registry lookup and every delivered worker call finish. RPC
deadlines reject the caller without proving the handler stopped; permits remain
charged until a late worker reply or worker process exit, including message and
cleanup calls. A worker that never replies requires an operator restart to
recover its capacity. A closed connection is checked before worker dispatch.
Core limits inbound frames to 16 KiB, pending frames to 16 per connection, one
serialized message request per connection with a five-second timeout, replies
to four frames of at most 64 KiB each, and buffered outbound data to 64 KiB.
The plugin admits commands of at most 60,000 serialized bytes so its transport
envelope fits that outbound limit. Compression is disabled.
Core pings, closes sockets,
cleans up after worker loss and server shutdown, and delivers close events.
The plugin uses scoped Effects only for its own connection-to-outpost
associations. SDK promises are adapted to typed Effect failures at the boundary.

## Local protection boundary

Mode 0700/0600 files protect against other accounts and accidental disclosure.
**They do not isolate processes sharing the worker UID.** An unsandboxed
same-UID process can read these credentials and interfere with the daemon.

The `protect` launcher provides the local isolation tested by this issue:

```sh
bin/outpost protect --private-dir /home/worker/.outpost-private -- COMMAND ARG...
```

It uses bubblewrap with a read-only host filesystem, writable workspace/scratch
binds, a private PID namespace and `/proc`, a fresh `/dev`, hidden `/sys`, and an
empty mount over the private state directory. It provides a small environment
allowlist plus locally selected `runtimeEnv` provider variables; connection,
operator and proxy credentials are not forwarded. See [Pi worker setup](pi.md)
for local runtime state and provider configuration. Missing
bubblewrap or unavailable namespaces cause failure, with no unsandboxed fallback.
The public workflow test proves that same-UID access is possible outside this
profile and that the profile hides both the credential file and host process
environment paths.

Execution uses this profile in addition to each runtime's existing sandbox.
Do not run arbitrary
same-UID agent processes outside that boundary, expose host `/proc` through
another mount, or make hard-link copies of private credentials in agent-readable
paths. This is an isolation mechanism for prepared Linux hosts, not a claim
that filesystem ownership alone protects a hostile unsandboxed worker UID.
