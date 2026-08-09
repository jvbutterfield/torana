# Buzz platform

Each Buzz endpoint is a distinct Nostr identity connected to a configured
relay. The Block hosted relay requires the community relay URL, endpoint
private key, owner public key, and matching owner-signed auth tag supplied by
the operator. Store them in runtime secrets; quote auth-tag interpolation in
YAML because the value is serialized JSON.

## Getting Buzz credentials

Four values per endpoint. Two you generate, one you already have, one your
community gives you.

**1. The relay URL** (`relay_url`) comes from your community. For the Block
hosted relay it is the `wss://…` endpoint issued for that community.

**2. The endpoint identity** (`private_key`) is a fresh Nostr keypair — one per
endpoint, never shared between them:

```sh
torana buzz keygen
```

That prints a `private_key`, its derived `public_key`, and the `nsec`/`npub`
forms. It writes nothing to disk. Put the secret straight into your secret
manager; you will not be shown it again.

**3. The owner identity** (`owner_pubkey`) is the human or team account that
vouches for the endpoint — normally the identity you already use in Buzz
Desktop. You need its _public_ key for the config, and its _secret_ key once,
to sign step 4.

**4. The owner attestation** (`auth_tag`) is a NIP-OA tag: the owner signing
"this endpoint identity may act on my behalf, under these conditions." Mint it
with the endpoint's public key from step 2:

```sh
export BUZZ_OWNER_PRIVATE_KEY='nsec1…'      # or 64-hex
torana buzz auth-tag --agent-pubkey <endpoint-public-key>
```

The owner secret is read from the environment rather than a flag, so it stays
out of `argv` and shell history. The default condition is `kind=9` — ordinary
messages — which is what a conversational endpoint needs; pass `--conditions`
to widen or narrow it. Both commands take `--format json` for scripting.

Wire the four values in as environment references:

```yaml
relay_url: ${BUZZ_RELAY_URL}
private_key: "${BUZZ_PRIVATE_KEY_REVIEWER}" # step 2
auth_tag: "${BUZZ_AUTH_TAG_REVIEWER}" # step 4 — quote it, it is JSON
owner_pubkey: "${BUZZ_OWNER_PUBKEY}" # step 3
```

Then check it before starting anything:

```sh
torana validate --config torana.yaml
```

Torana derives the public key from `private_key` and refuses to start unless it
matches what the auth tag attests, so a mismatched pair fails at config load
rather than at the relay. `403 relay_membership_required` at connect time means
the identity reached the relay but its attestation was missing, wrong, or
didn't permit the event kind.

