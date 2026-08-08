// US-025 — the `buzz-backend-torana` provider binary.
//
// Two things are being defended. First the wire contract: one JSON object in,
// one out, non-zero exit on failure, caps respected. Second, and more
// important, that a secret never leaves this process — the Desktop redacts
// provider output, but a provider that relies on that has already lost.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backendAgentId,
  buildAgentBlock,
  deploy,
  deriveHarnessName,
  effectiveRespondTo,
  encodeResponse,
  encodeStderr,
  handleRequest,
  infoResponse,
  loadAdminToken,
  managedByToranaMessage,
  normalizeRespondTo,
  PROTOCOL_VERSION,
  ProviderError,
  scrubSecrets,
  type ProviderRequest,
} from "../../src/provider/buzz-backend-torana.js";

const NSEC = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsecret99";
const AUTH_TAG = '["auth","ownerpub","kind=9","1900000000","sig"]';
const TOKEN = "provisioning-token-value-0123456789";
const VERSION = "2.0.0-test";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function providerConfig(overrides: Record<string, unknown> = {}) {
  return {
    torana_url: "https://torana.example",
    torana_agent_id: "cato",
    torana_admin_token_ref: "default",
    ...overrides,
  };
}

function deployRequest(
  overrides: {
    agent?: Record<string, unknown>;
    provider_config?: Record<string, unknown>;
  } = {},
): ProviderRequest {
  return {
    op: "deploy",
    request_id: "11111111-2222-4333-8444-555555555555",
    agent: {
      name: "Cato",
      relay_url: "wss://relay.example",
      private_key_nsec: NSEC,
      auth_tag: AUTH_TAG,
      respond_to: "owner_only",
      launch: { owner_pubkey: "ownerpub" },
      ...overrides.agent,
    },
    provider_config: providerConfig(overrides.provider_config),
  };
}

