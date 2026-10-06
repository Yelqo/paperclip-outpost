# Paperclip Outpost

Outpost connects registered execution hosts to the Paperclip instance that
assigns their work. Machine identity, agent identity and run identity are
distinct.

## Language

**Paperclip instance**:
The installed Paperclip service to which an outpost is registered.
_Avoid_: Company, outpost

**Company**:
A Paperclip organization grouping agents and work within an instance. The
initial Outpost scope binds an outpost to one company.

**Outpost**:
A registered execution host with its own identity, available workspaces and
execution history. An outpost can serve multiple Paperclip agents.
_Avoid_: Agent, daemon

**Outpost daemon**:
The persistent local supervisor through which an outpost receives and executes
work assigned by Paperclip.
_Avoid_: Agent runtime, Paperclip agent

**Outpost plugin**:
The instance-side integration connecting registered outposts to Paperclip's
execution environment model.

**Paperclip agent**:
The identity to which Paperclip assigns work. Its identity is independent of the
outpost that executes its runs.
_Avoid_: Machine, daemon

**Agent runtime**:
The program performing an agent's work, such as Pi. A runtime's sandbox is
distinct from the outpost's execution authority.

**Execution environment**:
The Paperclip execution target selected for an agent. An outpost is represented
as a named execution environment.

**Workspace**:
A persistent directory on the outpost in which assigned work occurs. Its files
and repository history remain authoritative there between runs.

**Run**:
One Paperclip execution attempt with a stable identity. Reconnecting to an
existing run is distinct from launching a new attempt.

**Execution operation**:
A separately identified execution request associated with a run. Agent
execution and run-associated control operations have different admission roles.

**Outpost credential**:
The revocable credential authorizing one registered outpost's connection. It
does not represent the registering operator or a work agent.
_Avoid_: Agent key, board token

**Callback bridge**:
The route through which a remotely executing agent makes scoped Paperclip API
calls using the instance's existing run integration.
