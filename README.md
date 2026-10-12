# Paperclip Outpost

Paperclip Outpost connects prepared machines to a remote, authenticated
[Paperclip](https://github.com/paperclipai/paperclip) instance so its agents can
execute work there without SSH. Each machine runs a persistent Go daemon that
initiates an authenticated connection to the instance. A Paperclip plugin,
written in TypeScript with pnpm and Effect, connects that daemon to Paperclip's
execution interfaces.

Outpost is agent agnostic. It should reuse Paperclip's runtime adapters and
callback bridge; Pi with [pi-config](https://github.com/Yelqo/pi-config) is the
first end-to-end acceptance target. Workspaces and provider credentials belong
to the target machine. Paperclip owns tasks, scheduling, agent identities and
human decisions.

## Current status

Registration, named execution-environment selection, authenticated outbound
connections and bounded process commands in existing machine workspaces are
implemented in the Go CLI/daemon and TypeScript/Effect plugin.
See [setup, operator commands and protection boundaries](docs/connection.md).
Optional access credentials can be configured and checked locally before
registration, then corrected or rotated while retaining the outpost identity.
See [command execution and supervision](docs/execution.md).
Daemon recovery reconciles durable execution receipts with Paperclip without
repeating launches, and blocks conflicting work when history is uncertain.
Ordered output survives disconnection and daemon restart in a bounded durable
buffer; exhaustion stops the process tree and preserves an explicit failure.
The required Paperclip host/SDK extension is carried as a reproducible patch
against a pinned upstream commit. [Pi integration](docs/pi.md) uses machine-owned
runtime assets, scoped callbacks and human approval continuation with session
reuse. [Standalone installation and a durable worker-account systemd service](docs/service.md)
support boot startup and recovery without replay.
Operator-managed upgrades drain active runs and their controls before replacing
the selected binary; explicit forced stops verify interruption before recovery.

The design was reconstructed with the operator on 2026-10-06. Its documents
distinguish accepted decisions from source findings and proposed integration
work; they do not claim completed live deployment acceptance.

## Read the design

- [Recovered design and acceptance criteria](docs/design.md)
- [Domain glossary](CONTEXT.md)
- [Outbound execution architecture](docs/adr/0001-outbound-execution.md)
- [Separate machine identity](docs/adr/0002-machine-identity.md)
- [Machine-owned workspaces and credentials](docs/adr/0003-machine-ownership.md)
- [Recovery without replay](docs/adr/0004-recovery-without-replay.md)

Install a [pinned release](docs/releases.md) through the single
`@yelqo/paperclip-outpost` npm package, optional npx management, or a standalone
Linux binary. Each route supports connection configuration, operator registration
and a durable systemd service under the worker account. Updates are operator
managed. Cloudflare Access is an optional connection requirement;
Outpost does not provision Cloudflare resources or target machines.

## Contributing

Changes to `main` require a pull request and passing CI. See the
[contribution workflow and required check](CONTRIBUTING.md).

## License

Paperclip Outpost is licensed under the [MIT License](LICENSE).
Agent configuration adapted from Matt Pocock's skills is also MIT-licensed;
see [third-party notices](THIRD_PARTY_NOTICES).
