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
operations can run while that agent is active, and controls preparing its launch
also own the workspace. The run shares one directory lock across its admitted
operations; a completed agent or control cannot release another operation's
ownership. Different workspaces can execute concurrently. Both sides reserve
separate capacities of 16 agent operations and
16 control operations per outpost, with a separate plugin inspection capacity,
so agents cannot occupy all control capacity.

Each operation receives an absolute deadline at dispatch, retains it throughout
execution, and cannot gain a new deadline by replay. A positive adapter timeout
is honored up to one hour; an omitted or unbounded timeout becomes 60 seconds.
Combined stdout/stderr is limited to 1 MiB per operation over its entire lifetime.
The independently bounded durable output buffer is described below. Exceeding
either limit terminates the protected process tree and reports failure.

The daemon records the terminal process outcome durably before releasing its
workspace ownership. A killed process namespace also terminates descendants.
If an operation's outcome is uncertain after a crash or a failed terminal write,
conflicting dispatch remains blocked until recovery establishes termination.
Preserve the private history. Cancellation receipts and operator resolution of
missing history remain subsequent milestones.

On startup, the daemon locates uncertain workspace identities under its worker
root and reacquires their directory locks before opening its transport. This
preserves exclusion across other daemon registrations and directory renames,
using the existing execution history format. Startup refuses to proceed if a
recorded directory cannot be found or locked. Recovering uncertainty may require
scanning the worker root; ordinary startup with only terminal records does not.

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

Before-launch control refusals, including Pi's command availability check, use
the same deferral lane when no agent has executed and no other operation remains
outstanding. Refusals during or after agent execution, or while another operation
has an uncertain outcome, do not authorize a replacement run.

Read-only workspace inspection and commands still awaiting transport dispatch
can be deferred safely after disconnection. Once an execution request has been
dispatched, a missing response is uncertain and does not schedule a replacement
of the admitted run. Releasing the host lease preserves that workspace's server
reservation until every dispatched agent and control operation has a known
termination. The daemon also preserves uncertain ownership across restart, so
conflicting pending work keeps waiting instead of
launching. Reconciliation follows the rules below.

## Interruption recovery and durable history

Before delivering an execution request, the plugin commits a delivery witness
to Paperclip's company-scoped plugin state. It contains the original run and
operation identities, purpose, filesystem workspace identity and absolute
deadline. It contains no command, environment, callback credential or output.
Each operation identity remains consumed indefinitely. Before-launch refusals
and requests withdrawn before dispatch receive durable no-launch receipts;
those receipts do not claim that a process ran or reserve its workspace.

On every daemon connection, both sides compare bounded pages of canonical
record fingerprints, then exchange unmatched records one at a time. Matching
history still restores workspace reservations; fingerprints never authorize
launches. This avoids rewriting every historical callback receipt on reconnect.
All exchanges stay within the transport's frame limit. Paperclip refuses new execution admission
until reconciliation finishes. `connected` reports the authenticated socket;
`executionReady` reports completed reconciliation. The operator's existing
outpost status API also exposes `executionHistory`, including original
identities and `running`, `terminal`, `interrupted` or `uncertain` receipts.
Reconciliation updates these receipts and workspace ownership. It does not
rewrite a completed Paperclip heartbeat attempt or schedule a replacement run.
Known terminal results remain inspectable after lost acknowledgements or
plugin restart. Recovery itself never dispatches an execute request.

The local journal records Linux's boot identity before launch and, when
available, the protected PID namespace's init PID and `/proc` start time after
launch. Bubblewrap's [`--info-fd` implementation](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c)
reports that namespace process. A different boot establishes process loss.
Within the same boot, disappearance of that process, a different start time
at the same PID, or its terminal zombie/dead state establishes namespace loss
and therefore termination of its descendants. A live process or unreadable
process evidence keeps ownership blocked. An intent with no recorded process
identity stays uncertain within that boot, even when its deadline has expired;
a deadline alone never proves termination. Legacy records without boot evidence
also stay uncertain. The daemon periodically rechecks uncertain process evidence.

