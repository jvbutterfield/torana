// §12.4: full HTTP `ask` round-trip against the REAL claude binary.
//
// What we're verifying here that unit/security tests cannot:
//   1. The real Claude Code CLI produces output the runner's parser
//      can consume (no schema drift).
//   2. The pool's spawn → first-turn → done path works with a real
//      subprocess on this host (timing, env, auth).
//   3. The handler's 202/200 split + poll loop both succeed with real
//      latency (not mock-instant).
//
// Cost: one real model turn per test. Prompts are deliberately tiny.

import { afterEach, describe, expect, test } from "bun:test";

import {
  e2eEnabled,
  inheritedEnv,
  mkToken,
  pollTurn,
  startE2E,
  type E2EHarness,
} from "./_harness.js";
import type { BotConfig } from "../../../src/config/schema.js";

const describeOrSkip = e2eEnabled() ? describe : describe.skip;

let h: E2EHarness | null = null;

afterEach(async () => {
  if (h) {
    await h.close();
    h = null;
  }
});

function claudeBot(): BotConfig {
  return {
    id: "alpha",
    token: "e2e-claude-bot-token:ffffffffffffffffffffffff",
    commands: [],
    reactions: { received_emoji: "👀" },
    runner: {
      type: "claude-code",
      cli_path: process.env.CLAUDE_CLI_PATH ?? "claude",
      args: [],
      // E2E uses the full inherited env: claude reads more than HOME
      // for auth (keychain handles, XDG_*, plugin caches), and
      // listing them individually is fragile across OS/version
      // combos. For the E2E suite we accept the broader env since
      // the tests are deliberately "local binary with local auth"
      // anyway.
      env: inheritedEnv(),
      pass_continue_flag: false,
    },
  };
}

describeOrSkip("§12.4 ask-claude — real claude binary, full HTTP stack", () => {
  test("POST /v1/bots/:id/ask reaches the runner; GET /v1/turns/:id returns done + non-empty text", async () => {
    const secret = "e2e-ask-claude-secret-abcdef1234";
    const token = mkToken("e2e", secret, { scopes: ["ask"] });
    h = await startE2E({ botConfig: claudeBot(), tokens: [token] });

    const r = await fetch(`${h.base}/v1/bots/alpha/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      // Keep token count tiny — claude is chatty by default, but a
      // direct imperative constrains it.
      body: JSON.stringify({
        text: "Reply with EXACTLY the single word: pong. No other text, no punctuation.",
        timeout_ms: 60_000,
      }),
    });
    if (r.status !== 200 && r.status !== 202) {
      throw new Error(`ask returned ${r.status}: ${await r.text()}`);
    }
    const body = (await r.json()) as {
      turn_id: number;
      text?: string;
      status?: string;
    };
    expect(typeof body.turn_id).toBe("number");

    // Ask-handler body shape:
    //   200 done      → {text, turn_id, session_id, usage, duration_ms}
    //   202 in-flight → {turn_id, session_id, status: "in_progress"}
    // See src/agent-api/handlers/ask.ts.
    let finalText: string;
    if (r.status === 200) {
      finalText = body.text ?? "";
    } else {
      const done = await pollTurn(h.base, secret, body.turn_id, 90_000);
      expect(done.status).toBe("done");
      finalText = (done.text as string | undefined) ?? "";
    }
    expect(finalText.length).toBeGreaterThan(0);
    // Model-output fidelity: we don't assert exact match (prompts are
    // guidance, not contracts) but the word "pong" should appear
    // case-insensitively. If this fails, either the model no longer
    // follows simple instructions or we're parsing the output wrong.
    expect(finalText.toLowerCase()).toContain("pong");
  }, 180_000);

  test("session continuity: second ask on the same session_id remembers context", async () => {
    const secret = "e2e-ask-claude-sess-abcdef1234";
    const token = mkToken("e2e-sess", secret, { scopes: ["ask"] });
    h = await startE2E({ botConfig: claudeBot(), tokens: [token] });

    const sessionId = "e2e-continuity-1";

    const r1 = await fetch(`${h.base}/v1/bots/alpha/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text:
          "Remember the number 4217. Acknowledge with just the word: ok.",
        session_id: sessionId,
        timeout_ms: 60_000,
      }),
    });
    if (r1.status !== 200 && r1.status !== 202) {
      throw new Error(`first ask returned ${r1.status}: ${await r1.text()}`);
    }
    const b1 = (await r1.json()) as { turn_id: number };
    if (r1.status === 202) {
      await pollTurn(h.base, secret, b1.turn_id, 90_000);
    }

    const r2 = await fetch(`${h.base}/v1/bots/alpha/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "What number did I ask you to remember? Reply with ONLY the number.",
        session_id: sessionId,
        timeout_ms: 60_000,
      }),
    });
    if (r2.status !== 200 && r2.status !== 202) {
      throw new Error(`second ask returned ${r2.status}: ${await r2.text()}`);
    }
    const b2 = (await r2.json()) as { turn_id: number; text?: string };
    let answer: string;
    if (r2.status === 200) {
      answer = b2.text ?? "";
    } else {
      const done = await pollTurn(h.base, secret, b2.turn_id, 90_000);
      answer = (done.text as string | undefined) ?? "";
    }
    expect(answer).toContain("4217");
  }, 300_000);
});
