// §12.4: full HTTP `ask` round-trip against the REAL codex binary.
// Mirror of ask-claude.test.ts; the point is to catch schema drift
// between CodexRunner's JSONL parser and the live CLI output, plus
// to confirm the pool + dispatch wiring works with codex's one-shot
// spawn model.

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

function codexBot(): BotConfig {
  return {
    id: "alpha",
    token: "e2e-codex-bot-token:ffffffffffffffffffffffff",
    commands: [],
    reactions: { received_emoji: "👀" },
    runner: {
      type: "codex",
      cli_path: process.env.CODEX_CLI_PATH ?? "codex",
      args: [],
      // Mirror ask-claude — E2E uses the full inherited env so auth
      // via ~/.codex/auth.json, OPENAI_API_KEY, or keychain all work
      // without each being listed here by name.
      env: inheritedEnv(),
      pass_resume_flag: true,
      approval_mode: "full-auto",
      sandbox: "workspace-write",
      acknowledge_dangerous: false,
    },
  };
}

describeOrSkip("§12.4 ask-codex — real codex binary, full HTTP stack", () => {
  test("POST /v1/bots/:id/ask reaches the runner; GET /v1/turns/:id returns done + non-empty text", async () => {
    const secret = "e2e-ask-codex-secret-abcdef1234";
    const token = mkToken("e2e", secret, { scopes: ["ask"] });
    h = await startE2E({ botConfig: codexBot(), tokens: [token] });

    const r = await fetch(`${h.base}/v1/bots/alpha/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text:
          "Reply with EXACTLY the single word: pong. No other text, no punctuation.",
        timeout_ms: 60_000,
      }),
    });
    const bodyText = await r.text();
    if (r.status !== 200 && r.status !== 202) {
      throw new Error(`ask returned ${r.status}: ${bodyText}`);
    }
    const body = JSON.parse(bodyText) as {
      turn_id: number;
      text?: string;
      status?: string;
    };

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
    expect(finalText.toLowerCase()).toContain("pong");
  }, 180_000);

  test("session continuity: second ask on the same session_id remembers context via codex thread_id", async () => {
    const secret = "e2e-ask-codex-sess-abcdef1234";
    const token = mkToken("e2e-sess", secret, { scopes: ["ask"] });
    h = await startE2E({ botConfig: codexBot(), tokens: [token] });

    const sessionId = "e2e-codex-continuity-1";

    const r1 = await fetch(`${h.base}/v1/bots/alpha/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text:
          "Pick the integer 7349 and remember it. Acknowledge with the single word: ok.",
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
        text:
          "What integer did I ask you to remember? Reply with ONLY the integer.",
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
    expect(answer).toContain("7349");
  }, 300_000);
});
