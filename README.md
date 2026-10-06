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

This repository records the design reconstructed with the operator on
2026-10-06. No daemon, plugin, npm package or installation command is implemented
yet. The original conversation was unavailable; these documents distinguish
accepted decisions from inspected upstream behavior and proposed integration
work.

## Read the design

- [Recovered design and acceptance criteria](docs/design.md)
- [Domain glossary](CONTEXT.md)
- [Outbound execution architecture](docs/adr/0001-outbound-execution.md)
- [Separate machine identity](docs/adr/0002-machine-identity.md)
- [Machine-owned workspaces and credentials](docs/adr/0003-machine-ownership.md)
- [Recovery without replay](docs/adr/0004-recovery-without-replay.md)

The intended installation flow is a versioned global npm installation or a
standalone Go binary, optional connection configuration, operator registration,
and installation of a systemd service under the worker account. Updates are
operator managed. Cloudflare Access is an optional connection requirement;
Outpost does not provision Cloudflare resources or target machines.
