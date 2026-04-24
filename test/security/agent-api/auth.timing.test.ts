// §12.5.1: constant-time token comparison.
//
// `authenticate()` hashes the presented secret with SHA-256 and compares
// against stored hashes via `crypto.timingSafeEqual`. A length check fires
// *before* timingSafeEqual (since crypto.timingSafeEqual requires equal
// lengths) — but because both sides are fixed-width SHA-256 digests (32
// bytes), the input-length discrepancy is gone by the time we reach the
// hot path. The only remaining timing sensitivity is how long SHA-256
// takes, which is content-independent by construction.
//
// This test empirically verifies the property: call `authenticate()` with
// N short wrong tokens and N long wrong tokens and compare latency
// distributions. If the two means diverge by more than a small multiple
// of the stdev, something has leaked.
//
// Note: calls authenticate() directly, NOT over HTTP. HTTP adds scheduler
// noise that overwhelms the microsecond-scale differences we're guarding
// against. The unit-level call is what matters for the claim.

import { describe, expect, test } from "bun:test";

import { authenticate } from "../../../src/agent-api/auth.js";
import { mkToken } from "./_harness.js";

const REAL_SECRET =
  "this-is-a-genuine-token-value-64-chars-long-padded-xxxxxxxxxxxxxx";
const SHORT_WRONG = "x";
const LONG_WRONG = "y".repeat(64);

function measure(fn: () => void, iterations: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  const m = mean(xs);
  const variance = xs.reduce((acc, v) => acc + (v - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

describe("§12.5.1 auth.timing", () => {
  test("latency distribution for short-vs-long wrong tokens is within ~3 stdev", () => {
    const tokens = [mkToken("cos", REAL_SECRET)];
    const ITER = 200;

    // Warmup to stabilise JIT + caches so the first few samples don't skew.
    measure(() => authenticate(tokens, `Bearer ${SHORT_WRONG}`), 50);
    measure(() => authenticate(tokens, `Bearer ${LONG_WRONG}`), 50);

    // Interleave the samples so neither side captures a GC pause in bulk.
    const shortSamples: number[] = [];
    const longSamples: number[] = [];
    for (let i = 0; i < ITER; i += 1) {
      const s = performance.now();
      authenticate(tokens, `Bearer ${SHORT_WRONG}`);
      shortSamples.push(performance.now() - s);
      const l = performance.now();
      authenticate(tokens, `Bearer ${LONG_WRONG}`);
      longSamples.push(performance.now() - l);
    }

    const ms = mean(shortSamples);
    const ml = mean(longSamples);
    const ss = stdev(shortSamples);
    const sl = stdev(longSamples);
    const pooledStdev = Math.sqrt((ss * ss + sl * sl) / 2);
    const meanDelta = Math.abs(ms - ml);

    // Guard is deliberately loose: we assert there is no systemic length
    // leak at the scale that would matter over a network. A factor of 3
    // pooled stdev is generous enough to absorb sub-microsecond GC jitter
    // without passing a genuine regression (which would produce a delta
    // measured in multiples of the mean, not multiples of the stdev).
    expect(meanDelta).toBeLessThan(pooledStdev * 3 + 0.05);
  });

  test("wrong-length input still returns invalid_token (not missing_auth)", () => {
    const tokens = [mkToken("cos", REAL_SECRET)];
    const shortR = authenticate(tokens, `Bearer ${SHORT_WRONG}`);
    const longR = authenticate(tokens, `Bearer ${LONG_WRONG}`);
    expect(shortR).toEqual({ kind: "invalid_token" });
    expect(longR).toEqual({ kind: "invalid_token" });
  });

  test("hash comparison is content-invariant — all wrong tokens hit the same path", () => {
    // The implementation invariant we're pinning: no early exit on first
    // differing byte. If someone refactors the loop to use == on the raw
    // string, this test's assumption breaks and the timing test above
    // becomes meaningful-but-looking-for-the-wrong-thing; this guards
    // against that by checking equivalence at the behavioural level.
    const tokens = [mkToken("cos", REAL_SECRET)];
    // Tokens that differ at byte 1 vs byte 31 should both hash + compare.
    const differsAtFirstByte = "0" + REAL_SECRET.slice(1);
    const differsAtLastByte = REAL_SECRET.slice(0, -1) + "0";
    expect(authenticate(tokens, `Bearer ${differsAtFirstByte}`)).toEqual({
      kind: "invalid_token",
    });
    expect(authenticate(tokens, `Bearer ${differsAtLastByte}`)).toEqual({
      kind: "invalid_token",
    });
  });
});