Verified process loss produces an `interrupted` outcome, durably recorded before
releasing ownership. The original workspace, Git history and terminal receipt
remain available. An explicitly scheduled distinct run may then use the
workspace; neither redelivery nor recovery can relaunch the consumed operation.
All outstanding agent and control operations must have known termination before
their run's workspace reservation is released.

Launch intent uses exclusive file creation followed by file and directory
`fsync`. Process evidence and terminal updates use a private temporary file,
file `fsync`, atomic rename and directory `fsync`. Uncommitted `.tmp` files are
ignored at startup; malformed authoritative records refuse startup. Any failed
durability barrier prevents launch or retains ownership. These guarantees assume
a local filesystem and storage stack that honor `fsync` and atomic rename.
A crash after intent but before launch consumes the operation without inventing
permission to execute it. A crash after launch but before process evidence may
require a verified reboot to resolve interruption.

Paperclip's independent witness detects missing local records and regressions
of previously observed process or terminal history, including restored VM
snapshots. The daemon durably records a missing-history fence, reports
`historyMissing: true` with `uncertain` status, and retains workspace ownership.
Reboot does not repair missing consumption history. Terminal acknowledgements
cannot erase this fence. Do not delete the witness or private history to force
a retry. Restoring Paperclip and the machine together can also roll back the
witness and cannot be detected using these two copies alone; revoke the restored
outpost and resolve external effects before authorizing further work.

The journal and daemon lock live in the private connection directory, outside
workspace, scratch and runtime roots. Mode `0700`/`0600` is supplemented by the
actual launcher's read-only root, private-directory mask, separate mount/PID
namespaces and dropped capabilities. Same-UID agent processes cannot read or
modify consumption records or access the supervisor through `/proc`.

## Ordered output, acknowledgement and retention

These bounds are implementation decisions for Outpost 0.7.0. The daemon
defaults to a **2 MiB output spool per operation**, **64 MiB across retained
operations**, and **1024 retained operations**. Operator flags on `daemon`
configure the first two bounds:

```sh
outpost daemon --private-dir /home/worker/.outpost \
  --output-buffer-bytes 2097152 --output-total-bytes 67108864
```

The per-operation bound accepts 4096 bytes through 64 MiB. The total bound must
be at least the per-operation bound and at most 1 GiB. They measure actual
spool file lengths, including identity headers and five framing bytes per
chunk. Output chunks hold at most 2048 bytes. The separate 1 MiB combined raw
stdout/stderr lifetime limit also bounds Paperclip's adapter accumulation,
regardless of acknowledgement speed or larger spool settings. A small buffer
therefore permits less raw output than its byte setting. Terminal receipts,
which deliberately remain forever to prevent replay, are outside the output
quota. Cursor files add at most 32 bytes per retained operation (committed plus
temporary cursor); filesystem allocation overhead depends on the filesystem.

Output spools live under `output/` in the same protected private directory as
execution history. Identity headers are written to a temporary file, fsynced,
atomically renamed and followed by directory fsync before launch. Startup
removes unpublished headers left by a crash. The daemon serializes stdout/stderr chunks into a single
operation order, fsyncs them before delivery, and sends one acknowledged frame
at a time. This order is the supervisor's pipe-read order; it does not promise
to reconstruct the child's cross-pipe write timing. Memory holds bounded
chunk buffers and at most 1024 spool identities/cursors, without an output
backlog in memory. Process admission remains separately limited to 16 agent
and 16 control operations.

Paperclip acknowledges an output chunk only after durably saving its bytes
and sequence cursor in company-scoped plugin state. A repeated sequence must
match its saved bytes and stream; it does not append duplicate adapter output.
The daemon fsyncs its local acknowledgement cursor before advancing. A lost
acknowledgement, connection or daemon restart can replay the same chunk safely.
Paperclip serializes output writes per operation across connections so a delayed
handler from a closed socket cannot overwrite a newer acknowledgement cursor.
Successful terminal results are delivered only after all preceding output is
acknowledged. Paperclip saves the terminal receipt before acknowledging that
result. Only then does the daemon delete the operation's output spool and
cursor and fsync the directory. Individual chunk acknowledgements do not
compact a live spool; reclamation occurs after the terminal acknowledgement.