/** A Torana that accepts the PUT and reports connected on the first GET. */
function happyFetch(
  calls: Array<{ method: string; url: string; body?: string }>,
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(url),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (method === "PUT") {
      return new Response(
        JSON.stringify({
          endpoint_id: "cato-buzz",
          agent_id: "cato",
          pubkey: "abc",
          result: "created",
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        endpoint_id: "cato-buzz",
        runtime_state: "healthy",
        connected: true,
        presence: {
          last_published_at: 1_785_000_000_000,
          consecutive_failures: 0,
          stale: false,
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

const deployDeps = (
  fetchImpl: typeof fetch,
  extra: Record<string, unknown> = {},
) => ({
  fetchImpl,
  loadToken: () => TOKEN,
  sleep: async () => {},
  ...extra,
});

describe("info", () => {
  test("declares the protocol version and a form schema the Desktop can render", async () => {
    const response = (await handleRequest({ op: "info" }, VERSION)) as Record<
      string,
      unknown
    >;
    expect(response.ok).toBe(true);
    expect(response.name).toBe("torana");
    expect(response.protocol_version).toBe(PROTOCOL_VERSION);
    expect(response.version).toBe(VERSION);

    const schema = response.config_schema as {
      required: string[];
      properties: Record<string, { default?: unknown; enum?: string[] }>;
    };
    expect(schema.required).toEqual(["torana_url", "torana_agent_id"]);
    expect(Object.keys(schema.properties)).toContain("torana_admin_token_ref");
    expect(schema.properties.respond_to!.enum).toContain("owner_only");
    expect(schema.properties.community_id!.default).toBe("primary");

    // I2: the schema must not invite a secret into provider_config.
    const rendered = JSON.stringify(infoResponse(VERSION));
    expect(rendered).not.toContain('admin_token"');
    expect(rendered).toContain("must never be entered here");
  });
});

describe("deploy", () => {
  test("PUTs once, polls until online, and returns the stable agent id", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const response = (await deploy(
      deployRequest(),
      deployDeps(happyFetch(calls)),
    )) as Record<string, unknown>;

    expect(response.ok).toBe(true);
    expect(response.agent_id).toBe("railway:agent-team:cato-buzz");
    expect(response.endpoint_id).toBe("cato-buzz");
    expect(response.result).toBe("created");

    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
    expect(calls[0]!.url).toBe(
      "https://torana.example/v1/admin/buzz/endpoints/cato-buzz",
    );
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent).toMatchObject({
      agent_id: "cato",
      relay_url: "wss://relay.example",
      private_key: NSEC,
      auth_tag: AUTH_TAG,
      owner_pubkey: "ownerpub",
      deploy_nonce: "11111111-2222-4333-8444-555555555555",
    });
  });

  test("exactly one create attempt per call, even while polling for a long time", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let elapsed = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url) });
      if (method === "PUT") return new Response("{}", { status: 200 });
      // Never becomes ready.
      return new Response(
        JSON.stringify({ runtime_state: "connecting", connected: false }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      deploy(
        deployRequest(),
        deployDeps(fetchImpl, {
          now: () => elapsed,
          sleep: async () => {
            elapsed += 2000;
          },
          readyTimeoutMs: 20_000,
        }),
      ),
    ).rejects.toThrow(/did not come online within 20s/);

    // The whole point: one PUT, many GETs. A delete/mint/create loop here
    // would be a bounded-call resource DoS on the gateway.
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(
      calls.filter((call) => call.method === "GET").length,
    ).toBeGreaterThan(1);
  });

  test("a stale-presence endpoint is not reported as deployed", async () => {
    let elapsed = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT")
        return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({
          runtime_state: "unhealthy",
          connected: true,
          presence: { last_published_at: 1, stale: true },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await expect(
      deploy(
        deployRequest(),
        deployDeps(fetchImpl, {
          now: () => elapsed,
          sleep: async () => {
            elapsed += 5000;
          },
          readyTimeoutMs: 10_000,
        }),
      ),
    ).rejects.toThrow(/did not come online/);
  });

  test("Torana's refusal is surfaced verbatim", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_body",
          message: "unknown agent 'ghost'; configured agents: cato, jules",
        }),
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(
      deploy(deployRequest(), deployDeps(fetchImpl)),
    ).rejects.toThrow(/configured agents: cato, jules/);
  });

  test("an unreachable Torana fails with a diagnostic, not a hang", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443");
    }) as unknown as typeof fetch;
    await expect(
      deploy(deployRequest(), deployDeps(fetchImpl)),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

// The Desktop serializes `RespondTo` kebab-case and Torana's schema is
// snake_case, so every one of these fixtures uses the Desktop's real
// vocabulary (`owner-only`), not ours. The bug this covers survived because
// the existing tests only ever fed back the value we generate.
describe("respond_to normalization", () => {
  test("translates the Desktop's kebab-case into Torana's snake_case", () => {
    expect(normalizeRespondTo("owner-only", "the deploy payload")).toBe(
      "owner_only",
    );
    expect(normalizeRespondTo("allowlist", "the deploy payload")).toBe(
      "allowlist",
    );
    expect(normalizeRespondTo("anyone", "the deploy payload")).toBe("anyone");
  });

  test("accepts a value already in Torana's vocabulary, and tolerates case and padding", () => {
    expect(normalizeRespondTo("owner_only", "provider config")).toBe(
      "owner_only",
    );
    expect(normalizeRespondTo("  Owner-Only  ", "provider config")).toBe(
      "owner_only",
    );
  });

  test("refuses an unrecognized mode loudly, naming the source and the valid set", () => {
    expect(() => normalizeRespondTo("everyone", "provider config")).toThrow(
      ProviderError,
    );
    try {
      normalizeRespondTo("everyone", "provider config");
      throw new Error("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("provider config");
      expect(message).toContain("everyone");
      expect(message).toContain("owner_only");
      expect(message).toContain("nobody");
    }
  });
});

describe("respond_to composition", () => {
  test("provider config cannot widen what the Desktop projected", () => {
    // The case 0.5.6's owner-only clamp exists to prevent: the Desktop shows a
    // locked owner-only control while the remote deployment answers anyone.
    expect(effectiveRespondTo("owner-only", "anyone")).toBe("owner_only");
    expect(effectiveRespondTo("owner-only", "allowlist")).toBe("owner_only");
  });

  test("provider config may still narrow it", () => {
    expect(effectiveRespondTo("anyone", "owner_only")).toBe("owner_only");
    expect(effectiveRespondTo("allowlist", "nobody")).toBe("nobody");
  });

  test("allowlist ranks wider than owner_only from either direction", () => {
    expect(effectiveRespondTo("allowlist", "owner_only")).toBe("owner_only");
    expect(effectiveRespondTo("owner-only", "allowlist")).toBe("owner_only");
  });

  test("nobody beats every other mode, whichever side supplies it", () => {
    for (const other of ["owner-only", "allowlist", "anyone"]) {
      expect(effectiveRespondTo(other, "nobody")).toBe("nobody");
      expect(effectiveRespondTo("nobody", other)).toBe("nobody");
    }
  });

  test("falls back to owner_only rather than the widest mode when a side is missing", () => {
    expect(effectiveRespondTo(undefined, null)).toBe("owner_only");
    expect(effectiveRespondTo("", null)).toBe("owner_only");
    expect(effectiveRespondTo("anyone", null)).toBe("anyone");
    expect(effectiveRespondTo(undefined, "anyone")).toBe("anyone");
    expect(effectiveRespondTo(42, null)).toBe("owner_only");
  });
});

describe("respond_to on the wire", () => {
  const sentBody = (calls: Array<{ method: string; body?: string }>) =>
    JSON.parse(calls.find((call) => call.method === "PUT")!.body!) as Record<
      string,
      unknown
    >;

  test("a Desktop payload with no config override reaches Torana in its own vocabulary", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const response = (await deploy(
      deployRequest({ agent: { respond_to: "owner-only" } }),
      deployDeps(happyFetch(calls)),
    )) as Record<string, unknown>;

    expect(response.ok).toBe(true);
    // Forwarding `owner-only` verbatim is what Torana's schema rejects.
    expect(sentBody(calls).respond_to).toBe("owner_only");
  });

  test("an operator config cannot widen the Desktop's clamped access", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    await deploy(
      deployRequest({
        agent: { respond_to: "owner-only" },
        provider_config: { respond_to: "anyone" },
      }),
      deployDeps(happyFetch(calls)),
    );

    expect(sentBody(calls).respond_to).toBe("owner_only");
  });

  test("allowlist mode carries its allowlist through", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    await deploy(
      deployRequest({
        agent: {
          respond_to: "allowlist",
          respond_to_allowlist: ["ab".repeat(32)],
        },
        provider_config: { respond_to: "allowlist" },
      }),
      deployDeps(happyFetch(calls)),
    );

    const sent = sentBody(calls);
    expect(sent.respond_to).toBe("allowlist");
    expect(sent.allowed_pubkeys).toEqual(["ab".repeat(32)]);
  });

  test("a stale allowlist is dropped by every mode that would reject it", async () => {
    // Torana rejects an unused allowlist on `anyone` and `nobody` outright, and
    // a Desktop record readily holds a list from a mode it has moved off.
    for (const mode of ["anyone", "nobody", "owner-only"]) {
      const calls: Array<{ method: string; url: string; body?: string }> = [];
      await deploy(
        deployRequest({
          agent: { respond_to: mode, respond_to_allowlist: ["cd".repeat(32)] },
          provider_config: { respond_to: mode },
        }),
        deployDeps(happyFetch(calls)),
      );

      expect(sentBody(calls).allowed_pubkeys).toBeUndefined();
    }
  });

  test("an unrecognized mode fails in band before anything is created", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const response = (await handleRequest(
      deployRequest({ agent: { respond_to: "everyone" } }),
      VERSION,
      deployDeps(happyFetch(calls)),
    )) as Record<string, unknown>;

    expect(response.ok).toBe(false);
    expect(response.error).toContain("everyone");
    expect(calls).toEqual([]);
  });
});

