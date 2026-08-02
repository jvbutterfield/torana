import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { finalizeEvent, verifyEvent, type Event } from "nostr-tools";
import { decodeSecret } from "./protocol";

const SECRET_HEX = "03".padStart(64, "0");
const SECRET = decodeSecret(SECRET_HEX);
const CHANNEL_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("consumes and reproduces a stream event produced by the pinned Rust buzz CLI", async () => {
  let capturedEvent: Event | undefined;
  let capturedNip98: Event | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/events"
      ) {
        return Response.json({ error: "unexpected route" }, { status: 404 });
      }
      const body = await request.text();
      capturedEvent = JSON.parse(body) as Event;
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith("Nostr "))
        return Response.json({ error: "missing NIP-98" }, { status: 401 });
      capturedNip98 = JSON.parse(
        Buffer.from(authorization.slice(6), "base64").toString("utf8"),
      ) as Event;
      const payload = createHash("sha256").update(body).digest("hex");
      const authIsBound =
        verifyEvent(capturedNip98) &&
        capturedNip98.kind === 27235 &&
        capturedNip98.tags.some(
          (tag) => tag[0] === "u" && tag[1] === request.url,
        ) &&
        capturedNip98.tags.some(
          (tag) => tag[0] === "method" && tag[1] === "POST",
        ) &&
        capturedNip98.tags.some(
          (tag) => tag[0] === "payload" && tag[1] === payload,
        );
      if (!authIsBound || !verifyEvent(capturedEvent))
        return Response.json(
          { error: "invalid signed request" },
          { status: 401 },
        );
      return Response.json({ accepted: true, event_id: capturedEvent.id });
    },
  });
  servers.push(server);

  const buzz = Bun.which("buzz");
  if (!buzz) throw new Error("buzz CLI was not found on PATH");
  const proc = Bun.spawn(
    [
      buzz,
      "messages",
      "send",
      "--channel",
      CHANNEL_ID,
      "--content",
      "phase0-golden",
    ],
    {
      env: {
        ...process.env,
        BUZZ_PRIVATE_KEY: SECRET_HEX,
        BUZZ_RELAY_URL: `http://127.0.0.1:${server.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited, stderr).toBe(0);
  expect(stdout).toContain("accepted");
  expect(capturedEvent).toBeDefined();
  expect(capturedNip98).toBeDefined();

  const event = capturedEvent!;
  expect(event.kind).toBe(9);
  expect(event.content).toBe("phase0-golden");
  expect(event.tags).toEqual([["h", CHANNEL_ID]]);
  expect(verifyEvent(event)).toBe(true);

  // The Schnorr signature may use different auxiliary randomness, but NIP-01
  // event IDs are a deterministic hash of the unsigned event fields.
  const reproduced = finalizeEvent(
    {
      kind: event.kind,
      created_at: event.created_at,
      content: event.content,
      tags: event.tags,
    },
    SECRET,
  );
  expect(reproduced.id).toBe(event.id);
  expect(reproduced.pubkey).toBe(event.pubkey);
});
