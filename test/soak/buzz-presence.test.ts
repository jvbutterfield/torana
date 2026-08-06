// US-022 presence soak, gated by BUZZ_PRESENCE_SOAK=1.
//
// The Phase 2 gate: a Torana endpoint must refresh presence continuously,
// under injected publish latency jitter, for long enough to prove the cadence
// is not drifting toward the relay's 180 s TTL. The default run is 10 minutes
// of wall clock.
//
//   BUZZ_PRESENCE_SOAK=1 bun test test/soak/buzz-presence.test.ts --timeout 900000
//
// Knobs (all optional):
//   BUZZ_PRESENCE_SOAK_DURATION_MS   default 600000 (10 min)
//   BUZZ_PRESENCE_SOAK_HEARTBEAT_SECS default 5
//   BUZZ_PRESENCE_SOAK_MAX_GAP_MS    default 60000
//   BUZZ_PRESENCE_SOAK_JITTER_MS     default 1500 (max injected publish delay)

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  finalizeEvent,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";
import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { resetLoggerState } from "../../src/log.js";
import { BuzzTransport } from "../../src/platform/buzz/transport.js";
import {
  BUZZ_KINDS,
  BUZZ_PRESENCE_TTL_SECS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
  verifyOwnerAuthTag,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const SOAK_ENABLED = process.env.BUZZ_PRESENCE_SOAK === "1";
const DURATION_MS = Number(
  process.env.BUZZ_PRESENCE_SOAK_DURATION_MS ?? 600_000,
);
const HEARTBEAT_SECS = Number(
  process.env.BUZZ_PRESENCE_SOAK_HEARTBEAT_SECS ?? 5,
);
const MAX_GAP_MS = Number(process.env.BUZZ_PRESENCE_SOAK_MAX_GAP_MS ?? 60_000);
const JITTER_MS = Number(process.env.BUZZ_PRESENCE_SOAK_JITTER_MS ?? 1500);

const ENDPOINT_KEY = "01".padStart(64, "0");
const ENDPOINT_PUBKEY = publicKey(decodeSecret(ENDPOINT_KEY));
const RELAY_SECRET = decodeSecret("02".padStart(64, "0"));
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const AUTH_TAG = createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, "kind=9");

const tempDirs: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const transports: BuzzTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()));
  for (const relay of servers.splice(0)) relay.stop(true);
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  resetLoggerState();
});

interface SocketData {
  authenticated: boolean;
  subscriptions: Map<string, Filter[]>;
}

/** Fake relay that answers every publish after a random delay. */
function createJitteryRelay(maxDelayMs: number) {
  const challenge = "presence-soak-challenge";
  const presenceAt: number[] = [];
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();

  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { authenticated: false, subscriptions: new Map() },
        })
      ) {
        return undefined;
      }
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.send(JSON.stringify(["AUTH", challenge]));
      },
      close(socket) {
        sockets.delete(socket);
      },
      async message(socket, raw) {
        const frame = JSON.parse(String(raw)) as [string, ...unknown[]];
        if (frame[0] === "AUTH") {
          const auth = frame[1] as Event;
          const ownerTag = auth.tags.find((tag) => tag[0] === "auth");
          const ok =
            verifyEvent(auth) &&
            auth.pubkey === ENDPOINT_PUBKEY &&
            Boolean(
              ownerTag &&
              verifyOwnerAuthTag(ownerTag as typeof AUTH_TAG, auth.pubkey),
            );
          socket.data.authenticated = ok;
          socket.send(JSON.stringify(["OK", auth.id, ok, "authenticated"]));
          return;
        }
        if (!socket.data.authenticated) return;
        if (frame[0] === "EVENT") {
          const event = frame[1] as Event;
          // Jitter is the point: a publish whose OK comes back late shifts the
          // next heartbeat later, which is exactly how the cadence used to
          // drift into the rate-limit window.
          await Bun.sleep(Math.floor(Math.random() * maxDelayMs));
          if (event.kind === BUZZ_KINDS.presence) presenceAt.push(Date.now());
          socket.send(JSON.stringify(["OK", event.id, true, "saved"]));
          return;
        }
        if (frame[0] === "CLOSE") {
          socket.data.subscriptions.delete(String(frame[1]));
          return;
        }
        if (frame[0] !== "REQ") return;
        const id = String(frame[1]);
        socket.data.subscriptions.set(id, frame.slice(2) as Filter[]);
        await Bun.sleep(Math.floor(Math.random() * maxDelayMs));
        socket.send(
          JSON.stringify([
            "EVENT",
            id,
            finalizeEvent(
              {
                kind: BUZZ_KINDS.groupMembers,
                created_at: 1_700_000_000,
                content: "",
                tags: [
                  ["d", CHANNEL],
                  ["p", ENDPOINT_PUBKEY],
                ],
              },
              RELAY_SECRET,
            ),
          ]),
        );
        socket.send(JSON.stringify(["EOSE", id]));
      },
    },
  });
  servers.push(server);
  return {
    url: `ws://127.0.0.1:${server.port}`,
    presenceAt,
  };
}