describe("deploy refusals", () => {
  const cases: Array<{
    name: string;
    request: ProviderRequest;
    matches: RegExp;
  }> = [
    {
      name: "a null auth tag",
      request: deployRequest({ agent: { auth_tag: null } }),
      matches: /no NIP-OA auth tag/,
    },
    {
      name: "an empty auth tag",
      request: deployRequest({ agent: { auth_tag: "" } }),
      matches: /no NIP-OA auth tag/,
    },
    {
      name: "a relay-mesh transport",
      request: deployRequest({ agent: { relay_url: "relay-mesh://peer/abc" } }),
      matches: /relay-mesh transport/,
    },
    {
      name: "a desktop-loopback relay against a remote gateway",
      request: deployRequest({ agent: { relay_url: "ws://127.0.0.1:3000" } }),
      matches: /desktop-loopback relay/,
    },
    {
      name: "a missing nsec",
      request: deployRequest({ agent: { private_key_nsec: "" } }),
      matches: /no private_key_nsec/,
    },
    {
      name: "a missing relay url",
      request: deployRequest({ agent: { relay_url: "" } }),
      matches: /no relay_url/,
    },
    {
      name: "a reserved env var",
      request: deployRequest({
        agent: { env_vars: { BUZZ_AUTH_TAG: "smuggled" } },
      }),
      matches: /reserved/,
    },
    {
      name: "a plaintext http gateway",
      request: deployRequest({
        provider_config: { torana_url: "http://torana.example" },
      }),
      matches: /must be https/,
    },
    {
      name: "a missing agent binding",
      request: deployRequest({
        provider_config: { torana_agent_id: undefined },
      }),
      matches: /torana_agent_id/,
    },
  ];

  for (const scenario of cases) {
    test(`refuses ${scenario.name} without contacting Torana`, async () => {
      let contacted = false;
      const fetchImpl = (async () => {
        contacted = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      await expect(
        deploy(scenario.request, deployDeps(fetchImpl)),
      ).rejects.toThrow(scenario.matches);
      expect(contacted).toBe(false);
    });
  }

  test("every refusal is in-band, and none of them leak the nsec", async () => {
    const fetchImpl = (async () => {
      throw new Error(`upstream said: ${NSEC} was rejected`);
    }) as unknown as typeof fetch;

    const scenarios = [
      ...cases.map((scenario) => scenario.request),
      deployRequest(),
    ];
    for (const request of scenarios) {
      const response = await handleRequest(request, VERSION, {
        fetchImpl,
        loadToken: () => TOKEN,
        sleep: async () => {},
      });
      expect(response.ok).toBe(false);
      const rendered = encodeResponse(response);
      // The upstream error text deliberately contains the nsec; a provider
      // that passes such a string through is exactly the leak the spec's
      // redaction rule exists to catch, and we do not rely on that redaction.
      expect(rendered).not.toContain(NSEC);
      expect(rendered).not.toContain(TOKEN);
    }
  });
});

describe("admin token handling", () => {
  test("the token comes from the provider's own config file, not provider_config", () => {
    const dir = mkdtempSync(join(tmpdir(), "torana-provider-cfg-"));
    dirs.push(dir);
    const path = join(dir, "provider.json");
    writeFileSync(
      path,
      JSON.stringify({
        admin_token: TOKEN,
        tokens: { staging: "staging-tok" },
      }),
    );
    expect(
      loadAdminToken(
        "default",
        (p) => require("node:fs").readFileSync(p, "utf8"),
        path,
      ),
    ).toBe(TOKEN);
    expect(
      loadAdminToken(
        "staging",
        (p) => require("node:fs").readFileSync(p, "utf8"),
        path,
      ),
    ).toBe("staging-tok");
  });

  test("a missing file or unknown reference is a clear error", () => {
    expect(() =>
      loadAdminToken(
        "default",
        () => {
          throw new Error("ENOENT");
        },
        "/nowhere/provider.json",
      ),
    ).toThrow(ProviderError);
    expect(() =>
      loadAdminToken(
        "missing",
        () => JSON.stringify({ tokens: {} }),
        "/x.json",
      ),
    ).toThrow(/no admin token named 'missing'/);
  });

  test("the token never appears in a request URL", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    await deploy(deployRequest(), deployDeps(happyFetch(calls)));
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(call.body ?? "").not.toContain(TOKEN);
    }
  });
});

