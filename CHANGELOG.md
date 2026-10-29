# Changelog

## 0.1.0 — 2026-10-29

- RPM and TPM token buckets, usage reconciliation, concurrency cap and queue limit.
- Retries with exponential backoff and jitter honoring Retry-After and OpenAI/Anthropic reset headers.
- `observe()` for rate-limit headers, `wrap()`, `AbortSignal` support, `estimateTokens` and stats.
