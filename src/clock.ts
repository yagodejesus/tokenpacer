export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const t = setTimeout(resolve, Math.max(0, ms));
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    }),
};
