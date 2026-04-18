# Security policy

## Reporting a vulnerability

If you think you've found a security issue in torana, **please do not open a public issue**.

Private reporting channels (prefer either):

1. **GitHub private vulnerability reporting** on this repository.
2. Email `security@` (the alias is being set up — see the repo description for the most up-to-date address).

Include:

- A description of the issue.
- Steps to reproduce, or a PoC if you have one.
- Your assessment of impact.
- Any suggested fix (optional).

## What's in and out of scope

Covered in detail in [`docs/security.md`](docs/security.md#threat-model). TL;DR:

- **In scope:** webhook secret bypass, ACL bypass, path traversal, secret leakage via logs, config-parser RCE, SQL injection, SSRF from config, dependency vulnerabilities.
- **Out of scope:** downstream runner bugs (report to the runner vendor), Telegram platform issues, DoS from an allowlisted user.

## Response SLO (v1)

Best-effort. 30 days to triage. No formal SLA. Improving this is on the roadmap as torana matures.

## Disclosure

Once a fix is merged and a release cut, we will publish an advisory with credit (by default) or anonymously (if you prefer).
