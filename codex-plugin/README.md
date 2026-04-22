# torana — Codex plugin

Ships the `torana-ask` and `torana-send` skills for use from inside
Codex. The skills call the `torana` CLI on your host, so make sure that's
installed first (`bun run build` + `bun link`, or `npm i -g torana`).

## Install

**Option A — one-line marketplace add (recommended).** Append this
plugin's marketplace entry to your personal Codex marketplace:

```sh
cat codex-plugin/marketplace.json | jq '.plugins[0]' \
  >> ~/.agents/plugins/marketplace.json
```

Then in Codex run `/plugins install torana`.

**Option B — direct skill install (simpler, skips marketplace).**

```sh
torana skills install --host=codex
```

Writes `SKILL.md` files into `$XDG_DATA_HOME/agents/skills/` (or
`~/.agents/skills/` when XDG is unset).

## Credentials

Set `TORANA_SERVER` + `TORANA_TOKEN` in the environment Codex runs under,
or configure a profile once:

```sh
torana config add-profile local \
  --server http://localhost:8080 \
  --token "$TORANA_TOKEN"
```

## First-run approval

Codex prompts the first time it runs `torana` under `workspace-write`
sandbox. Approve once; subsequent calls in the same session are silent.
For zero prompts, drop this into `~/.codex/config.toml`:

```toml
[commands."torana"]
approval_mode = "never"
```

## Skill parity

`codex-plugin/skills/*/SKILL.md` are build-copies of `skills/*/SKILL.md`.
They must be byte-identical — `bun test` enforces this via
[scripts/check-skill-parity.ts](../scripts/check-skill-parity.ts).
