# torana

[![npm version](https://img.shields.io/npm/v/torana.svg)](https://www.npmjs.com/package/torana)
[![CI](https://github.com/jvbutterfield/torana/actions/workflows/ci.yml/badge.svg)](https://github.com/jvbutterfield/torana/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **torana** (Sanskrit: तोरण, *ceremonial gateway*) — an open-source Telegram gateway for agent runtimes. Configuration-driven, any-runner, webhook or polling.

Run any Telegram bot backed by any agent runtime. Drop a YAML config, point it at your agent CLI (Claude Code, your own subprocess, whatever), and torana handles the rest: inbound updates, dedup, streaming edits, crash recovery, attachments, slash commands, graceful shutdown.

> **Status:** v1.0.0-rc. Approaching 1.0.

## 60-second quickstart

```sh
# 1. Install (Bun ≥ 1.3)
npm install -g torana

# 2. Drop a config
cat > torana.yaml <<'EOF'
version: 1
gateway: { port: 3000, data_dir: ./data }
transport: { default_mode: polling }
access_control:
  allowed_user_ids: [${MY_TELEGRAM_USER_ID}]
bots:
  - id: hello
    token: ${TELEGRAM_BOT_TOKEN}
    runner:
      type: command
      protocol: jsonl-text
      cmd: ["node", "echo.js"]
EOF

# 3. Run doctor to catch config mistakes early
torana doctor --config torana.yaml

# 4. Start
torana start --config torana.yaml
```

See [`examples/echo-bot/`](examples/echo-bot/) for a runnable end-to-end smoke test.

## Commands

| Command | What it does |
| --- | --- |
| `torana start` | Run the gateway |
| `torana doctor` | Validate config and check Telegram reachability |
| `torana validate` | Offline schema check — no Telegram, no DB |
| `torana migrate` | Apply pending DB migrations (`--dry-run` to preview) |
| `torana version` | Print package version + Bun runtime |

## Features

- **Multiple bots from one process** — each bot has its own Telegram token, ACL, runner, and slash commands.
- **Two built-in runners**: `claude-code` (wraps the Claude Code CLI) and `command` (any subprocess speaking a simple JSONL protocol).
- **Two transports**: webhook (production) and polling (dev, firewalled, or MacBook). Per-bot override.
- **SQLite state** with WAL, crash recovery, and a dead-letter outbox for Telegram sends.
- **Streaming** — edits Telegram messages live as the runner produces text.
- **Attachments** — photos and documents download safely into the data dir and get handed to the runner.
- **Safety defaults** — default-deny ACL, mime-derived filename allowlist, disk caps, structured JSON logs that redact secrets.

Non-goals for v1: group chats, voice/video, inline mode, pluggable storage backends, agent-to-agent messaging.

## Runtime

Bun ≥ 1.3. Node support may come later but is not planned for v1.

## Environment inheritance

**Important:** `runner.env` is the *complete* environment passed to the subprocess. Parent-process env vars are **not** inherited by default (except `PATH`). To inherit a variable, reference it via `${VAR}` interpolation. This matches the explicit-env-passing ethos of reproducible deploys and avoids classic "works locally, broken in prod" bugs.

Whatever starts torana must also set up any env the runner needs, or list every required env var in `runner.env`.

## Docs

- [`docs/configuration.md`](docs/configuration.md) — full config reference
- [`docs/transports.md`](docs/transports.md) — webhook vs polling
- [`docs/runners.md`](docs/runners.md) — built-in runners + Claude Code setup
- [`docs/writing-a-runner.md`](docs/writing-a-runner.md) — build your own
- [`docs/security.md`](docs/security.md) — threat model, ACL, secrets
- [`docs/operations.md`](docs/operations.md) — logs, metrics, crash recovery, data dir layout

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports + feature requests in [Issues](https://github.com/jvbutterfield/torana/issues).

## License

MIT — see [`LICENSE`](LICENSE).