describe("protocol shape", () => {
  test("unknown, missing, and malformed ops are in-band failures", async () => {
    expect(await handleRequest({ op: "undeploy" }, VERSION)).toMatchObject({
      ok: false,
    });
    expect(
      ((await handleRequest({ op: "undeploy" }, VERSION)) as { error: string })
        .error,
    ).toContain("info and deploy");
    expect(await handleRequest({}, VERSION)).toMatchObject({ ok: false });
    expect(await handleRequest([], VERSION)).toMatchObject({ ok: false });
    expect(await handleRequest(null, VERSION)).toMatchObject({ ok: false });
    expect(await handleRequest("string", VERSION)).toMatchObject({ ok: false });
  });

  test("an oversized response is replaced rather than truncated mid-JSON", () => {
    const huge = { ok: true as const, blob: "x".repeat(2 * 1024 * 1024) };
    const encoded = encodeResponse(huge);
    expect(encoded.length).toBeLessThan(1024 * 1024);
    expect(JSON.parse(encoded)).toMatchObject({ ok: false });
  });

  test("stderr is capped at the contract's 64 KiB", () => {
    expect(encodeStderr("short")).toBe("short");
    expect(
      Buffer.byteLength(encodeStderr("y".repeat(100_000))),
    ).toBeLessThanOrEqual(64 * 1024);
  });

  test("unmapped Desktop knobs are reported, not silently dropped", () => {
    expect(managedByToranaMessage({})).not.toContain("were not applied");
    const message = managedByToranaMessage({
      system_prompt: "be nice",
      model: "opus",
      parallelism: 4,
    });
    expect(message).toContain("system_prompt");
    expect(message).toContain("model");
    expect(message).toContain("parallelism");
    expect(message).toContain("managed by Torana");
  });

  test("the backend agent id keeps the existing Desktop addressing", () => {
    expect(backendAgentId("cato-buzz")).toBe("railway:agent-team:cato-buzz");
  });
});

