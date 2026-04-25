// Focused tests for TelegramClient's 429 / Retry-After parsing and the
// HTTP timeout. The rest of the client is exercised end-to-end via the
// outbox / polling / streaming tests; this file covers the per-error
// fields the rc.7 review pass added.

import { describe, expect, test } from "bun:test";

import { TelegramClient, TelegramError } from "../../src/telegram/client.js";

function fetchReturning(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch): TelegramClient {
  return new TelegramClient({
    botId: "alpha",
    token: "TT:AAAA",
    apiBaseUrl: "https://api.telegram.test",
    fetchImpl,
  });
}

describe("TelegramClient 429 / Retry-After", () => {
  test("envelope parameters.retry_after is parsed into TelegramError.retryAfterMs", async () => {
    const fetchImpl = fetchReturning(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 7",
      parameters: { retry_after: 7 },
    });
    const client = makeClient(fetchImpl);
    const r = await client.sendMessage(111, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retriable).toBe(true);
      expect(r.retryAfterMs).toBe(7000);
    }
  });

  test("HTTP Retry-After header is parsed into TelegramError.retryAfterMs", async () => {
    const fetchImpl = fetchReturning(
      429,
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
      },
      { "retry-after": "12" },
    );
    const client = makeClient(fetchImpl);
    const r = await client.sendMessage(111, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBe(12_000);
    }
  });

  test("HTTP Retry-After header takes precedence over envelope retry_after", async () => {
    // Some intermediaries override the body's value with a CDN-side
    // header. Prefer the header — it represents the most upstream
    // cooldown and is what the network path will rate-limit against.
    const fetchImpl = fetchReturning(
      429,
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 5 },
      },
      { "retry-after": "30" },
    );
    const client = makeClient(fetchImpl);
    const r = await client.sendMessage(111, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBe(30_000);
    }
  });

  test("retry_after: 0 is treated as missing (don't skip natural backoff)", async () => {
    // Telegram occasionally returns retry_after=0 on flaky 5xx; treating
    // it as a real cooldown would skip our exponential backoff.
    const fetchImpl = fetchReturning(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 0 },
    });
    const client = makeClient(fetchImpl);
    const r = await client.sendMessage(111, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBeUndefined();
    }
  });

  test("non-429 errors carry no retryAfterMs", async () => {
    const fetchImpl = fetchReturning(500, {
      ok: false,
      error_code: 500,
      description: "internal server error",
    });
    const client = makeClient(fetchImpl);
    const r = await client.sendMessage(111, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBeUndefined();
      expect(r.retriable).toBe(true);
    }
  });

  test("TelegramError exposes retryAfterMs as a public field", () => {
    const err = new TelegramError(
      "sendMessage",
      429,
      429,
      "Too Many Requests",
      4500,
    );
    expect(err.retryAfterMs).toBe(4500);
    expect(err.isRetriable).toBe(true);
  });

  test("editMessageText surfaces retryAfterMs from a 429", async () => {
    const fetchImpl = fetchReturning(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 3 },
    });
    const client = makeClient(fetchImpl);
    const r = await client.editMessageText(111, 222, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBe(3000);
      expect(r.retriable).toBe(true);
      expect(r.notModified).toBe(false);
    }
  });
});

describe("TelegramClient HTTP timeout", () => {
  test("api() wires AbortSignal.timeout into the fetch call", async () => {
    // Verify the contract: the fetch we issue carries an AbortSignal whose
    // timer is bounded. We don't wait the full 30s production timeout in a
    // unit test — the fetchImpl resolves immediately once the signal is
    // observed, returning a benign 200 to keep sendMessage's promise tidy.
    let observedSignal: AbortSignal | null = null;
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      observedSignal = init?.signal ?? null;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const r = await client.sendMessage(111, "hi");
    expect(r.ok).toBe(true);
    expect(observedSignal).not.toBeNull();
    // AbortSignal.timeout is the only way the client populates this signal;
    // a non-null .reason field would only appear after the timer fires.
    // We don't wait that long — presence of the signal is the contract.
    expect(observedSignal!.aborted).toBe(false);
  });

  test("api() surfaces a network/timeout error as TelegramError(httpStatus=0)", async () => {
    // Simulate the fetch rejecting (e.g. AbortSignal.timeout firing). The
    // resulting TelegramError must be retriable so the caller's backoff
    // path engages.
    const fetchImpl = (async () => {
      throw new Error("The operation timed out.");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const r = await client.sendMessage(111, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retriable).toBe(true);
      expect(r.description).toContain("timed out");
    }
  });
});