Rotation is the same four steps with a new keypair; see
[operations](../operations.md#buzz-key-and-auth-rotation).

```yaml
platforms:
  buzz:
    enabled: false

agents:
  - id: reviewer
    endpoints:
      - id: reviewer-buzz
        platform: buzz
        enabled: false
        community_id: primary
        relay_url: ${BUZZ_RELAY_URL}
        private_key: "${BUZZ_PRIVATE_KEY_REVIEWER}"
        auth_tag: "${BUZZ_AUTH_TAG_REVIEWER}"
        owner_pubkey: "${BUZZ_OWNER_PUBKEY}"
        respond_to: owner_only
        subscribe: mentions_and_dms
```

Both switches must be true before an endpoint connects. On connection Torana
authenticates, discovers accessible channels, replays from its composite
cursor, and starts live event plus membership subscriptions. Invalid
signatures, unexpected authors, missing exact mentions, unauthorized event
kinds, and removed membership fail closed before runner dispatch.

Messages, edits, deletes, reactions, forum operations, and votes are signed
before durable delivery. An uncertain or operator-requested replay republishes
the exact stored event ID; it never re-signs. Typing and conversation-driven
presence are rate-limited best-effort signals and are not replayed.

The endpoint's owner can stop it from Buzz Desktop: a stream message whose
trimmed content is exactly `!shutdown` and which mentions the endpoint, signed
by `owner_pubkey`, drains in-flight turns, publishes presence `offline`, and
disables the endpoint durably. Nobody else can, on any `respond_to` setting,
and a message that merely contains `!shutdown` is an ordinary prompt. Opt out
with `owner_shutdown: disabled`.

The endpoint stays down across restarts, but a provider deploy revives it —
including the automatic redeploy Buzz Desktop 0.5.6 performs when it loads
community UI, which Torana cannot distinguish from an owner pressing "Start".
See [operations](../operations.md#owner-shutdown-remote-agent-stop).

The supervisor's own presence heartbeat is not best-effort in the same sense:
it is the only thing a Buzz client reads to decide whether the agent is online,
and the relay expires presence 180 s after the last accepted publish. That
refresh is therefore exempt from `limits.presence_min_interval_ms`, and a run
of failed refreshes marks the endpoint unhealthy with `presence_stale` before
the TTL can lapse. See
[configuration](../configuration.md#presence-heartbeats-and-the-relays-ttl).

Stream channels default to one session per channel. Forum roots default to one
session per root. DMs, streams, forums, workflows, and Telegram remain isolated
unless the operator declares a same-agent alias. Trace tags help cooperative
loop diagnosis, while local per-conversation and per-endpoint reply limits are
the security backstop.

Attachments accept only signed, same-origin relay media URLs under `/media/`.
Redirects, foreign origins, compressed responses, oversize bodies, hash
mismatches, and MIME spoofing are rejected. Outbound media is uploaded once;
its descriptor and signed event are persisted for exact retry.

Workspace actions use the endpoint-scoped broker described in
[security](../security.md). The normal runner environment contains no private
key or auth tag. Conversation turns receive a session-scoped capability
automatically; Agent API `ask` turns receive one only when their token sets
`buzz_tools: true` (see [agent-api](../agent-api.md)). See [operations](../operations.md) for rotation, replay,
draining, and canary rollout.

## Desktop-managed agents

Everything above describes an agent you declared in `torana.yaml`. Torana also
supports agents whose **whole definition** — instructions, model, harness,
timeouts — lives in the gateway database, created from Buzz Desktop with no
YAML edit and no redeploy. The two kinds coexist permanently; neither is being
migrated to the other.

This is off unless the gateway has a `provisioning:` block
([configuration](../configuration.md#provisioning)). Without one, a deploy that
tries to create an agent is refused with `not_configured` and nothing else
changes.

### YAML always wins, for agents as well as endpoints

An id declared in `torana.yaml` can never be shadowed, mutated, or deleted by
anything arriving over the wire. Concretely:

- A deploy naming a **YAML agent** attaches an endpoint to it, exactly as
  before. Any instruction fields in the payload are reported back as
  not-applied; the agent's definition is untouched.
- A deploy naming a **publisher id** (or a publisher's endpoint id) is refused
  with `agent '<id>' is managed by static config`. Publishers share one global
  id namespace with agents, and "unknown id" now means _create_, so this gate
  fires before anything is written.
- A record tombstone naming a **YAML endpoint's identity** deletes nothing. It
  is logged and it appears in the reconciliation report, and that is all. There
  is no sequence of relay events that can remove an agent you wrote down.

### Instructions are applied at the turn boundary

When a deploy carries a real instruction change, Torana persists it, rebuilds
the agent, and schedules a drain-safe recycle of that agent's live sessions. A
turn already running finishes under the instructions it started with; every
turn started after the deploy returns success uses the new ones. Nothing is
interrupted.

Which instructions an agent is actually running is observable — every agent
carries an **instruction version**, a digest over the applied prompt, model, and
honored timeouts:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  https://gateway.example/v1/admin/buzz/agents | jq '.agents[].instruction_version'
```

It hashes _applied_ values, so two deploys differing only by a timeout that
clamps to the same ceiling are the same version. It also moves when you change
the harness config underneath a running agent, because that genuinely changes
what the agent executes.

**Known upstream limitation: an edit is not live until the next deploy.** No
Desktop _edit_ action calls the provider. Editing instructions in Desktop
changes nothing remotely until something deploys — pressing Start, or the
automatic reconcile Desktop performs when it loads community UI. The practical
consequence is that an edit can ship at a surprising moment, minutes or hours
later, when someone opens the community. This is upstream behaviour and Torana
cannot detect the difference; see the note on Start-versus-reconcile in
[operations](../operations.md#owner-shutdown-remote-agent-stop).

### Deleting is staged, never immediate

Deleting the agent in Buzz Desktop publishes an owner-signed NIP-09 tombstone
against its `kind:30177` record. Torana keeps one relay connection per distinct
relay across all managed agents — independent of any endpoint, so it is still
listening after you have stopped an agent, which is the usual order — verifies
the tombstone, and **stages** the deletion:

1. the endpoint drains in-flight turns and announces presence `offline`;
2. the record is marked deleted and a purge deadline is persisted;
3. an operator alert fires.

Nothing durable is destroyed until the grace period (`delete_grace_hours`,
default 72 h) expires. The deadline lives in the database, so a restart,
redeploy, or container replacement mid-window neither resurrects the agent nor
purges it early.

Reverse it while the window is open:

```sh
torana agents restore <id>
# or: POST /v1/admin/buzz/agents/<id>/restore
```

**What restore does and does not do.** It cancels the purge. It does _not_ bring
the endpoint back up — that happens on the next deploy, or on an explicit
`torana endpoints resume <id>`. And the agent is now running with **no Desktop
record behind it**, because the Desktop deleted its copy before the tombstone
was ever published. That state is real and it is what the reconciliation report
is for; it is not a bug to be papered over.

After the deadline, a sweep (every 300 s) removes the record, the endpoint, the
sealed secrets, and the workspace directory. The audit record describing the
purge is committed **before** any of it and is exempt from ordinary retention
pruning — a purge log deleted along with the agent proves nothing.

Only an owner-signed tombstone (or a deliberate operator action) can stage a
deletion. There is no TTL, no idle timer, no presence heuristic, and no
reconcile-driven reaping: an agent missing from a reconcile set means nothing at
all.

**Reliability caveat, stated rather than engineered around.** Desktop's
tombstone publish is best-effort — a failure is logged and swallowed so it never
blocks the local delete. A delete that never published leaves a running remote
agent, and no cursor can recover an event that was never sent. That agent shows
up in the reconciliation report with its `kind:30177` record absent; removing it
is then an operator decision (`torana agents purge <id>
--acknowledge-data-loss`), never an automatic one.

### The reconciliation report

Advisory only. It has no write path: nothing in it can trigger a deletion.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  https://gateway.example/v1/admin/buzz/reconciliation | jq
torana agents report            # the database half, works with the gateway down
```

It lists every managed agent with its lifecycle, endpoint state, presence,
instruction version, and whether its managed-agent record is `present`,
`absent`, or `unknown` on the relay — plus every tombstone that was seen and
deleted nothing, with the reason. `unknown` means the relay could not be
reached; it never silently becomes `absent`.

Two states worth acting on: a record `absent` while the agent is `active` is the
never-published-tombstone case above. A `yaml_identity` rejection means someone
deleted a Desktop record whose identity belongs to a YAML agent — harmless, but
worth understanding.

### Workspaces, and the honest limit of their isolation

Each managed agent gets `<data_dir>/workspaces/<agent_id>`, created `0700`, used
as its runner's working directory, retained across stop/start and restart, and
removed only at purge. The path is derived by Torana from the validated agent
id and never taken from Desktop input.

**This is not a sandbox.** Every harness process runs as the same UID. Nothing
Torana does ever points one agent at another's directory, and the Buzz CLI
broker refuses cross-workspace paths — but a harness that _chooses_ to read
outside its own `cwd` is not stopped by the filesystem. The residual is exactly
the trust boundary this feature assumes: a single owner, no multi-tenant
isolation. If you need real isolation between agents, run separate gateways.

### What the Desktop cannot reach

A managed agent's Buzz CLI policy comes from `provisioning.buzz_tools_default`,
set once by the operator. A Desktop record cannot widen its own privileges. The
harness allowlist owns every binary path and base environment, so a payload can
only fill placeholders the operator already wrote — it can never add an argv
element or an env key. Reserved identity env keys are refused loudly rather than
dropped.
