// Tests for src/agent-api/client.ts — typed AgentApiClient.
//
// Uses an injected fetchImpl that records calls so we can assert URL,
// method, headers, and body without spinning up an HTTP server. The
// authoritative integration coverage is in the existing handler tests
// (test/agent-api/{ask,send,router}.test.ts) — these tests pin the
// client shim's request construction + response parsing.

import { describe, expect, test } from "bun:test";

import { AgentApiClient, AgentApiError } from "../../src/agent-api/client.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null;
}

function recordingFetch(
  responder: (call: RecordedCall) => Response | Promise<Response>,
): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    const call: RecordedCall = {
      url: typeof url === "string" ? url : url.toString(),
      method: init?.method ?? "GET",
      headers,
      body: (init?.body as BodyInit | undefined) ?? null,
    };
    calls.push(call);
    return await responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TOKEN = "tok-test";

describe("AgentApiClient — server URL handling", () => {
  test("strips trailing slash from server URL", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { bots: [] }),
    );
    const c = new AgentApiClient({
      server: "http://localhost:8787///",
      token: TOKEN,
      fetchImpl,
    });
    await c.listBots();
    expect(calls[0]!.url).toBe("http://localhost:8787/v1/bots");
  });

  test("Authorization header is Bearer + token", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { bots: [] }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    await c.listBots();
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("AgentApiClient.listBots", () => {
  test("returns parsed body on 200", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, {
        bots: [
          {
            bot_id: "alpha",
            runner_type: "claude-code",
            supports_side_sessions: true,
          },
        ],
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.listBots();
    expect(r.bots).toHaveLength(1);
    expect(r.bots[0]!.bot_id).toBe("alpha");
  });

  test("401 → AgentApiError with code invalid_token", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(401, { error: "invalid_token", message: "bad bearer" }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.listBots();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentApiError);
      const e = err as AgentApiError;
      expect(e.code).toBe("invalid_token");
      expect(e.status).toBe(401);
      expect(e.message).toBe("bad bearer");
    }
  });
});

describe("AgentApiClient.ask", () => {
  test("JSON body for ask without files", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        text: "echo: hi",
        turn_id: 1,
        session_id: "eph-abc",
        usage: { input_tokens: 4, output_tokens: 5 },
        duration_ms: 12,
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.ask("alpha", {
      text: "hi",
      session_id: "s1",
      timeout_ms: 5000,
    });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.text).toBe("echo: hi");
    expect(r.turn_id).toBe(1);
    expect(r.session_id).toBe("eph-abc");
    expect(r.usage).toEqual({ input_tokens: 4, output_tokens: 5 });
    expect(r.duration_ms).toBe(12);

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://x/v1/bots/alpha/ask");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.body as string)).toEqual({
      text: "hi",
      session_id: "s1",
      timeout_ms: 5000,
    });
  });

  test("202 → in_progress shape", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(202, {
        turn_id: 9,
        session_id: "eph-x",
        status: "in_progress",
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.ask("alpha", { text: "slow" });
    expect(r.status).toBe("in_progress");
    if (r.status !== "in_progress") return;
    expect(r.turn_id).toBe(9);
    expect(r.session_id).toBe("eph-x");
  });

  test("503 runner_fatal → AgentApiError", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(503, { error: "runner_fatal", message: "spawn died" }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.ask("alpha", { text: "x" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentApiError);
      const e = err as AgentApiError;
      expect(e.code).toBe("runner_fatal");
      expect(e.status).toBe(503);
    }
  });

  test("multipart construction when files supplied", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        text: "ok",
        turn_id: 1,
        session_id: "eph-y",
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    await c.ask("alpha", { text: "look at this" }, [
      {
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        filename: "diff.png",
        contentType: "image/png",
      },
    ]);
    const call = calls[0]!;
    expect(call.body).toBeInstanceOf(FormData);
    const fd = call.body as FormData;
    expect(fd.get("text")).toBe("look at this");
    const file = fd.get("file");
    // FormData stores Files; check it's a Blob-shaped value.
    expect(file).toBeTruthy();
    expect(typeof (file as Blob).arrayBuffer).toBe("function");
    expect((file as Blob).type).toBe("image/png");
    // Content-Type for multipart is set by FormData/fetch boundary; we
    // explicitly DO NOT set Content-Type ourselves.
    expect(call.headers["Content-Type"]).toBeUndefined();
  });

  test("network failure → AgentApiError with code network", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.listBots();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentApiError);
      expect((err as AgentApiError).code).toBe("network");
      expect((err as AgentApiError).status).toBe(0);
    }
  });

  test("malformed JSON response → AgentApiError malformed_response", async () => {
    const fetchImpl = (async () =>
      new Response("<html>oops", { status: 200 })) as unknown as typeof fetch;
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.listBots();
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AgentApiError).code).toBe("malformed_response");
    }
  });

  test("non-JSON 5xx body still surfaces as AgentApiError", async () => {
    const fetchImpl = (async () =>
      new Response("upstream timeout", {
        status: 502,
      })) as unknown as typeof fetch;
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.ask("alpha", { text: "hi" });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as AgentApiError;
      expect(e.status).toBe(502);
      // Falls back to "internal_error" since the body wasn't JSON.
      expect(e.code).toBe("internal_error");
      expect(e.message).toContain("upstream timeout");
    }
  });
});

