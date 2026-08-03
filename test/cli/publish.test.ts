import { describe, expect, test } from "bun:test";
import { runPublish } from "../../src/cli/publish.js";

const KEY = "publisher-key-0000000001";

describe("publish CLI", () => {
  test("reads message content outside argv and sends the stable key", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const result = await runPublish(
      ["publish", "dev-team"],
      ["--source", "worker-terminal", "--idempotency-key", KEY],
      {
        env: {
          TORANA_SERVER: "http://127.0.0.1:3000",
          TORANA_PUBLISH_TOKEN: "secret-token",
        },
        readFile: (path) => {
          expect(path).toBe(0);
          return "safe stdin content";
        },
        fetchImpl: (async (url, init) => {
          seenUrl = String(url);
          seenInit = init;
          return new Response(
            JSON.stringify({
              publication_id: 1,
              outbox_id: 2,
              status: "accepted",
              replayed: false,
            }),
            { status: 202, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(seenUrl).toEndWith("/v1/publishers/dev-team/messages");
    expect(
      (seenInit?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe(KEY);
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      content: "safe stdin content",
      source: "worker-terminal",
      severity: "info",
    });
    expect(result.stdout.join(" ")).not.toContain("safe stdin content");
  });

  test("status sends the key in a bounded JSON body, never the URL", async () => {
    let seenUrl = "";
    let seenBody = "";
    const result = await runPublish(
      ["publish", "status"],
      ["dev-team", "--idempotency-key", KEY],
      {
        env: {
          TORANA_SERVER: "http://127.0.0.1:3000",
          TORANA_PUBLISH_TOKEN: "secret-token",
        },
        fetchImpl: (async (url, init) => {
          seenUrl = String(url);
          seenBody = String(init?.body);
          return new Response(
            JSON.stringify({
              publication_id: 1,
              outbox_id: 2,
              status: "sent",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(seenUrl).not.toContain(KEY);
    expect(JSON.parse(seenBody)).toEqual({ idempotency_key: KEY });
  });

  test("raw token flags and positional content are rejected", async () => {
    expect(
      runPublish(
        ["publish", "dev-team"],
        ["secret positional", "--idempotency-key", KEY],
        { env: {} },
      ),
    ).rejects.toThrow(/content must come from stdin or --file/);
    expect(
      runPublish(
        ["publish", "dev-team"],
        ["--token", "secret", "--idempotency-key", KEY],
        { env: {} },
      ),
    ).rejects.toThrow(/unknown flag: --token/);
  });
});
