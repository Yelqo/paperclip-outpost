---
status: accepted
date: 2026-10-06
---

# Use an outbound, agent-agnostic execution connection

A prepared machine runs a persistent Go daemon that initiates an authenticated
WebSocket connection to Paperclip. A TypeScript plugin using pnpm and Effect
integrates that connection with upstream execution environments, runtime
adapters and the callback bridge. This removes Paperclip-owned SSH keys and SSH
connectivity while retaining Paperclip's runtime knowledge; necessary upstream
changes are allowed instead of duplicating each agent integration in Go.

The daemon supervises execution, not task scheduling or machine provisioning.
An operator explicitly selects an outpost for an agent. Pi with pi-config is the
first end-to-end acceptance target; the transport remains agent agnostic.
