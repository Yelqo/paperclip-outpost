---
status: accepted
date: 2026-10-06
---

# Recover execution state without repeating a launch

During a connection outage, an existing run may continue within its original
limits while the daemon buffers output. Reconnection reconciles durable run and
operation identities; it never turns redelivery into permission to repeat an
operation. A VM reboot restarts the daemon and reports interruption rather than
automatically relaunching the run.

Paperclip retains pending work and retry scheduling. The daemon enforces one
active agent run per actual workspace and keeps conflicting dispatch blocked
while a previous outcome is uncertain. This trades immediate failover for
avoiding repeated external effects. Buffer exhaustion terminates the run and
preserves its terminal record; ordinary upgrades drain active runs first.
