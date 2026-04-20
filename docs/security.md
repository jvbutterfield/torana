# Security

## Threat model

### In scope

torana's v1 threat surface covers:

- **Webhook secret bypass** — any request to `/webhook/:botId` without a valid `X-Telegram-Bot-Api-Secret-Token` header must be rejected with 403.
- **ACL bypass** — updates must include `from.id`, and that id must be in the bot's effective `allowed_user_ids`.
- **Path traversal on attachments** — attacker-controlled filenames never appear on disk (mime-derived allowlist only).
- **Secret leakage via logs** — known secrets and `/bot<TOKEN>/` URL segments are redacted by the central logger.
- **RCE in config parsing** — `js-yaml` is used in its default safe mode; custom types are not enabled.
- **Supply-chain vulnerabilities** in our runtime dependencies (audited via `npm audit --audit-level=high` at release).

### Out of scope

- **Downstream runner vulnerabilities** — report to the runner vendor (e.g. Anthropic for Claude Code).
- **Telegram platform issues** — report directly to Telegram.
- **Denial-of-service from an allowlisted user** — the trust model assumes allowlist members are trustworthy.
- **Env-var exposure of bot tokens via `ps auxe`** — platform-level concern, documented here but not solved in v1. Use file-based secrets in multi-tenant hosts.

## Request-path guarantees

- **Webhook secret** compared with `crypto.timingSafeEqual` (constant time).
- **ACL default-deny.** Empty `allowed_user_ids` refuses all updates and emits a loud `warn` at startup.
- **`from.id` required.** Channel posts, anonymous admins, and service messages (which can omit `from`) are rejected before ACL.
- **ACL-rejected updates return HTTP 200** with no reaction — attackers get no signal that the bot exists or that their id was denied.

## Secret handling

- **URL-path redactor.** `/bot<TOKEN>/<method>` URLs in log fields, error messages, and stack traces are rewritten to `/bot<redacted>/<method>`. Enforced centrally — callers cannot opt out.
- **Value redactor.** At startup, the logger is seeded with every secret value pulled from the resolved config (bot tokens, webhook secret). Any occurrence of those exact strings in log payloads is masked with `<redacted>`.
- **Empty secrets rejected.** `bots[].token` and `transport.webhook.secret` must be non-empty after env interpolation. `${VAR:-}` with a missing var is a fatal config-load error.
- **Doctor C007.** `torana doctor` warns if your config file is world-readable (mode with world-read bit set). Does not refuse to start.

## Attachments

- **Safe filename rule.** On-disk filenames are `<update_id>-<index>.<ext>`, where both integers are gateway-controlled and `<ext>` comes from a fixed allowlist keyed on the mime-type Telegram reports for the file:
  - `image/jpeg → .jpg`, `image/png → .png`, `image/webp → .webp`, `image/gif → .gif`
  - `application/pdf → .pdf`
  - anything else → `.bin`
- **Write confinement.** Target path is re-resolved and checked to stay inside `${data_dir}/attachments/<bot_id>/` before write.
- **DoS caps.** `attachments.max_bytes` (20 MB default), `max_per_turn` (10), `disk_usage_cap_bytes` (1 GB default circuit breaker between sweeps).

## Transport exposure

- `/health` and `/webhook/:botId` are always reachable if the gateway's port is public.
- `/metrics` and `/dashboard/*` are opt-in via config; when off, they return 404 (indistinguishable from "not deployed").
- `/metrics` has **no auth** in v1. Don't expose `gateway.port` to the public internet — keep it behind a firewall or an auth-ing reverse proxy.

## Telegram TLS

All calls use `telegram.api_base_url` (default `https://api.telegram.org`) over TLS with the Bun/Node default CA bundle. torana does **not** pin Telegram's certificate in v1; the residual risk is DNS/CA compromise in the gateway's environment. Mitigation for high-threat deployments: restrict outbound traffic to known Telegram IPs at the network layer.

## Supply chain

- Minimal runtime deps: `js-yaml ^4`, `zod ^3`, `bun:sqlite` (built in).
- **No lifecycle scripts.** The published package declares no `preinstall`/`postinstall`/`prepare`. CI enforces this.
- Quickstart recommends `--ignore-scripts` to block transitive install-time scripts.
- Published with `--provenance --access public` — attests the package was built from this repo.
- `npm audit --audit-level=high` is a release gate.
- `gitleaks` runs on every PR.

## Agent API auth

Opt-in HTTP surface at `/v1/*`. Covered by a distinct set of guarantees on top
of the main ACL / secret story above. Full protocol in
[`agent-api.md`](agent-api.md); summary:

- **Bearer tokens are the only authentication.** Network access controls
  (TLS, firewall, VPN, reverse proxy) are the operator's responsibility —
  `torana doctor` surfaces this as `C014`.
- **SHA-256 + `timingSafeEqual`.** Tokens are hashed at load time and
  compared constant-time; the raw value is added to the redaction set so
  it never appears in logs.
- **Per-bot scoping.** A token can only drive bots listed in its
  `bot_ids` array. Requests to other bots return the same error shape as
  "token invalid" — callers can't probe for bot existence.
- **Per-scope gating.** `ask` and `inject` are distinct scopes; a token
  scoped `["inject"]` cannot call `/v1/bots/:id/ask` (403).
- **Inject ACL re-check.** Agent-API tokens authorize *bots*, not *users*.
  The resolved `user_id` is re-validated against the bot's
  `access_control.allowed_user_ids` before the turn is enqueued.
- **No enumeration.** Turn lookups return a single `turn_not_found` code
  regardless of the underlying cause (nonexistent, cross-caller,
  telegram-origin). Rate-limit 403s and 429s uniformly.
- **Attachment hardening.** Filenames are gateway-controlled
  (`agentapi-<uuid>-<idx><ext>`); per-file, aggregate, count, and
  disk-usage caps all enforced in `parseMultipartRequest`.
- **Idempotency is a safety property**, not just a UX one — retrying an
  `inject` under a flaky network cannot double-send.

Doctor `C009..C014` catch the most common misconfigurations before the
gateway starts accepting traffic; `torana doctor --server URL --token TOK`
(`R001..R003`) probes a running gateway from the caller's side.

## Disclosure

Security issues: email `security@` (setting up the alias — see GitHub for the most up-to-date contact), or use GitHub's private vulnerability reporting on this repo.

**Response SLO for v1:** best-effort, 30 days to triage, no formal SLA.

Out-of-scope reports receive a pointer to the correct upstream.
