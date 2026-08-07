// `torana buzz keygen` / `torana buzz auth-tag`.
//
// These two close the one step of Buzz setup that had no first-party path:
// producing the owner attestation every Buzz endpoint requires. The property
// under test is end-to-end — a tag minted by the CLI must satisfy the same
// verifier the gateway uses at config load, not merely look well-formed.

import { describe, expect, test } from "bun:test";

import { runBuzz } from "../../src/cli/buzz.js";
import { ExitCode } from "../../src/cli/shared/exit.js";
import {
  decodeSecret,
  parseOwnerAuthTag,
  publicKey,
  verifyOwnerAuthTag,
  ownerAuthTagAllowsEvent,
} from "../../src/platform/buzz/protocol.js";

async function keypair(): Promise<{ secret: string; pubkey: string }> {
  const out = await runBuzz(["keygen", "--format", "json"]);
  const parsed = JSON.parse(out.stdout.join("\n")) as {
    private_key: string;
    public_key: string;
  };
  return { secret: parsed.private_key, pubkey: parsed.public_key };
}

describe("torana buzz keygen", () => {
  test("emits a usable keypair whose public key derives from its secret", async () => {
    const out = await runBuzz(["keygen", "--format", "json"]);
    expect(out.exitCode).toBe(ExitCode.success);
    const parsed = JSON.parse(out.stdout.join("\n")) as Record<string, string>;
    expect(parsed.private_key).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.nsec).toStartWith("nsec1");
    expect(parsed.npub).toStartWith("npub1");
    // The derivation is the point — a mismatched pair would fail config load.
    expect(publicKey(decodeSecret(parsed.private_key!))).toBe(
      parsed.public_key,
    );
  });

  test("generates a distinct key each run", async () => {
    const a = await keypair();
    const b = await keypair();
    expect(a.secret).not.toBe(b.secret);
  });

  test("text output warns that the secret is not stored", async () => {
    const out = await runBuzz(["keygen"]);
    expect(out.exitCode).toBe(ExitCode.success);
    expect(out.stderr.join(" ")).toContain("not stored");
  });
});

describe("torana buzz auth-tag", () => {
  test("mints a tag the gateway's own verifier accepts", async () => {
    const owner = await keypair();
    const agent = await keypair();
    const out = await runBuzz(
      ["auth-tag", "--agent-pubkey", agent.pubkey, "--format", "json"],
      { env: { BUZZ_OWNER_PRIVATE_KEY: owner.secret } },
    );
    expect(out.exitCode).toBe(ExitCode.success);
    const parsed = JSON.parse(out.stdout.join("\n")) as {
      auth_tag: string;
      owner_pubkey: string;
    };
    expect(parsed.owner_pubkey).toBe(owner.pubkey);

    const tag = parseOwnerAuthTag(parsed.auth_tag);
    expect(tag).not.toBeNull();
    expect(verifyOwnerAuthTag(tag!, agent.pubkey)).toBe(true);
    // Default conditions permit ordinary messages (kind 9) and nothing else.
    expect(ownerAuthTagAllowsEvent(tag!, { kind: 9, created_at: 1 })).toBe(
      true,
    );
    expect(ownerAuthTagAllowsEvent(tag!, { kind: 7, created_at: 1 })).toBe(
      false,
    );
  });

  test("a tag minted for one identity does not verify for another", async () => {
    const owner = await keypair();
    const agent = await keypair();
    const other = await keypair();
    const out = await runBuzz(
      ["auth-tag", "--agent-pubkey", agent.pubkey, "--format", "json"],
      { env: { BUZZ_OWNER_PRIVATE_KEY: owner.secret } },
    );
    const tag = parseOwnerAuthTag(
      (JSON.parse(out.stdout.join("\n")) as { auth_tag: string }).auth_tag,
    );
    expect(verifyOwnerAuthTag(tag!, other.pubkey)).toBe(false);
  });

  test("accepts an npub for the endpoint and an nsec for the owner", async () => {
    const ownerJson = JSON.parse(
      (await runBuzz(["keygen", "--format", "json"])).stdout.join("\n"),
    ) as { nsec: string; public_key: string };
    const agentJson = JSON.parse(
      (await runBuzz(["keygen", "--format", "json"])).stdout.join("\n"),
    ) as { npub: string; public_key: string };

    const out = await runBuzz(
      ["auth-tag", "--agent-pubkey", agentJson.npub, "--format", "json"],
      { env: { BUZZ_OWNER_PRIVATE_KEY: ownerJson.nsec } },
    );
    expect(out.exitCode).toBe(ExitCode.success);
    const parsed = JSON.parse(out.stdout.join("\n")) as {
      auth_tag: string;
      agent_pubkey: string;
    };
    expect(parsed.agent_pubkey).toBe(agentJson.public_key);
    expect(
      verifyOwnerAuthTag(
        parseOwnerAuthTag(parsed.auth_tag)!,
        agentJson.public_key,
      ),
    ).toBe(true);
  });

  test("honours explicit conditions", async () => {
    const owner = await keypair();
    const agent = await keypair();
    const out = await runBuzz(
      [
        "auth-tag",
        "--agent-pubkey",
        agent.pubkey,
        "--conditions",
        "kind=7",
        "--format",
        "json",
      ],
      { env: { BUZZ_OWNER_PRIVATE_KEY: owner.secret } },
    );
    const tag = parseOwnerAuthTag(
      (JSON.parse(out.stdout.join("\n")) as { auth_tag: string }).auth_tag,
    );
    expect(ownerAuthTagAllowsEvent(tag!, { kind: 7, created_at: 1 })).toBe(
      true,
    );
    expect(ownerAuthTagAllowsEvent(tag!, { kind: 9, created_at: 1 })).toBe(
      false,
    );
  });

  test("refuses without an owner secret, and never takes one from argv", async () => {
    const agent = await keypair();
    const out = await runBuzz(["auth-tag", "--agent-pubkey", agent.pubkey], {
      env: {},
    });
    expect(out.exitCode).toBe(ExitCode.badUsage);
    expect(out.stderr.join(" ")).toContain("BUZZ_OWNER_PRIVATE_KEY");
    expect(out.stdout).toEqual([]);
  });

  test("refuses without an endpoint pubkey", async () => {
    const owner = await keypair();
    const out = await runBuzz(["auth-tag"], {
      env: { BUZZ_OWNER_PRIVATE_KEY: owner.secret },
    });
    expect(out.exitCode).toBe(ExitCode.badUsage);
    expect(out.stderr.join(" ")).toContain("--agent-pubkey");
  });

  test("owner and endpoint must differ, and the error carries no key material", async () => {
    const owner = await keypair();
    const out = await runBuzz(["auth-tag", "--agent-pubkey", owner.pubkey], {
      env: { BUZZ_OWNER_PRIVATE_KEY: owner.secret },
    });
    expect(out.exitCode).toBe(ExitCode.badUsage);
    expect(out.stderr.join(" ")).not.toContain(owner.secret);
  });

  test("a malformed owner secret fails cleanly without echoing it", async () => {
    const agent = await keypair();
    const out = await runBuzz(["auth-tag", "--agent-pubkey", agent.pubkey], {
      env: { BUZZ_OWNER_PRIVATE_KEY: "not-a-key-at-all" },
    });
    expect(out.exitCode).toBe(ExitCode.badUsage);
    expect(out.stderr.join(" ")).not.toContain("not-a-key-at-all");
  });
});
