<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="tokenpacer" width="420">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/yagodejesus/tokenpacer/actions/workflows/ci.yml"><img src="https://github.com/yagodejesus/tokenpacer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/tokenpacer"><img src="https://img.shields.io/npm/v/tokenpacer.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
</p>

**Stay under your LLM rate limits.** Paces calls by requests-per-minute *and* tokens-per-minute, caps concurrency, and retries 429s and overloads with backoff that honors `Retry-After` — for OpenAI, Anthropic or any API.

> 🇧🇷 *Mantém as chamadas a LLMs dentro dos limites de requisições e de tokens por minuto, limita a concorrência e refaz erros 429 e de sobrecarga respeitando o `Retry-After`.*

Batch jobs, evals and agents fail the same way: a burst of parallel calls, a wall of `429 Too Many Requests`, retries that hammer the API again at the same moment. Request-count limiters miss the real constraint — **tokens per minute**. `tokenpacer` paces both.

```ts
import OpenAI from "openai";
import { Limiter, estimateTokens } from "tokenpacer";

const client = new OpenAI();
const limiter = new Limiter({ requestsPerMinute: 500, tokensPerMinute: 200_000, maxConcurrent: 16 });

const ask = limiter.wrap(
  (req: OpenAI.ChatCompletionCreateParamsNonStreaming) => client.chat.completions.create(req),
  estimateTokens,                                  // prompt + max_tokens, as providers count it
);

const answers = await Promise.all(prompts.map((p) => ask({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: p }],
  max_tokens: 300,
})));
```

Fire off 10,000 calls with `Promise.all` — they're released at the pace your limits allow, never more than 16 at a time.

## What it does

- **Two token buckets** (RPM and TPM) that refill continuously, with bursts up to one minute's worth.
- **Reconciles real usage**: when the response reports `usage` (OpenAI `total_tokens`, Anthropic `input_tokens + output_tokens`), the difference from your estimate is charged to the bucket.
- **Concurrency cap** and an optional **queue limit** (`maxQueue`, rejects with `QueueFullError`).
- **Retries** 408, 409, 429, 500, 502, 503, 504, 529 (Anthropic "overloaded") and network errors (`ECONNRESET`, `fetch failed`…), up to `maxRetries`, with exponential backoff and jitter.
- **Honors the server**: `retry-after-ms`, `retry-after` (seconds or HTTP date), OpenAI `x-ratelimit-reset-*` (`"6m0s"`) and Anthropic `anthropic-ratelimit-*-reset`.
- **Learns from headers**: remaining-requests/tokens headers on errors lower the buckets automatically; call `limiter.observe(headers)` with successful responses' headers too.
- **Cancellation** with `AbortSignal`, and `stats` (`started`, `completed`, `failed`, `retries`, `waitedMs`).

## API

```ts
const limiter = new Limiter({
  requestsPerMinute: 500,
  tokensPerMinute: 200_000,
  maxConcurrent: 16,
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  onRetry: ({ attempt, delayMs, error }) => console.warn(`retry #${attempt} in ${delayMs} ms`, error),
});

await limiter.run(() => anthropic.messages.create(req), { tokens: estimateTokens(req), signal });
limiter.wrap(fn, tokensOf);                 // a rate-limited version of fn
limiter.observe(response.headers);          // feed rate-limit headers
limiter.pending; limiter.active; limiter.stats;
```

Helpers: `estimateTokens(requestOrText)`, `usedTokens(response)`, `parseDuration("6m0s")`, `retryAfterMs(headers, now)`, and `isRetryable(error)` if you want to build your own policy (or pass `retryOn`).

## Install

```bash
npm install tokenpacer
```

ESM, Node ≥ 20 (also Bun and Deno). No dependencies; works with any SDK because you pass the function.

## Development

```bash
git clone https://github.com/yagodejesus/tokenpacer && cd tokenpacer
npm install
npm test
```

Tests run on a fake clock, so pacing over minutes is verified in milliseconds.

## License

MIT © Yago de Jesus Martins
