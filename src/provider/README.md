# `buzz-backend-torana`

A Buzz Desktop **remote-agent provider** that deploys an agent onto a Torana
gateway. Buzz Desktop discovers it by filename on `PATH`; the suffix after
`buzz-backend-` is the provider id, so the file must be named exactly
`buzz-backend-torana`.

## What it does, and what it deliberately does not

Deploying an agent through this provider moves the agent's _runtime_ to Torana.
Torana keeps it online independently of the Desktop — closing the app no longer
takes the agent offline, which is the entire point.

What a deploy means depends on the gateway and on the id you name:

- **The agent is declared in the gateway's `torana.yaml`.** The deploy creates
  an **endpoint** and attaches it. Everything about how that agent thinks — its
  system prompt, model, timeouts, parallelism — is Torana's configuration, not
  the Desktop's, and those fields are reported back in the deploy result rather
  than silently dropped, so you can see what did not apply.
- **The id is unknown and the gateway has a `provisioning` block.** The deploy
  **creates the agent**: its record, its workspace, and its endpoint, in one
  operation. Instructions, model, and timeouts _are_ applied, and the result
  names the resulting instruction version. The harness is chosen **by name**
  from the operator's allowlist (`torana_harness`, else derived from
  `launch.command`); the binary path and base environment are the gateway's,
  never the payload's.
- **The id is unknown and the gateway has no `provisioning` block.** Refused
  with an actionable error listing the agents it does know.

A deploy naming an agent the gateway declares in YAML never mutates that
agent's definition, whatever the payload carries.

**There is no stop.** The remote-agents protocol has no `undeploy` op in v1, so
Desktop's "Stop" for a remote agent does not call this binary at all: it
publishes `!shutdown` into a channel, and Torana's endpoint drains, announces
itself offline, and stays down until an operator resumes it or you press Start
again. Do not expect a provider call on Stop, and do not expect an agent to come
back on its own after one.

## Install

Download the release artifact for your platform, verify its checksum against the
published `SHA256SUMS`, and put it on your `PATH`:

```sh
sha256sum -c SHA256SUMS
install -m 0755 buzz-backend-torana ~/.local/bin/buzz-backend-torana
```

macOS (Apple silicon) and Linux x64 are the supported targets. **Windows is not
supported**: upstream discovery leaves the `.exe` extension in the derived
provider id, so a Windows provider probes successfully but cannot deploy. That
is a Desktop-side defect, not something this binary can work around.

## Configure

The gateway bearer never goes in the Desktop's provider config — that object is
persisted by the Desktop, and invariant I2 forbids secrets in it. Put the token
in this provider's own file instead:

```sh
mkdir -p ~/.config/torana
cat > ~/.config/torana/provider.json <<'JSON'
{ "admin_token": "…the endpoints:admin token…" }
JSON
chmod 600 ~/.config/torana/provider.json
```

Multiple gateways get named references:

```json
{
  "tokens": {
    "production": "…",
    "staging": "…"
  }
}
```

Then in the Desktop's provider form:

| Field                | Meaning                                                    |
| -------------------- | ---------------------------------------------------------- |
| `torana_url`         | Gateway base URL. Must be `https://` unless it's localhost |
| `torana_agent_id`    | The agent in `torana.yaml` this endpoint attaches to       |
| `torana_admin_ref`   | Which entry in `provider.json` to use (default `default`)  |
| `torana_endpoint_id` | Optional; defaults to `<agent>-buzz`                       |
| `community_id`       | Defaults to `primary`                                      |
| `respond_to`         | `owner_only` (default), `allowlist`, `anyone`, `nobody`    |
| `subscribe`          | `mentions_and_dms` (default) or `all_channels`             |

**Not `torana_admin_token_ref`.** Buzz Desktop rejects any provider_config key
whose words include "token", "key", "secret", "password", or "credential" —
a check meant to keep secrets out of Desktop-persisted config, applied by name
rather than by value. It therefore refused the one field designed to hold a
_reference instead of_ a secret, and the schema's own default prefills the key
so it cannot be cleared from the form. The old name is still read for configs
stored before the rename.

