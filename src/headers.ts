/** Reading rate-limit and retry headers from OpenAI, Anthropic and generic HTTP errors. */

export type HeaderLike = Headers | Record<string, string | string[] | undefined> | Map<string, string> | undefined | null;

export function header(h: HeaderLike, name: string): string | undefined {
  if (!h) return undefined;
  if (typeof (h as Headers).get === "function") {
    const v = (h as Headers | Map<string, string>).get(name) ?? (h as Map<string, string>).get?.(name.toLowerCase());
    return v ?? undefined;
  }
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** "6m0s", "1.5s", "20ms", "2h" → milliseconds. */
export function parseDuration(text: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? total : undefined;
}

/** Milliseconds the server asked us to wait, if any. */
export function retryAfterMs(h: HeaderLike, now: number): number | undefined {
  const ms = header(h, "retry-after-ms");
  if (ms && !Number.isNaN(Number(ms))) return Number(ms);
  const ra = header(h, "retry-after");
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Number(ra) * 1000;
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  for (const name of ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"]) {
    const v = header(h, name);
    const d = v ? parseDuration(v) : undefined;
    if (d !== undefined) return d;
  }
  for (const name of ["anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-requests-reset"]) {
    const v = header(h, name);
    if (v && !Number.isNaN(Date.parse(v))) return Math.max(0, Date.parse(v) - now);
  }
  return undefined;
}

export interface Remaining {
  requests?: number;
  tokens?: number;
}

export function remaining(h: HeaderLike): Remaining {
  const num = (...names: string[]) => {
    for (const n of names) {
      const v = header(h, n);
      if (v !== undefined && v !== "" && !Number.isNaN(Number(v))) return Number(v);
    }
    return undefined;
  };
  return {
    requests: num("x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"),
    tokens: num("x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-input-tokens-remaining"),
  };
}

/** Finds headers on errors thrown by the OpenAI/Anthropic SDKs, fetch, axios or got. */
export function headersOf(err: unknown): HeaderLike {
  const e = err as { headers?: HeaderLike; response?: { headers?: HeaderLike } } | undefined;
  return e?.headers ?? e?.response?.headers;
}

export function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } } | undefined;
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}
