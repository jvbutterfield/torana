import { test, expect, describe } from "bun:test";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  // Save and restore env around each test
  const saved: Record<string, string | undefined> = {};

  function setEnv(overrides: Record<string, string>) {
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  function restoreEnv() {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const requiredVars: Record<string, string> = {
    TELEGRAM_WEBHOOK_BASE_URL: "https://example.com",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_USER_ID: "123",
    TELEGRAM_BOT_TOKEN_CATO: "cato-token",
    TELEGRAM_BOT_TOKEN_HARPER: "harper-token",
    TELEGRAM_BOT_TOKEN_TRADER: "trader-token",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    GITHUB_TOKEN: "gh-token",
  };

  test("loads config with all required vars set", () => {
    setEnv(requiredVars);
    try {
      const config = loadConfig();
      expect(config.webhookBaseUrl).toBe("https://example.com");
      expect(config.webhookSecret).toBe("secret");
      expect(config.allowedUserId).toBe("123");
      expect(config.botTokens.cato).toBe("cato-token");
      expect(config.botTokens.harper).toBe("harper-token");
      expect(config.botTokens.trader).toBe("trader-token");
      expect(config.oauthToken).toBe("oauth-token");
      expect(config.githubToken).toBe("gh-token");
    } finally {
      restoreEnv();
    }
  });

  test("uses defaults for optional vars", () => {
    setEnv(requiredVars);
    try {
      const config = loadConfig();
      expect(config.port).toBe(3000);
      expect(config.logLevel).toBe("info");
      expect(config.workerStartupTimeoutMs).toBe(60_000);
      expect(config.workerStallTimeoutMs).toBe(90_000);
      expect(config.workerTurnTimeoutMs).toBe(1_200_000);
    } finally {
      restoreEnv();
    }
  });

  for (const varName of Object.keys(requiredVars)) {
    test(`throws on missing ${varName}`, () => {
      const partial = { ...requiredVars };
      delete (partial as any)[varName];
      setEnv(partial);
      // Explicitly unset the target var
      delete process.env[varName];
      try {
        expect(() => loadConfig()).toThrow(varName);
      } finally {
        restoreEnv();
      }
    });
  }
});