describe("AgentApiClient.send", () => {
  test("Idempotency-Key header sent + 202 parsed", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(202, { turn_id: 42, status: "queued" }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.send(
      "alpha",
      { text: "9am standup", source: "calendar", user_id: "12345" },
      { idempotencyKey: "abcd-1234-efgh-5678-zzzz" },
    );
    expect(r.turn_id).toBe(42);
    expect(r.status).toBe("queued");

    const call = calls[0]!;
    expect(call.url).toBe("http://x/v1/bots/alpha/send");
    expect(call.headers["Idempotency-Key"]).toBe("abcd-1234-efgh-5678-zzzz");
    expect(JSON.parse(call.body as string)).toEqual({
      text: "9am standup",
      source: "calendar",
      user_id: "12345",
    });
  });

  test("multipart send preserves Idempotency-Key header", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(202, { turn_id: 1, status: "queued" }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    await c.send(
      "alpha",
      { text: "see attached", source: "monitor", chat_id: 7 },
      {
        idempotencyKey: "qqqqqqqqqqqqqqqq",
        files: [
          {
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            filename: "alert.pdf",
            contentType: "application/pdf",
          },
        ],
      },
    );
    const call = calls[0]!;
    expect(call.headers["Idempotency-Key"]).toBe("qqqqqqqqqqqqqqqq");
    expect(call.body).toBeInstanceOf(FormData);
    const fd = call.body as FormData;
    expect(fd.get("source")).toBe("monitor");
    expect(fd.get("chat_id")).toBe("7");
  });

  test("403 target_not_authorized parsed", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(403, {
        error: "target_not_authorized",
        message: "not in ACL",
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.send(
        "alpha",
        { text: "x", source: "src", user_id: "1" },
        { idempotencyKey: "0123456789abcdef" },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AgentApiError).code).toBe("target_not_authorized");
      expect((err as AgentApiError).status).toBe(403);
    }
  });
});

describe("AgentApiClient.getTurn", () => {
  test("in_progress shape", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, { turn_id: 5, status: "in_progress" }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.getTurn(5);
    expect(r.status).toBe("in_progress");
    expect(r.turn_id).toBe(5);
  });

  test("done with text + usage", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, {
        turn_id: 5,
        status: "done",
        text: "hello",
        usage: { input_tokens: 1, output_tokens: 2 },
        duration_ms: 33,
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.getTurn(5);
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.text).toBe("hello");
    expect(r.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(r.duration_ms).toBe(33);
  });

  test("failed with error", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, {
        turn_id: 9,
        status: "failed",
        error: "interrupted_by_gateway_restart",
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.getTurn(9);
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.error).toBe("interrupted_by_gateway_restart");
  });

  test("410 turn_result_expired surfaces as AgentApiError", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(410, {
        error: "turn_result_expired",
        message: "older than 24h",
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.getTurn(99);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AgentApiError).code).toBe("turn_result_expired");
      expect((err as AgentApiError).status).toBe(410);
    }
  });
});

describe("AgentApiClient.listSessions + deleteSession", () => {
  test("listSessions returns parsed shape", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        sessions: [
          {
            session_id: "abc",
            started_at: "2026-04-19T10:00:00Z",
            last_used_at: "2026-04-19T10:01:00Z",
            hard_expires_at: "2026-04-20T10:00:00Z",
            state: "idle",
            inflight: 0,
            ephemeral: false,
          },
        ],
      }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    const r = await c.listSessions("alpha");
    expect(r.sessions).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://x/v1/bots/alpha/sessions");
  });

  test("deleteSession sends DELETE + returns void on 204", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(null, { status: 204 }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    await c.deleteSession("alpha", "sess-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("http://x/v1/bots/alpha/sessions/sess-1");
  });

  test("deleteSession 404 → AgentApiError session_not_found", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(404, { error: "session_not_found" }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    try {
      await c.deleteSession("alpha", "missing");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AgentApiError).code).toBe("session_not_found");
    }
  });
});

describe("URL component encoding", () => {
  test("bot_id with slash is percent-encoded", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { bots: [] }),
    );
    const c = new AgentApiClient({
      server: "http://x",
      token: TOKEN,
      fetchImpl,
    });
    await c.listSessions("a/b");
    expect(calls[0]!.url).toBe("http://x/v1/bots/a%2Fb/sessions");
  });
});
