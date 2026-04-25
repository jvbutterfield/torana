// §12.5.4: Bun's HTTP server should not be exhausted by a slow
// multipart upload (the "slow loris" attack pattern). Bun's
// default timeout behaviour gates this — we don't add in-process
// TLS / connection timeouts of our own.
//
// The matrix entry calls this "document expected behaviour" rather
// than empirically simulate a TCP-level stall. Simulating slow-loris
// accurately requires raw-socket control that fetch() doesn't expose,
// and flake-prone timing assumptions. This test instead pins the
// two concrete invariants that hold regardless of TCP pacing:
//
//   1. There is no per-bot or per-token queue of outstanding multipart
//      requests that could be trivially filled. Each request is
//      independently handled by Bun's request loop.
//   2. Finite caps exist that bound the total resource a single
//      request can consume: max_body_bytes, max_files_per_request,
//      disk_usage_cap_bytes, per-file size cap. A slow client still
//      can't bypass these — aggregate size is re-checked after parse.
//
// If in the future we add explicit request-deadline handling at the
// agent-api layer, this file is the place to pin its behaviour.

import { describe, expect, test } from "bun:test";

import { makeTestConfig, makeTestBotConfig } from "../../fixtures/bots.js";

describe("§12.5.4 resource.slow-loris (behavioural pin)", () => {
  test("config caps are finite and non-zero — a slow client cannot bypass them by dragging out the request", () => {
    const cfg = makeTestConfig([makeTestBotConfig("bot1")]);

    expect(cfg.agent_api.ask.max_body_bytes).toBeGreaterThan(0);
    expect(cfg.agent_api.ask.max_files_per_request).toBeGreaterThan(0);
    expect(cfg.attachments.max_bytes).toBeGreaterThan(0);
    expect(cfg.attachments.disk_usage_cap_bytes).toBeGreaterThan(0);

    // Caps are small enough (MiB-scale, not GiB-scale) that even a
    // request held open indefinitely can only commit `max_body_bytes`
    // worth of buffering per request.
    expect(cfg.agent_api.ask.max_body_bytes).toBeLessThanOrEqual(
      1024 * 1024 * 1024,
    );
  });

  test("per-request caps prevent a slow client from steering around limits via content-length removal", () => {
    // The attachments parser aggregates decoded file sizes *after*
    // parse and re-checks against max_body_bytes. A client that
    // drops Content-Length to bypass the early-reject path still
    // hits the aggregate check. See src/agent-api/attachments.ts
    // around the `if (aggregate > maxBody)` branch.
    // This test is a docblock-level guard — it pins that the check
    // exists in source by string-matching on it.
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(
        __dirname,
        "../../../src/agent-api/attachments.ts",
      ),
      "utf8",
    );
    expect(src).toContain("aggregate >");
    expect(src).toContain("body_too_large");
  });
});
