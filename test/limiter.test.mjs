import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens, Limiter, parseDuration, QueueFullError, retryAfterMs, usedTokens } from "../dist/index.js";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); } };
}

const ok = async () => "ok";

test("requests per minute: bursts up to the limit, then paces", async () => {
  const clock = fakeClock();
  const lim = new Limiter({ requestsPerMinute: 60, clock });
  for (let i = 0; i < 60; i++) await lim.run(ok);
  assert.equal(clock.now(), 0);
  for (let i = 0; i < 30; i++) await lim.run(ok);
  assert.ok(Math.abs(clock.now() - 30_000) <= 30, `time was ${clock.now()}`);
});

test("tokens per minute", async () => {
  const clock = fakeClock();
  const lim = new Limiter({ tokensPerMinute: 1000, clock });
  await lim.run(ok, { tokens: 400 });
  await lim.run(ok, { tokens: 400 });
  assert.equal(clock.now(), 0);
  await lim.run(ok, { tokens: 400 }); // needs 200 more tokens → 12 s
  assert.ok(Math.abs(clock.now() - 12_000) <= 5);
  assert.ok(lim.stats.waitedMs >= 12_000);
});

test("usage reported by the API is reconciled with the estimate", async () => {
  const clock = fakeClock();
  const lim = new Limiter({ tokensPerMinute: 1000, clock });
  await lim.run(async () => ({ usage: { total_tokens: 900 } }), { tokens: 100 });
  await lim.run(ok, { tokens: 200 }); // only 100 left → wait 6 s
  assert.ok(Math.abs(clock.now() - 6_000) <= 5);
  assert.equal(usedTokens({ usage: { input_tokens: 10, output_tokens: 5 } }), 15);
});

test("max concurrency", async () => {
  const lim = new Limiter({ maxConcurrent: 2 });
  let now = 0;
  let peak = 0;
  const job = async () => {
    now++;
    peak = Math.max(peak, now);
    await new Promise((r) => setTimeout(r, 5));
    now--;
  };
  await Promise.all(Array.from({ length: 8 }, () => lim.run(job)));
  assert.equal(peak, 2);
  assert.equal(lim.active, 0);
});

test("retries 429 honoring Retry-After", async () => {
  const clock = fakeClock();
  const seen = [];
  const lim = new Limiter({ clock, onRetry: (i) => seen.push(i.delayMs) });
  let calls = 0;
  const flaky = async () => {
    if (++calls === 1) throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "2" } });
    return "done";
  };
  assert.equal(await lim.run(flaky), "done");
  assert.deepEqual(seen, [2000]);
  assert.equal(clock.now(), 2000);
  assert.equal(lim.stats.retries, 1);
});

test("exponential backoff with jitter for 529/5xx and network errors", async () => {
  const clock = fakeClock();
  const delays = [];
  const lim = new Limiter({ clock, random: () => 1, baseDelayMs: 100, onRetry: (i) => delays.push(i.delayMs), maxRetries: 3 });
  let calls = 0;
  const errs = [{ status: 529 }, { code: "ECONNRESET" }, { status: 503 }];
  const job = async () => {
    if (calls < 3) throw Object.assign(new Error("x"), errs[calls++]);
    return 1;
  };
  assert.equal(await lim.run(job), 1);
  assert.deepEqual(delays, [100, 200, 400]);
});

test("non-retryable errors and exhausted retries are thrown", async () => {
  const lim = new Limiter({ clock: fakeClock(), maxRetries: 2 });
  await assert.rejects(lim.run(async () => { throw Object.assign(new Error("bad request"), { status: 400 }); }), /bad request/);
  let n = 0;
  await assert.rejects(lim.run(async () => { n++; throw Object.assign(new Error("overloaded"), { status: 529 }); }), /overloaded/);
  assert.equal(n, 3);
  assert.equal(lim.stats.failed, 2);
});

test("rate-limit headers lower the buckets", async () => {
  const clock = fakeClock();
  const lim = new Limiter({ tokensPerMinute: 60_000, clock });
  lim.observe({ "x-ratelimit-remaining-tokens": "0" });
  await lim.run(ok, { tokens: 1000 }); // must wait ~1 s for 1 000 tokens at 1 000/s
  assert.ok(clock.now() >= 990);
});

test("header parsing", () => {
  assert.equal(parseDuration("6m0s"), 360_000);
  assert.equal(parseDuration("1.5s"), 1500);
  assert.equal(parseDuration("20ms"), 20);
  assert.equal(retryAfterMs({ "retry-after-ms": "250" }, 0), 250);
  assert.equal(retryAfterMs(new Headers({ "x-ratelimit-reset-tokens": "2s" }), 0), 2000);
  assert.equal(retryAfterMs({ "anthropic-ratelimit-tokens-reset": new Date(5000).toISOString() }, 1000), 4000);
});

test("token estimates", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  const req = { model: "m", messages: [{ role: "user", content: "x".repeat(40) }], max_tokens: 100 };
  assert.equal(estimateTokens(req), 4 + 10 + 100);
});

test("abort and queue limits", async () => {
  const clock = fakeClock();
  const lim = new Limiter({ maxConcurrent: 1, maxQueue: 1, clock });
  let release;
  const blocker = lim.run(() => new Promise((r) => (release = r)));
  const ac = new AbortController();
  const queued = lim.run(ok, { signal: ac.signal });
  await assert.rejects(lim.run(ok), QueueFullError);
  ac.abort(new Error("user cancelled"));
  await assert.rejects(queued, /user cancelled/);
  release("x");
  assert.equal(await blocker, "x");
});

test("wrap", async () => {
  const lim = new Limiter({ requestsPerMinute: 10, clock: fakeClock() });
  const double = lim.wrap(async (n) => n * 2, (n) => n);
  assert.equal(await double(21), 42);
});
