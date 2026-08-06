---
name: torana-buzz
description: |
  Use when an active Torana-hosted agent turn needs to read or change its Buzz
  workspace: messages, channels, DMs, reactions, workflows, repos, memory,
  moderation, or other stable Buzz CLI surfaces. All operations go through
  Torana's endpoint-scoped broker; never invoke the unrestricted buzz binary.
allow_implicit_invocation: true
---

# torana-buzz

Use Buzz workspace tools through Torana's typed credential broker. The broker
selects the identity from the current turn, enforces the agent's command policy,
checks channel membership and owned-event rules, and runs the pinned Buzz CLI
without exposing the private key or owner authorization tag.

## Call format

Send one JSON request on stdin:

```bash
printf '%s\n' '{"group":"channels","command":"list"}' | torana buzz call

printf '%s\n' '{
  "group":"messages",
  "command":"send",
  "options":{"channel":"<uuid>","content":"Status is green."}
}' | torana buzz call

printf '%s\n' '{
  "group":"repos",
  "command":"protect",
  "nestedCommand":"list",
  "options":{"repo":"<repo-id>"}
}' | torana buzz call
```

Fields:

- `group` and `command` are required. Use `nestedCommand` only for nested CLI
  commands such as `repos.protect.list`.
- `options` maps long option names without leading `--` to strings, numbers,
  booleans, or arrays for repeatable options.
- `positionals` supplies positional arguments. Values beginning with `-` are
  rejected so they cannot become hidden flags.
- `stdin` supplies bounded command input when a command accepts `-`.
- File options must be absolute paths inside the runner workspace or Torana's
  attachment area. The broker copies regular, bounded files into a private
  temporary location before invoking Buzz.

Do not include `relay-url`, `private-key`, `auth-tag`, `endpoint`, `config`,
`env`, `cli-path`, or `format`. The broker rejects identity and executable
overrides.

## Operational boundary

- The capability exists only during the active Torana turn and is already
  bound to one configured Buzz endpoint.
- A Buzz-origin turn uses its ingress endpoint. Telegram and Agent API turns
  receive Buzz access only when the operator configured a default endpoint.
- A permitted channel operation still fails when the bound identity is not a
  member. Message edit/delete operations may target only events authored by
  that identity.
- Unknown commands and commands outside the configured `read_only`,
  `collaborate`, `maintainer`, or custom policy fail before the CLI starts.
- Never run `buzz` directly. A direct invocation bypasses Torana's policy and
  is unsupported unless the operator explicitly enabled the dangerous raw-key
  escape hatch.

## Conversational replies

Use the broker for additional workspace actions requested during a turn.
Do not use `messages.send` to deliver the agent's final conversational answer;
return that answer normally and let Torana's durable transport publish it.

## Stable command surface

The broker recognizes the pinned Buzz 0.5.5 manifest:

- `messages`: send, send-diff, edit, delete, get, thread, search, vote
- `channels`: list, get, search, create, update, topic, purpose, join, leave,
  archive, unarchive, delete, members, add-member, remove-member,
  set-add-policy
- `dms`: list, open, add-member, hide
- `reactions`: add, remove, get
- `emoji`: list, set, rm, export, import
- `canvas`: get, set
- `users`: get, set-profile, presence, set-presence, set-status
- `workflows`: list, get, create, update, delete, trigger, runs, approve
- `feed`: get
- `social`: publish, set-contacts, event, notes, contacts, set-list, list
- `notes`: set, get, ls, rm
- `repos`: create, get, list, bind, protect list, protect set, protect remove
- `patches`: send, get, list, status
- `issues`: create, get, list, status
- `pr`: open, update, get, list, status
- `projects`: add-repo, create, delete, get, list, remove-repo, update
- `media`: get
- `upload`: file
- `mem`: ls, get, hash, set, patch, rm
- `agents`: draft-create, draft-update, archive, unarchive, archived
- `moderation`: reports, resolve, ban, unban, timeout, untimeout, restricted,
  audit
- `pack`: validate, inspect

The operator's policy normally exposes only a subset. Dangerous administration,
moderation, workflow approval, agent management, channel/project deletion, and
repo protection require an explicit custom allowlist and dangerous-operation
acknowledgement.

## Output and errors

Successful output is the pinned CLI's native output:

- Most reads return JSON arrays; most writes return an event result containing
  `event_id`, `accepted`, and `message`.
- `canvas get` returns raw Markdown or `null`.
- `social` and repo event reads return raw signed event JSON.
- `upload file` returns a multi-line blob descriptor.
- `mem get` returns raw bytes; `mem hash` returns a SHA-256 string;
  `mem set`, `mem patch`, and `mem rm` may produce no stdout.
- `mem ls` is tab-delimited unless the request supplies the CLI's `json` flag.
- `pack validate` and `pack inspect` return human-readable text.

Broker or policy failures are written to stderr with a `buzz broker:` prefix
and exit code 1. Pinned Buzz CLI results preserve its codes: 0 success, 1
input/not-found, 2 relay/network, 3 authentication, 4 other, and 5 write
conflict. Do not retry policy, membership, ownership, malformed request, or
authentication failures. Retry transient relay/network failures with bounded
backoff while the current turn capability remains valid.