The gateway side needs a dedicated `endpoints:admin` token and
`TORANA_PROVISIONING_SECRETS_KEY`; see
[configuration](../../docs/configuration.md#buzz-endpoint-provisioning).

## What it refuses, and why

- **An agent with no NIP-OA auth tag.** Torana's hosted relay answers
  `403 relay_membership_required` without the owner attestation, and the owner
  is also what authorizes the remote `!shutdown`. Upstream omits `owner_pubkey`
  entirely when the tag is null, so a null-tag deploy would produce an endpoint
  nobody could stop.
- **Relay-mesh transports**, and **desktop-loopback relays** when the gateway is
  not itself local — the remote host's `localhost` is a different machine.
- **A plaintext `http://` gateway**, except for localhost. The agent's nsec
  crosses that hop.
- **Reserved env vars** (`BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`, `BUZZ_RELAY_URL`,
  …). Identity comes from the deploy payload's own fields; a user value here
  would be ignored, so it is reported instead.

## Secret handling

The Desktop sends the agent's nsec before it verifies the provider's
`protocol_version` (upstream Known Defect 5), which this binary cannot fix. What
it does instead: validate the payload shape before anything is transmitted, hold
the key only in memory, send it only over TLS to the configured `torana_url`,
never write it to disk, and scrub every known secret value — plus anything
shaped like `nsec1…` or `sprt_tok_…` — from any error it emits. The Desktop
redacts provider output too; this binary does not rely on that.

## Deploy semantics

`PUT` once, then poll. Exactly one create attempt per call, per the spec's
normative rule: a deterministic startup failure cannot be fixed by re-running
the same create inside the same call, and retrying would churn gateway state
every poll interval. If the endpoint does not report connected with fresh
presence within 120 s, the deploy fails with the last observed status and the
endpoint is left in place — press Start again to retry, which is a new,
deliberate act.

Reconciliation is keyed on the pubkey derived from the submitted key, so
pressing Start on an already-running agent is a no-op (`"result": "unchanged"`)
rather than a redeploy.

## Deliberate divergences from the reference provider

`buzz-backend-kubernetes` is the normative reference for the wire contract.
Torana diverges in two places, both on purpose and both visible in the deploy
result rather than silent.

**1. Instruction changes apply to a running agent.** The reference provider
returns a strict no-op for a live, started pod (`classify.rs`) and fingerprints
env _keys_ only, excluding values (`intent.rs`) — so a system prompt travelling
as a `policy_env` value would not register as divergence at all. Editing
instructions there changes nothing until the pod restarts for an unrelated
reason.

That rule exists because pod replacement is the only lever that substrate has,
and it is destructive: it kills whatever is running. Torana owns the runner
process, so it keeps the safety property and drops the limitation. An accepted
instruction change updates the record and recycles the agent's sessions with the
existing drain-safe primitive, which waits for in-flight turns to finish. No
running turn is ever interrupted; every turn started after the deploy returns
success uses the new instructions.

**2. No Desktop env layer is honored for Desktop-managed agents.** The reference
`wire.rs` orders `policy_env` as tier 1 and `launch.env` as tier 2. For an agent
Torana _created_, there is no user env tier to order: base env is harness-owned
and identity env is Torana-owned, so `env_vars`, `launch.env`, and `policy_env`
are all reported not-applied. Reserved identity keys are still refused loudly
rather than dropped. Endpoint-only deploys against a YAML agent are unaffected.

Wire contract pinned against Buzz Desktop `desktop-v0.5.9`.

## Deleting a Desktop-managed agent

There is no `undeploy` op, so deleting the agent in Desktop does not call this
binary either. Desktop publishes an owner-signed NIP-09 tombstone against the
agent's `kind:30177` record; the gateway verifies it and **stages** the
deletion — drain, offline, then a persisted grace period (72 h by default)
before anything durable is destroyed. It is reversible for that whole window
with `torana agents restore <id>`.

Two consequences worth knowing as a provider user. Desktop's tombstone publish
is best-effort, so a delete that fails to publish leaves a running remote agent
that only shows up in the gateway's reconciliation report. And re-deploying an
agent whose deletion is staged un-stages it — a deploy is fresh owner intent —
which is recorded loudly rather than done silently.