describe("scrubbing", () => {
  test("literals are removed longest-first, and known shapes regardless of source", () => {
    expect(scrubSecrets(`token=${TOKEN}`, [TOKEN])).toBe("token=[redacted]");
    // A short prefix of a longer secret must not leave the longer one intact.
    expect(scrubSecrets("aaaa-aaaabbbb", ["aaaa", "aaaabbbb"])).toBe(
      "[redacted]-[redacted]",
    );
    // Never seen in the request, still scrubbed.
    expect(scrubSecrets("leaked nsec1abcdefghijkl here")).toBe(
      "leaked [redacted] here",
    );
    expect(scrubSecrets("sprt_tok_ABC123xyz")).toBe("[redacted]");
    // Short values are left alone: scrubbing "ok" out of every message would
    // make errors unreadable for no security gain.
    expect(scrubSecrets("all ok", ["ok"])).toBe("all ok");
  });
});

describe("the real binary", () => {
  const entry = join(
    import.meta.dir,
    "../../src/provider/buzz-backend-torana.ts",
  );

  async function run(
    stdin: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", entry], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test("info over real stdio exits 0 with one JSON object", async () => {
    const { code, stdout } = await run(JSON.stringify({ op: "info" }));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.protocol_version).toBe(PROTOCOL_VERSION);
    expect(parsed.name).toBe("torana");
    // Exactly one object, not a stream.
    expect(stdout.trim().startsWith("{")).toBe(true);
    expect(stdout.trim().endsWith("}")).toBe(true);
  }, 30_000);

  test("a failing op exits non-zero with an in-band error and no secret on either stream", async () => {
    const { code, stdout, stderr } = await run(
      JSON.stringify(deployRequest({ agent: { auth_tag: null } })),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("auth tag");
    expect(stdout).not.toContain(NSEC);
    expect(stderr).not.toContain(NSEC);
  }, 30_000);

  test("garbage on stdin is a clean failure, not a crash", async () => {
    const { code, stdout } = await run("not json at all");
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
  }, 30_000);

  test("empty stdin is a clean failure", async () => {
    const { code, stdout } = await run("");
    expect(code).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
  }, 30_000);
});

