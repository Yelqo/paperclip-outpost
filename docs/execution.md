# Execute in an existing Outpost workspace

The `process` adapter can execute a bounded command on the named Outpost
execution environment selected in agent configuration. Register the outpost
and start its daemon using the [connection workflow](connection.md).
The daemon requires a dedicated, unprivileged Linux worker account and
`bubblewrap`; it refuses to execute as root. It uses that worker account's
environment and retains the same mount/PID namespace protection as `protect`.

Set `defaultEnvironmentId` to the registered environment and use `process`
as `adapterType`. For example, an agent's `adapterConfig` can contain:

```json
{
  "command": "/bin/sh",
  "args": ["-c", "git status --short; printf 'workspace command finished\\n'"],
  "cwd": "/home/worker/workspaces/existing-project",
  "timeoutSec": 30
}
```

A task's selected project workspace can supply the path instead of agent
`cwd`. Paths are absolute and interpreted on the outpost, beneath its registered
workspace root. The directory must already exist. Missing paths, paths outside
the worker root, and host-managed isolation/provisioning are rejected.
Paperclip does not create, clone, synchronize or restore these directories.
Files and Git history remain authoritative on the machine between operations.

Dispatch through Paperclip's existing task scheduling or the operator API
`POST /api/agents/AGENT_ID/heartbeat/invoke`. Observe the run using
`GET /api/heartbeat-runs/RUN_ID` and
`GET /api/heartbeat-runs/RUN_ID/log`. Both stdout and stderr stream before
the command finishes; exit code, signal and deadline expiration feed the
normal Paperclip run result. Runtime-specific interpretation stays in the
Paperclip adapter. See [Pi execution](pi.md) for machine-owned runtime assets
and scoped task callbacks. Remote connection-instruction files remain unsupported.

## Admission and process supervision

The carried host/SDK patch adds explicit run identity, operation identity and
`agent_execution`/`control` purpose to execute and duplex-open interfaces.
The host authors these fields independently of provider leases. An adapter's
agent launch uses a stable operation identity for that run; separate control
operations receive their own identities. Duplex transport is not advertised
by this Outpost release; its identity contract is ready for callback integration.

Before starting a process the daemon writes and fsyncs its launch intent,
then fsyncs the containing private directory. Execution history lives beside
connection state, outside writable workspace/scratch roots and hidden from
the child. An admitted operation is consumed permanently, including when a
crash occurs between its durable intent and process start. Redelivery is
rejected even after daemon restart. A persistence failure prevents launch.
There is no execution queue on the daemon.

The plugin asks the daemon for the actual workspace's filesystem device/inode
and its current owner, then reserves that identity for the run on the selected
outpost. Separate Paperclip workspace records and symlink aliases share that
reservation. The daemon makes the authoritative admission decision and holds a
local directory lock. Dispatch includes the inspected filesystem identity;
replacement of the directory before launch refuses the request. The admitted
directory is pinned when launching the protected process. Associated control
operations can run while that agent is active. Different workspaces can execute
concurrently. Both sides reserve separate capacities of 16 agent operations and
16 control operations per outpost, with a separate plugin inspection capacity,
so agents cannot occupy all control capacity.

Each operation receives an absolute deadline at dispatch, retains it throughout
execution, and cannot gain a new deadline by replay. A positive adapter timeout
is honored up to one hour; an omitted or unbounded timeout becomes 60 seconds.
Combined stdout/stderr is limited to 1 MiB per operation. Output delivery uses
acknowledgements to apply backpressure within the host's bounded transport.
Exceeding the output limit terminates the process and reports failure.

The daemon records the terminal process outcome durably before releasing its
workspace ownership. A killed process namespace also terminates descendants.
If an operation's outcome is uncertain after a crash or a failed terminal write,
conflicting dispatch remains blocked. Preserve the private history; deleting
it discards replay protection. Automatic interruption reconciliation, buffered
output recovery, cancellation receipts and operator reconciliation belong to
the recovery milestones. This release fails uncertain operations closed.

## Pending unavailable work

An offline outpost, a busy workspace or occupied admission capacity produces an
explicit before-launch refusal. Paperclip cancels that attempt with
`execution_unavailable` and stores a new `scheduled_retry` run and wakeup request
using its existing scheduler. The pending task context and issue execution
ownership transfer to the retry. The scheduler retries after 15 seconds while
the agent and task remain eligible; resource waits do not spend the execution
failure retry budget. The public task includes its `scheduledRetry` receipt.
There is no daemon queue and no launch call held until the outpost becomes free.

Workspace realization performs server admission using the daemon's directory
identity instead of Paperclip's project workspace record identity. Daemon
admission rechecks that identity and local ownership before durable launch
intent, including contention with another daemon registration. Control
operations keep their own admission capacity and use their admitted run's
workspace reservation.

Read-only workspace inspection and commands still awaiting transport dispatch
can be deferred safely after disconnection. Once an execution request has been
dispatched, a missing response is uncertain and does not schedule a replacement
of the admitted run. Releasing the host lease preserves that workspace's server
reservation until termination is known. The daemon also preserves uncertain
ownership across restart, so conflicting pending work keeps waiting instead of
launching. Full reconciliation of uncertain operations belongs to the recovery
milestones.

## Acceptance

`tests/workflow.test.mjs` runs a real authenticated, pinned Paperclip host with
disposable PostgreSQL, installs the actual plugin and launches the Go daemon.
An acceptance adapter installed through Paperclip's public adapter API exercises
stable redelivery and associated controls at the execution-driver seam.
Assertions use public run state/logs, workspace effects, Git history and launch
counts, without inspecting private transport frames or execution records.
The bounded process tests require no model provider or deployed Paperclip instance.
