import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { finalizeEvent, type Event } from "nostr-tools";

import {
  BuzzCredentialBroker,
  type BuzzBrokerRequest,
} from "../../src/broker/buzz-broker.js";
import { knownBuzzCommands } from "../../src/broker/buzz-policy.js";
import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { decodeSecret, publicKey } from "../../src/platform/buzz/protocol.js";
import { runBuzz } from "../../src/cli/buzz.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const KEY_A = "51".padStart(64, "0");
const KEY_B = "52".padStart(64, "0");
const PUBKEY_A = publicKey(decodeSecret(KEY_A));
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(
  args: {
    policy?: "read_only" | "collaborate" | "maintainer" | "custom";
    allowedCommands?: string[];
    acknowledgeDangerous?: boolean;
    exposePrivateKey?: boolean;
    spawnCli?: ConstructorParameters<
      typeof BuzzCredentialBroker
    >[0]["spawnCli"];
    resolveEvent?: ConstructorParameters<
      typeof BuzzCredentialBroker
    >[0]["resolveEvent"];
    allowedOptions?: ConstructorParameters<
      typeof BuzzCredentialBroker
    >[0]["allowedOptions"];
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-broker-"));
  dirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([
      makeTestBotConfig("alpha", {
        runner: {
          ...makeTestBotConfig("alpha").runner,
          cwd: dir,
        },
      }),
    ]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz.enabled = true;
  upgraded.agents[0].endpoints.push(
    buzzEndpoint("alpha-buzz", KEY_A),
    buzzEndpoint("alpha-second", KEY_B),
  );
  upgraded.agents[0].tools = {
    buzz: {
      policy: args.policy ?? "collaborate",
      allowed_commands: args.allowedCommands ?? [],
      default_endpoint_id: "alpha-second",
      allowed_endpoint_ids: ["alpha-buzz", "alpha-second"],
      expose_private_key_to_runner: args.exposePrivateKey ?? false,
      acknowledge_dangerous: args.acknowledgeDangerous ?? false,
    },
  };
  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  const broker = new BuzzCredentialBroker({
    config: loaded.config,
    normalized: loaded.normalized,
    spawnCli: args.spawnCli,
    resolveEvent: args.resolveEvent,
    discoverMembership: async () => new Set([CHANNEL]),
    allowedOptions:
      args.allowedOptions ??
      (async () =>
        new Set(["channel", "content", "event", "file", "private-key"])),
  });
  return { ...loaded, broker, dir };
}

function buzzEndpoint(id: string, privateKey: string) {
  return {
    id,
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: `wss://${id}.example`,
    private_key: privateKey,
    respond_to: "anyone",
    subscribe: "all_channels",
    reactions: {},
    triggers: {},
    channel_overrides: {},
  };
}

function conversation(endpointId = "alpha-buzz") {
  return {
    platform: "buzz" as const,
    communityId: "primary",
    endpointId,
    channelId: CHANNEL,
    threadRootId: null,
    workflowRunId: null,
    type: "stream" as const,
  };
}

function issue(broker: BuzzCredentialBroker, endpointId = "alpha-buzz") {
  const file = broker.issueCapability({
    agentId: "alpha",
    sessionId: "session-a",
    conversation: conversation(endpointId),
  });
  if (!file) throw new Error("test capability was not issued");
  return file;
}

describe("Buzz credential broker", () => {
  test("binds ingress/default endpoints and never exposes a raw key normally", async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string> }> = [];
    const { broker } = setup({
      spawnCli: async (args) => {
        calls.push({ argv: args.argv, env: args.env });
        return { exitCode: 0, stdout: "[]\n", stderr: "" };
      },
    });
    expect(broker.runnerEnvironment("alpha")).toEqual({
      TORANA_BUZZ_CAPABILITY_DIR: broker.capabilityDir,
    });
    const capability = issue(broker);
    const result = await broker.execute(capability.token, {
      group: "channels",
      command: "list",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.argv.slice(1)).toEqual(["channels", "list"]);
    expect(calls[0]?.env.BUZZ_RELAY_URL).toBe("wss://alpha-buzz.example");
    expect(calls[0]?.env.BUZZ_PRIVATE_KEY).toBe(KEY_A);
    expect(JSON.stringify(capability)).not.toContain(KEY_A);

    const defaultCapability = broker.issueCapability({
      agentId: "alpha",
      sessionId: "session-default",
      conversation: {
        ...conversation("alpha-agent-api"),
        platform: "agent_api",
        communityId: null,
        endpointId: "alpha-agent-api",
        channelId: "api-session",
        type: "api",
      },
    });
    if (!defaultCapability)
      throw new Error("default capability was not issued");
    expect(
      (
        await broker.execute(defaultCapability.token, {
          group: "channels",
          command: "list",
        })
      ).ok,
    ).toBe(true);
    expect(calls[1]?.env.BUZZ_RELAY_URL).toBe("wss://alpha-second.example");

    broker.revokeCapability("session-a");
    const expired = await broker.execute(capability.token, {
      group: "channels",
      command: "list",
    });
    expect(expired.error).toContain("missing or expired");
  });

  test("denies unknown, forbidden, out-of-policy, and inaccessible requests before spawn", async () => {
    let spawns = 0;
    const { broker } = setup({
      policy: "read_only",
      spawnCli: async () => {
        spawns += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const capability = issue(broker);
    expect(
      (
        await broker.execute(capability.token, {
          group: "messages",
          command: "send",
          options: { channel: CHANNEL, content: "no" },
        })
      ).error,
    ).toContain("denied by policy");
    expect(
      (
        await broker.execute(capability.token, {
          group: "channels",
          command: "list",
          options: { "private-key": KEY_B },
        })
      ).error,
    ).toContain("forbidden");
    expect(
      (
        await broker.execute(capability.token, {
          group: "channels",
          command: "future",
        })
      ).error,
    ).toContain("unknown Buzz command");
    expect(
      (
        await broker.execute(capability.token, {
          group: "channels",
          command: "list",
          options: { invented: "value" },
        })
      ).error,
    ).toContain("not valid");
    expect(
      (
        await broker.execute(capability.token, {
          group: "channels",
          command: "list",
          relayUrl: "wss://override.example",
        } as BuzzBrokerRequest)
      ).error,
    ).toContain("unknown Buzz broker request field");
    expect(spawns).toBe(0);
  });

  test("enforces membership and endpoint-owned edit/delete targets", async () => {
    const foreign = finalizeEvent(
      {
        kind: 9,
        created_at: 1,
        content: "foreign",
        tags: [["h", CHANNEL]],
      },
      decodeSecret(KEY_B),
    );
    const own = finalizeEvent(
      {
        kind: 9,
        created_at: 1,
        content: "own",
        tags: [["h", CHANNEL]],
      },
      decodeSecret(KEY_A),
    );
    const events = new Map<string, Event>([
      [foreign.id, foreign],
      [own.id, own],
    ]);
    let spawns = 0;
    const { broker } = setup({
      resolveEvent: async (_endpoint, id) => events.get(id) ?? null,
      allowedOptions: async () =>
        new Set(["channel", "content", "event", "reply-to"]),
      spawnCli: async () => {
        spawns += 1;
        return { exitCode: 0, stdout: "{}\n", stderr: "" };
      },
    });
    const capability = issue(broker);
    expect(
      (
        await broker.execute(capability.token, {
          group: "messages",
          command: "send",
          options: {
            channel: "99999999-2222-4333-8444-555555555555",
            content: "no",
          },
        })
      ).error,
    ).toContain("not accessible");
    expect(
      (
        await broker.execute(capability.token, {
          group: "messages",
          command: "edit",
          options: { event: foreign.id, content: "no" },
        })
      ).error,
    ).toContain("endpoint-owned");
    expect(
      (
        await broker.execute(capability.token, {
          group: "messages",
          command: "edit",
          options: { event: own.id, content: "yes" },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await broker.execute(capability.token, {
          group: "messages",
          command: "send",
          options: {
            channel: CHANNEL,
            content: "reply",
            "reply-to": foreign.id,
          },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await broker.execute(capability.token, {
          group: "messages",
          command: "send",
          options: {
            channel: CHANNEL,
            content: "bad reply",
            "reply-to": "not-an-event",
          },
        })
      ).error,
    ).toContain("lowercase event id");
    expect(spawns).toBe(2);
  });

  test("copies bounded workspace files and blocks path escape", async () => {
    let stagedPath = "";
    const { broker, dir } = setup({
      spawnCli: async (args) => {
        stagedPath = args.argv.at(-1) ?? "";
        expect(readFileSync(stagedPath, "utf8")).toBe("hello");
        return { exitCode: 0, stdout: "{}\n", stderr: "" };
      },
    });
    const allowed = join(dir, "upload.txt");
    writeFileSync(allowed, "hello");
    const outside = join(tmpdir(), `torana-outside-${Date.now()}.txt`);
    writeFileSync(outside, "outside");
    try {
      const capability = issue(broker);
      const result = await broker.execute(capability.token, {
        group: "upload",
        command: "file",
        options: { file: allowed },
      });
      expect(result.ok).toBe(true);
      expect(stagedPath).not.toBe(allowed);
      expect(statSync(stagedPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(
        (
          await broker.execute(capability.token, {
            group: "upload",
            command: "file",
            options: { file: outside },
          })
        ).error,
      ).toContain("outside the runner workspace");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("stages documented file inputs and preserves stdin sentinels", async () => {
    const seen: string[][] = [];
    const { broker, dir } = setup({
      allowedOptions: async () => new Set(["body-file"]),
      spawnCli: async (args) => {
        seen.push(args.argv);
        return { exitCode: 0, stdout: "{}\n", stderr: "" };
      },
    });
    const body = join(dir, "body.md");
    writeFileSync(body, "review me");
    const capability = issue(broker);
    expect(
      (
        await broker.execute(capability.token, {
          group: "pr",
          command: "open",
          options: { "body-file": body },
        })
      ).ok,
    ).toBe(true);
    const staged = seen[0]?.at(-1) ?? "";
    expect(staged).not.toBe(body);
    expect(statSync(staged, { throwIfNoEntry: false })).toBeUndefined();
    expect(
      (
        await broker.execute(capability.token, {
          group: "pr",
          command: "open",
          options: { "body-file": "-" },
          stdin: "from stdin",
        })
      ).ok,
    ).toBe(true);
    expect(seen[1]?.at(-1)).toBe("-");
  });

  test("stages pack directories and forces download/export output to stdout", async () => {
    let stagedPack = "";
    const { broker, dir } = setup({
      allowedOptions: async () => new Set(["output", "file"]),
      spawnCli: async (args) => {
        stagedPack = args.argv.at(-1) ?? "";
        expect(readFileSync(join(stagedPack, "pack.json"), "utf8")).toBe("{}");
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    });
    const pack = join(dir, "persona");
    mkdirSync(pack);
    writeFileSync(join(pack, "pack.json"), "{}");
    const capability = issue(broker);
    expect(
      (
        await broker.execute(capability.token, {
          group: "pack",
          command: "validate",
          positionals: [pack],
        })
      ).ok,
    ).toBe(true);
    expect(stagedPack).not.toBe(pack);
    expect(statSync(stagedPack, { throwIfNoEntry: false })).toBeUndefined();
    expect(
      (
        await broker.execute(capability.token, {
          group: "media",
          command: "get",
          positionals: ["a".repeat(64)],
          options: { output: join(dir, "download.bin") },
        })
      ).error,
    ).toContain("use stdout");
    expect(
      (
        await broker.execute(capability.token, {
          group: "emoji",
          command: "export",
          options: { file: join(dir, "emoji.json") },
        })
      ).error,
    ).toContain("use stdout");
  });

  test("covers a representative command from every pinned CLI group", async () => {
    const commands = knownBuzzCommands();
    const representatives = [
      ...new Map(commands.map((path) => [path.split(".")[0], path])).values(),
    ];
    let spawns = 0;
    const { broker } = setup({
      policy: "custom",
      allowedCommands: commands,
      acknowledgeDangerous: true,
      spawnCli: async () => {
        spawns += 1;
        return { exitCode: 0, stdout: "[]\n", stderr: "" };
      },
    });
    const capability = issue(broker);
    for (const path of representatives) {
      const [group, command, nestedCommand] = path.split(".");
      const result = await broker.execute(capability.token, {
        group: group!,
        command: command!,
        ...(nestedCommand ? { nestedCommand } : {}),
      });
      expect(result.ok, path).toBe(true);
    }
    expect(spawns).toBe(representatives.length);
    expect(new Set(representatives.map((path) => path.split(".")[0]))).toEqual(
      new Set([
        "agents",
        "canvas",
        "channels",
        "dms",
        "emoji",
        "feed",
        "issues",
        "media",
        "mem",
        "messages",
        "moderation",
        "notes",
        "pack",
        "patches",
        "pr",
        "reactions",
        "repos",
        "social",
        "upload",
        "users",
        "workflows",
      ]),
    );
  });

  test("serves the typed RPC over a private Unix socket to torana buzz call", async () => {
    if (process.platform === "win32") return;
    const { broker } = setup({
      spawnCli: async () => ({ exitCode: 0, stdout: "[1]\n", stderr: "" }),
    });
    broker.start();
    try {
      issue(broker);
      const rendered = await runBuzz(["call"], {
        env: {
          TORANA_SESSION_ID: "session-a",
          TORANA_BUZZ_CAPABILITY_DIR: broker.capabilityDir,
        },
        input: JSON.stringify({ group: "channels", command: "list" }),
      });
      expect(rendered.exitCode).toBe(0);
      expect(rendered.stdout).toEqual(["[1]"]);
      expect(statSync(broker.socketPath).mode & 0o777).toBe(0o600);
    } finally {
      await broker.stop();
    }
  });

  test("preserves CLI exit codes and raw mem.get stdout", async () => {
    const { broker } = setup();
    issue(broker);
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const rendered = await runBuzz(["call"], {
      env: {
        TORANA_SESSION_ID: "session-a",
        TORANA_BUZZ_CAPABILITY_DIR: broker.capabilityDir,
      },
      input: JSON.stringify({
        group: "mem",
        command: "get",
        positionals: ["binary-key"],
      }),
      rpc: async () => ({
        ok: false,
        exitCode: 5,
        stdout: "replacement text must not leak\n",
        stdoutBase64: bytes.toString("base64"),
        stderr: "relay unavailable\n",
      }),
    });
    expect(rendered.exitCode).toBe(5);
    expect(rendered.stdout).toEqual([]);
    expect(Buffer.from(rendered.rawStdout!)).toEqual(bytes);
    expect(rendered.stderr).toEqual(["relay unavailable"]);
  });
});
