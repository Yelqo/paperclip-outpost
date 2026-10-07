# Pi in a machine-owned workspace

Use the actual `pi_local` adapter with an Outpost environment and an existing
absolute workspace. The carried adapter patch selects machine ownership from
the provider's `in_place` realization. It does not stage or restore a checkout,
install Pi, upload skills, create a managed provider directory, or replace the
worker's HOME/PATH. Host instruction bundles and GitHub launchers are not staged
for these environments. Configure the machine's approval policy, credentials,
runtime assets and workspace before dispatch.

## Supported pins

| Component | Supported version |
| --- | --- |
| Paperclip host and Pi adapter | `f858207161ba29c01c82f4674aef83d91b74480f` with `upstream/plugin-transport.patch` |
| Plugin SDK / Outpost transport | `1.0.0+outpost.5` / `5` |
| Outpost plugin and daemon | `0.5.0` |
| Pi | `1.0.3` (`@earendil-works/pi-coding-agent`) |
| pi-config | `8f3a5726a254909a3100d8f719febc868237cd27` with `upstream/pi-config.patch` |
| Worker Node / pi-config pnpm | `22.22.1` / `11.9.0` |

`pnpm prepare:host` and `pnpm prepare:pi` reproduce the patched integrations for
development. Pi preparation installs the actual pinned Paperclip callback
gateway as an operator-owned asset at `runtime/callback-bridge.mjs` inside the
pi-config checkout. Use that prepared checkout's `scripts/paperclip-pi` as the
adapter command. Installation and updates are explicit operator actions; runs
consume the installed assets.

Transport 5 requires the paired 0.5.0 plugin/daemon and the matching carried
host patch. Prepare the host again when upgrading. The pins reject older
combinations before work is admitted; transport 4's workspace queues and
smaller reply frames are not compatible with this approval workflow.

pi-config is currently private. Local preparation uses the operator's existing
Git credential setup. CI needs the `PI_CONFIG_READ_TOKEN` repository secret,
scoped to read that repository; preparation passes it through an ephemeral Git
askpass helper. It does not persist the token in the checkout or write it into
the generated gateway. The public Outpost repository carries the integration
patch rather than a copy of the private upstream source.

## Worker configuration

Under the dedicated worker account, prepare pi-config's private policy,
Paperclip worker configuration and approval state outside workspace/scratch
roots. The worker configuration retains the real Paperclip instance origin,
company and agent identities. Keep its generation stable across runs.
Configure these daemon environment variables through the worker's service:

```text
PATH=/path/to/node-22.22.1/bin:/usr/bin:/bin
PI_CODING_AGENT_DIR=/home/worker/.pi/agent
PI_APPROVAL_POLICY=/home/worker/config/pi-policy.json
PI_APPROVAL_PAPERCLIP=/home/worker/config/paperclip-worker.json
PI_APPROVAL_STATE=/home/worker/state/pi-approval
```

Pass `runtimeRoots` in the registration CLI's local stdin JSON alongside
operator authorization. Include only existing worker-owned directories that
Pi needs to write: its credential-lock directory, approval state and session
directory. For example:

```json
{
  "operatorAuthorization": "Bearer OPERATOR_TOKEN",
  "runtimeEnv": ["OPENAI_API_KEY"],
  "runtimeRoots": [
    "/home/worker/.pi/agent",
    "/home/worker/state/pi-approval",
    "/home/worker/state/pi-sessions"
  ]
}
```

These roots are local connection settings, separate from private machine state
and workspace/scratch roots. The server cannot add writable runtime mounts.
Use `runtimeEnv` to select the daemon service's locally configured provider
variables when `auth.json` or `models.json` references them, for example
`${OPENAI_API_KEY}`. These names and their machine-local values are preserved
without enabling server environment forwarding. Values containing registered
machine/access credentials and reserved transport namespaces are excluded.
The parent namespace hides the machine credential and daemon processes. Pi's
own tool sandbox still controls filesystem operations, uses a credential-free
environment and isolates networking. Approval/configuration files remain
outside tool-writable roots; Pi blocks access to protected configuration.
The host must permit nested unprivileged Bubblewrap namespaces. Ubuntu's
AppArmor user-namespace restriction can deny the inner sandbox; unavailable
isolation fails closed. CI permits namespaces on its disposable runner.

