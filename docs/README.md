# Torana documentation

Start here. Everything in this directory is reference material meant to be
used — if it's here, it describes how Torana behaves and is kept current.

## If you're new

Read in this order:

1. The [project README](../README.md) — what Torana is, and the 60-second
   quickstart that gets a bot echoing without any agent credential.
2. [`configuration.md`](configuration.md) — every config key, both v1 and v2.
3. [`runners.md`](runners.md) — pick and set up a runner (`claude-code`,
   `codex`, or your own `command` subprocess).
4. [`transports.md`](transports.md) — webhook or polling.
5. [`troubleshooting.md`](troubleshooting.md) — when it doesn't work.

## By task

| I want to…                                       | Read                                             |
| ------------------------------------------------ | ------------------------------------------------ |
| Write or upgrade a config                        | [`configuration.md`](configuration.md)           |
| Look up a command or flag                        | [`cli.md`](cli.md)                               |
| Run my own model or agent behind Torana          | [`writing-a-runner.md`](writing-a-runner.md)     |
| Drive Torana's bots from a script, CI, or agent  | [`agent-api.md`](agent-api.md)                   |
| Send outbound-only notifications                 | [`publisher-api.md`](publisher-api.md)           |
| Put an agent on Telegram                         | [`platforms/telegram.md`](platforms/telegram.md) |
| Put an agent on Buzz                             | [`platforms/buzz.md`](platforms/buzz.md)         |
| Understand which conversations share context     | [`sessions.md`](sessions.md)                     |
| Run it in production                             | [`operations.md`](operations.md)                 |
| Understand the threat model and isolate a runner | [`security.md`](security.md)                     |
| Upgrade the pinned Buzz CLI                      | [`buzz-cli-upgrades.md`](buzz-cli-upgrades.md)   |
| Diagnose a failure                               | [`troubleshooting.md`](troubleshooting.md)       |

## Reference

- [`configuration.md`](configuration.md) — full config reference, every key,
  v1 and v2
- [`cli.md`](cli.md) — CLI reference, flag by flag
- [`agent-api.md`](agent-api.md) — the `/v1/*` HTTP protocol: ask, send,
  side-sessions, tokens, scopes, admin routes, endpoint provisioning
- [`publisher-api.md`](publisher-api.md) — outbound-only publishers
- [`writing-a-runner.md`](writing-a-runner.md) — the `AgentRunner` contract and
  the three subprocess protocols

## Concepts

- [`platforms.md`](platforms.md) — the platform contract and capability matrix
- [`platforms/telegram.md`](platforms/telegram.md) — Telegram endpoints
- [`platforms/buzz.md`](platforms/buzz.md) — Buzz identity, relay, events,
  media, and how to obtain credentials
- [`sessions.md`](sessions.md) — conversation keys, isolation, aliases
- [`transports.md`](transports.md) — webhook vs polling
- [`runners.md`](runners.md) — the built-in runners

## Operating

- [`operations.md`](operations.md) — data directory, health, metrics, logs,
  crash recovery, migrations, shutdown, runbook snippets
- [`security.md`](security.md) — threat model, runner isolation, secret
  handling, trust boundaries
- [`troubleshooting.md`](troubleshooting.md) — symptoms → causes → fixes
- [`buzz-cli-upgrades.md`](buzz-cli-upgrades.md) — pinned Buzz CLI provenance
  and coordinated upgrade

## What isn't here

Design plans, phase findings, and release-readiness records are kept with the
maintainers' engineering records rather than in the repository. They describe a
specific deployment and a point in time rather than how the software behaves,
so they would go stale as documentation even where they are not
deployment-specific. Anything in them that describes Torana itself belongs in
one of the files above — if you find a gap, that's a documentation bug worth
[reporting](https://github.com/jvbutterfield/torana/issues).