Unacknowledged output has **no time-based expiry**. A prolonged outage consumes
the finite byte/operation quotas rather than evicting output. No output write
waits for a network acknowledgement. Failure to append within either byte
bound cancels the protected process, durably records `output limit exceeded`,
and preserves all already retained output, the terminal receipt and workspace.
Failure to reserve a spool records the same terminal failure before starting
a child. Its terminal record retains the original request identity independently
of output capacity; delivery retries after a lost result or acknowledgement,
including daemon restarts, and clears that pending identity durably only after
Paperclip acknowledges the result. Storage errors report
`output retention failed`. Remaining terminal records provide a delivery lane
independent of full output storage. Exhaustion cannot become adapter success or
authorize relaunch. Lowering limits on restart
preserves existing spools; new appends fail until terminal acknowledgements
reclaim enough capacity.

The SDK carries exhaustion as `EXECUTION_OUTPUT_LIMIT`; Paperclip stores
`errorCode: "output_limit"` and treats it as nonretryable. Task-owned runs do
not enter immediate or periodic generic execution recovery after exhaustion.
Continuation requires a separate operator-authorized attempt.

A transient transport outage keeps the original pending adapter execution
alive until its original deadline plus the existing 10-second reconciliation
grace. Reconnection resumes delivery, never dispatch. For an Outpost execute
call without an explicit RPC timeout, the host uses the bounded execution
timeout plus 30 seconds of transport overhead. This covers the default
60-second operation and its reconciliation grace, beyond the generic
30-second RPC default. Explicit RPC deadlines remain enforced.

If the plugin worker or host restarts, or that grace expires, the heartbeat
attempt can fail; recovered output and terminal receipts remain inspectable
and never rewrite a completed
attempt. Grace expiry after dispatch reports `EXECUTION_OUTCOME_UNCERTAIN`;
Paperclip records `execution_outcome_uncertain` and blocks automatic recovery,
including Pi conversation continuation. Losing an already sent Outpost execution
RPC to plugin worker exit or host RPC timeout reports the same nonretryable
uncertainty; an explicit refusal before launch retains its deferral behavior.
A late output-limit receipt remains
visible in execution history while the completed heartbeat keeps its uncertainty
classification. Continuing requires a separate operator-authorized attempt
after the previous operation's ownership is resolved. Daemon interruption
reports verified process loss as before.

The operator's outpost status API exposes `outputRetention` (retained bytes,
operation count and configured bounds) while connected. Saved output is
available through the board-authenticated endpoint below, scoped to the
outpost's company and operation:

```text
GET /api/plugins/yelqo.outpost/api/outposts/OUTPOST_ID/output
    ?companyId=COMPANY_ID&operationId=OPERATION_ID&afterSequence=0
```

Each page contains a `receipt` with original run/operation identities, last
sequence and raw byte count, plus up to 32 ordered `chunks` with sequence,
stream and base64 data. Continue with the last returned sequence. Saved output
and terminal receipts have no automatic deletion in this release; Paperclip's
own run log retention is independent. Local output reclamation does not delete
workspaces, terminal consumption records or Paperclip's saved output.

## Acceptance

`tests/workflow.test.mjs` runs a real authenticated, pinned Paperclip host with
disposable PostgreSQL, installs the actual plugin and launches the Go daemon.
An acceptance adapter installed through Paperclip's public adapter API exercises
stable redelivery and associated controls at the execution-driver seam.
Assertions use public run state/logs, workspace effects, Git history and launch
counts, without inspecting private transport frames or execution records.
Recovery additionally checks the operator's public execution-history receipts,
restores a disposable machine snapshot and kills the actual daemon. Focused Go
subprocess faults exercise intent, launch, terminal-record and acknowledgement
boundaries; live-process tests verify exclusion until termination is established.
The public protection test attempts to read and overwrite an actual journal
record through the same-UID protected launcher.
The bounded process tests require no model provider or deployed Paperclip instance.
