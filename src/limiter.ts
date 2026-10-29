import { TokenBucket } from "./bucket.js";
import { realClock, type Clock } from "./clock.js";
import { usedTokens } from "./estimate.js";
import { headersOf, remaining, retryAfterMs, statusOf, type HeaderLike } from "./headers.js";

export interface LimiterOptions {
  /** Requests per minute (RPM). */
  requestsPerMinute?: number;
  /** Tokens per minute (TPM). */
  tokensPerMinute?: number;
  /** Maximum calls in flight at the same time. Default: unlimited. */
  maxConcurrent?: number;
  /** Retries for 408/429/5xx/529 and network errors. Default 5. */
  maxRetries?: number;
  /** First backoff delay in ms (doubles each attempt). Default 500. */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms. Default 60 000. */
  maxDelayMs?: number;
  /** Maximum requests waiting in the queue; more are rejected immediately. Default unlimited. */
  maxQueue?: number;
  /** Decide which errors are retried (default: 408, 409, 429, 500, 502, 503, 504, 529 and network errors). */
  retryOn?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  clock?: Clock;
  random?: () => number;
}

export interface RunOptions {
  /** Estimated tokens for this call (prompt + max output). */
  tokens?: number;
  signal?: AbortSignal;
}

export class QueueFullError extends Error {
  constructor() {
    super("tokenpacer: queue is full");
    this.name = "QueueFullError";
  }
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const RETRY_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

export function isRetryable(error: unknown): boolean {
  const e = error as { name?: string; code?: string; cause?: { code?: string } } | undefined;
  if (e?.name === "AbortError") return false;
  const status = statusOf(error);
  if (status !== undefined) return RETRY_STATUS.has(status);
  return RETRY_CODES.has(e?.code ?? "") || RETRY_CODES.has(e?.cause?.code ?? "") || /fetch failed|socket hang up/i.test(String((error as Error)?.message));
}

interface Waiter {
  tokens: number;
  resolve: () => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
}

/**
 * Keeps LLM API calls under your requests-per-minute and tokens-per-minute limits, caps concurrency,
 * and retries rate-limit/overload errors with backoff that honors Retry-After.
 */
export class Limiter {
  readonly stats = { started: 0, completed: 0, failed: 0, retries: 0, waitedMs: 0 };
  private readonly requests?: TokenBucket;
  private readonly tokens?: TokenBucket;
  private readonly clock: Clock;
  private readonly queue: Waiter[] = [];
  private inFlight = 0;
  private pumping = false;

  constructor(private readonly opts: LimiterOptions = {}) {
    this.clock = opts.clock ?? realClock;
    if (opts.requestsPerMinute) this.requests = new TokenBucket(opts.requestsPerMinute, 60_000, this.clock);
    if (opts.tokensPerMinute) this.tokens = new TokenBucket(opts.tokensPerMinute, 60_000, this.clock);
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.inFlight;
  }

  /** Runs `fn` when limits allow, retrying retryable failures. */
  async run<T>(fn: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const estimate = Math.max(0, options.tokens ?? 0);
    const maxRetries = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      await this.acquire(estimate, options.signal);
      this.stats.started++;
      try {
        const result = await fn();
        this.release();
        const used = usedTokens(result);
        if (used !== undefined && this.tokens && used > estimate) this.tokens.take(used - estimate);
        this.stats.completed++;
        return result;
      } catch (error) {
        this.release();
        this.observe(headersOf(error));
        const retryable = (this.opts.retryOn ?? isRetryable)(error);
        if (!retryable || attempt >= maxRetries || options.signal?.aborted) {
          this.stats.failed++;
          throw error;
        }
        const delayMs = this.delay(error, attempt);
        this.stats.retries++;
        this.opts.onRetry?.({ attempt: attempt + 1, delayMs, error });
        await this.clock.sleep(delayMs, options.signal);
      }
    }
  }

  /** Wraps a function so every call goes through the limiter. */
  wrap<A extends unknown[], T>(fn: (...args: A) => Promise<T>, tokensOf?: (...args: A) => number): (...args: A) => Promise<T> {
    return (...args: A) => this.run(() => fn(...args), { tokens: tokensOf ? tokensOf(...args) : 0 });
  }

  /** Feed rate-limit headers from a successful response (e.g. `.withResponse()` in the OpenAI SDK). */
  observe(headers: HeaderLike): void {
    const r = remaining(headers);
    if (r.requests !== undefined) this.requests?.clampTo(r.requests);
    if (r.tokens !== undefined) this.tokens?.clampTo(r.tokens);
  }

  private delay(error: unknown, attempt: number): number {
    const hinted = retryAfterMs(headersOf(error), this.clock.now());
    const max = this.opts.maxDelayMs ?? 60_000;
    if (hinted !== undefined) return Math.min(max, hinted);
    const base = Math.min(max, (this.opts.baseDelayMs ?? 500) * 2 ** attempt);
    const r = (this.opts.random ?? Math.random)();
    return Math.round(base / 2 + (base / 2) * r); // "equal jitter"
  }

  private acquire(tokens: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    if (this.opts.maxQueue !== undefined && this.queue.length >= this.opts.maxQueue) return Promise.reject(new QueueFullError());
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { tokens, resolve, reject, cancelled: false };
      signal?.addEventListener(
        "abort",
        () => {
          if (this.queue.includes(w)) {
            w.cancelled = true;
            reject(signal.reason ?? new Error("aborted"));
          }
        },
        { once: true },
      );
      this.queue.push(w);
      void this.pump();
    });
  }

  private release(): void {
    this.inFlight--;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const head = this.queue[0];
        if (head.cancelled) {
          this.queue.shift();
          continue;
        }
        if (this.inFlight >= (this.opts.maxConcurrent ?? Infinity)) break;
        const wait = Math.max(this.requests?.waitTime(1) ?? 0, this.tokens?.waitTime(head.tokens) ?? 0);
        if (wait > 0) {
          this.stats.waitedMs += wait;
          await this.clock.sleep(wait);
          continue;
        }
        this.requests?.take(1);
        this.tokens?.take(head.tokens);
        this.inFlight++;
        this.queue.shift();
        head.resolve();
      }
    } finally {
      this.pumping = false;
    }
  }
}