function makeLoaded(relayUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "torana-presence-soak-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = {
    enabled: true,
    reconnect: { base_ms: 100, cap_ms: 1000 },
    subscription: {
      historical_limit: 100,
      replay_overlap_secs: 5,
      heartbeat_secs: HEARTBEAT_SECS,
    },
    message_max_bytes: 65_536,
  };
  upgraded.limits.relay_ok_wait_ms = 5000;
  // The production default, and the exact combination that used to drop every
  // other refresh at a 30 s heartbeat.
  upgraded.limits.presence_min_interval_ms = 30_000;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: relayUrl,
    private_key: ENDPOINT_KEY,
    auth_tag: JSON.stringify(AUTH_TAG),
    respond_to: "owner_only",
    owner_pubkey: OWNER_PUBKEY,
    allowed_pubkeys: [],
    subscribe: "mentions_and_dms",
    channel_overrides: {},
  });
  return loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true });
}

describe.skipIf(!SOAK_ENABLED)("Buzz presence soak", () => {
  test(
    "presence refreshes stay inside the gap budget under latency jitter",
    async () => {
      const relay = createJitteryRelay(JITTER_MS);
      const loaded = makeLoaded(relay.url);
      applyMigrations(loaded.config.gateway.db_path!);
      const db = new GatewayDB(loaded.config.gateway.db_path!);
      db.syncNormalizedConfig(loaded.normalized);
      const transport = new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 100,
      });
      transports.push(transport);
      await transport.start(async () => {});

      const startedAt = Date.now();
      let worstGapMs = 0;
      let previous = startedAt;
      while (Date.now() - startedAt < DURATION_MS) {
        await Bun.sleep(1000);
        const latest = relay.presenceAt.at(-1) ?? startedAt;
        worstGapMs = Math.max(worstGapMs, latest - previous);
        previous = Math.max(previous, latest);
        // Fail fast rather than at the end of a ten-minute run.
        expect(Date.now() - previous).toBeLessThan(MAX_GAP_MS);
      }

      const snapshot = transport.snapshots()[0]!;
      const gaps: number[] = [];
      for (let i = 1; i < relay.presenceAt.length; i++) {
        gaps.push(relay.presenceAt[i]! - relay.presenceAt[i - 1]!);
      }

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          soak: "buzz-presence",
          duration_ms: Date.now() - startedAt,
          heartbeat_secs: HEARTBEAT_SECS,
          jitter_ms: JITTER_MS,
          presence_publishes: relay.presenceAt.length,
          max_gap_ms: Math.max(...gaps, 0),
          mean_gap_ms: Math.round(
            gaps.reduce((sum, gap) => sum + gap, 0) / Math.max(gaps.length, 1),
          ),
          presence: snapshot.presence,
          state: snapshot.state,
        }),
      );

      expect(snapshot.state).toBe("healthy");
      expect(snapshot.presence.failed).toBe(0);
      expect(snapshot.presence.suppressed).toBe(0);
      expect(snapshot.presence.stale).toBe(false);
      // The heartbeat is not a fixed-rate timer: the supervisor waits
      // `heartbeat_secs` *after* the previous refresh completed, so the
      // observed cadence is the interval plus that round trip (membership
      // query + presence publish, each carrying up to JITTER_MS here). The
      // floor below is derived from that model rather than from the interval
      // alone, and exists only to catch a heartbeat that stopped — the gap
      // assertions are what actually bound liveness.
      const worstCaseCadenceMs = HEARTBEAT_SECS * 1000 + 2 * JITTER_MS + 500;
      expect(relay.presenceAt.length).toBeGreaterThanOrEqual(
        Math.floor(DURATION_MS / worstCaseCadenceMs) - 1,
      );
      expect(Math.max(...gaps, 0)).toBeLessThan(MAX_GAP_MS);
      // The property the relay actually enforces.
      expect(Math.max(...gaps, 0)).toBeLessThan(BUZZ_PRESENCE_TTL_SECS * 1000);
      db.close();
    },
    { timeout: DURATION_MS + 120_000 },
  );
});
