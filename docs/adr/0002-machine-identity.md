---
status: accepted
date: 2026-10-06
---

# Separate outpost identity from operator and agent identities

Registration reuses Paperclip's operator authentication, then issues a distinct
revocable outpost credential for ongoing connections. Keeping a board token on
the VM would inherit the registering user's authority; using a work-agent key
would conflate a shared execution host with that agent. The machine credential
therefore authorizes its transport without becoming either identity.

Additional access layers are optional connection settings used during both
registration and daemon operation. Cloudflare Access compatibility uses existing
credentials only; Outpost does not manage Cloudflare resources or require
Cloudflare for ordinary deployments. Credential lifecycle mechanics remain to
be specified.