Agent configuration:

```json
{
  "command": "/home/worker/pi-config/scripts/paperclip-pi",
  "cwd": "/home/worker/workspaces/existing-project",
  "machineSessionDir": "/home/worker/state/pi-sessions",
  "model": "configured-provider/configured-model",
  "timeoutSec": 120
}
```

Assign a task and dispatch through the normal Paperclip workflow. Local
`auth.json`, `models.json` and installed runtime assets remain authoritative.
The adapter ignores server `env` configuration by default. Setting
`allowServerRuntimeConfig: true` explicitly permits configured server environment
values, including resolved provider-secret references. This does not authorize
runtime provisioning or overwrite local runtime files.

## Trusted callbacks

The host creates a callback transport descriptor as an execution-interface
field, separate from ordinary environment values. It contains the registered
instance, company, agent, task, run, unique per-run queue directory, bridge
token and expiry. Queues live beneath `machineSessionDir`, outside workspace
and scratch roots, in a locally registered writable runtime root. The daemon
checks registration/run scope, the runtime root and the deadline,
then exposes one private descriptor file read-only inside the otherwise hidden
connection directory. It never forwards the machine or access-layer credentials.

The pinned launcher verifies the descriptor against pi-config's protected static
worker configuration, starts the installed callback gateway alongside Pi, and
writes a private descriptor with the gateway's loopback endpoint into protected
approval state. pi-config uses that descriptor for transport while retaining the
configured origin as instance identity. Ordinary environment-provided callback
URLs are rejected. The launcher stops the gateway and removes the finalized
descriptor when Pi ends; deadlines and the parent namespace bound descendants.

Task reads and progress use pi-config's `paperclip_coordination` tool. The actual
Paperclip queue worker retains its route allowlist and forwards with the host's
run token and fixed run attribution. Pi receives only the per-run bridge token.
The existing bounded-progress and approval scope/consumption checks remain in
pi-config.

## Human approvals

When Pi requests a protected operation, pi-config publishes a human-only
confirmation on the assigned task through the existing interaction routes.
The task enters `in_review` and Pi ends the run without executing the operation.
Approve or deny the card in Paperclip. Its `wake_assignee` continuation uses
Paperclip's normal wake flow and reuses the Pi session in the same environment
and workspace across per-run leases.

Acceptance authorizes only the exact configured instance, company, agent,
task, worker generation and operation scope. pi-config revalidates policy,
workspace contents, executable evidence and the authenticated human decision
before consuming the grant and again before execution. Consumption is durable
and single use; a duplicate decision or wake cannot reuse it. Denial blocks
the operation. Changing the requested command or its evidence invalidates the
old local proposal and withdraws a pending card through the bridge.

Callback queues and session files stay outside the workspace, and descriptor
protection uses stable directories. A new run's transport token and private
filename therefore do not invalidate an otherwise unchanged operation scope.
They also do not replace the configured instance identity or grant tool access
to runtime state. If the decision channel is unavailable, the operation stays
blocked. Reconnection supplies transport connectivity, never human approval.

The transport admits commands up to 60,000 serialized bytes within the host's
64 KiB outbound frame budget, including normal approval wake context. Larger
commands fail before dispatch; the machine-to-host frame limit remains 16 KiB.

## Acceptance

The public workflow test uses actual Pi, pi-config, the patched Pi adapter, the
authenticated host, plugin, Go daemon and existing callback bridge. A local
deterministic OpenAI-compatible HTTP fixture supplies model responses. It
checks assigned-task reads, bounded progress, forbidden configuration access,
isolated tool execution, persistent workspace effects and Git history, unchanged
local provider files, repeat tasks, and rejection of injected loopback URLs.
Approval acceptance additionally observes pending cards, session reuse, actual
allowed/denied Git effects, consumed grants, scope withdrawal, forged transport
context and decision-channel interruption through this same workflow.
No paid provider or external repository/service mutation is required.