describe("loopback relays", () => {
  test("are allowed against a loopback gateway and refused against a remote one", async () => {
    // Local development and the E2E both run a fake relay on 127.0.0.1; that
    // is coherent only because the gateway is local too.
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const local = await deploy(
      deployRequest({
        agent: { relay_url: "ws://127.0.0.1:9999" },
        provider_config: { torana_url: "http://127.0.0.1:3001" },
      }),
      deployDeps(happyFetch(calls)),
    );
    expect(local.ok).toBe(true);

    await expect(
      deploy(
        deployRequest({
          agent: { relay_url: "ws://localhost:9999" },
          provider_config: { torana_url: "https://torana.example" },
        }),
        deployDeps(happyFetch([])),
      ),
    ).rejects.toThrow(/desktop-loopback relay/);
  });
});

// ── US-032: the agent block ─────────────────────────────────────────────────

describe("deriveHarnessName", () => {
  test("explicit torana_harness wins over the launch command", () => {
    expect(
      deriveHarnessName({ torana_harness: "claude" }, "/usr/bin/goose"),
    ).toBe("claude");
  });

  test("derives a bare name from a host path", () => {
    // Read as a hint only. Torana resolves the binary from its own allowlist;
    // the path itself is never executed (R7.3).
    expect(deriveHarnessName({}, "/usr/local/bin/goose")).toBe("goose");
    expect(deriveHarnessName(undefined, "goose")).toBe("goose");
  });

  test("strips a Windows extension", () => {
    // Upstream leaves `.exe` in the derived provider id, so without this a
    // Windows Desktop asks for a harness nobody would ever have allowlisted.
    expect(deriveHarnessName({}, "C:\\tools\\goose.exe")).toBe("goose");
  });

  test("is undefined when there is nothing to derive from", () => {
    expect(deriveHarnessName({}, undefined)).toBeUndefined();
    expect(deriveHarnessName({}, "   ")).toBeUndefined();
  });
});

describe("buildAgentBlock", () => {
  test("carries instructions, model, and the supplied timeouts", () => {
    const block = buildAgentBlock(
      {
        system_prompt: "be terse",
        model: "claude-sonnet-5",
        turn_timeout_seconds: 900,
        launch: { command: "/usr/local/bin/claude" },
      },
      {},
    );
    expect(block).toEqual({
      harness: "claude",
      system_prompt: "be terse",
      model: "claude-sonnet-5",
      turn_timeout_seconds: 900,
    });
  });

  test("omits fields the Desktop did not set rather than sending nulls", () => {
    // A null would be indistinguishable from "explicitly cleared" on the
    // Torana side, where absence means "no opinion, use the ceiling".
    const block = buildAgentBlock(
      { launch: { command: "claude" } },
      {},
    ) as Record<string, unknown>;
    expect(Object.keys(block).sort()).toEqual(["harness", "system_prompt"]);
  });

  test("is undefined when no harness can be named", () => {
    // An endpoint attach: Torana falls through to the YAML path.
    expect(buildAgentBlock({ system_prompt: "hi" }, {})).toBeUndefined();
  });

  test("never carries a binary path, argv, or env", () => {
    const block = buildAgentBlock(
      {
        launch: {
          command: "/usr/local/bin/claude",
          args: ["--dangerous"],
          env: { SECRET: "x" },
        },
        env_vars: { OTHER: "y" },
      },
      {},
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(block);
    expect(serialized).not.toContain("/usr/local/bin");
    expect(serialized).not.toContain("--dangerous");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("OTHER");
  });
});
