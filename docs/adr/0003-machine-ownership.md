---
status: accepted
date: 2026-10-06
---

# Keep workspaces and runtime credentials on the machine

Work runs in existing directories configured in Paperclip and interpreted on the
selected outpost. Files, Git history and provider credentials remain owned by
the VM between runs, rather than being staged from a server-owned checkout.
Outpost attaches to prepared machines and does not become a provisioning or
repository synchronization system.

This deliberately differs from assumptions in some current remote adapters.
Preserving this ownership may require upstream runtime/workspace preparation
changes. Each runtime retains its sandbox, and locally managed credentials are
not silently shadowed by server assets.
