import type { Clock } from "./clock.js";

/** A token bucket that refills continuously: `capacity` units per `periodMs`. */
export class TokenBucket {
  private level: number;
  private last: number;
  private readonly rate: number;

  constructor(readonly capacity: number, periodMs: number, private readonly clock: Clock) {
    this.rate = capacity / periodMs;
    this.level = capacity;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    this.level = Math.min(this.capacity, this.level + (now - this.last) * this.rate);
    this.last = now;
  }

  get available(): number {
    this.refill();
    return this.level;
  }

  /** Milliseconds until `n` units are available (requests larger than the bucket wait for a full bucket). */
  waitTime(n: number): number {
    this.refill();
    const need = Math.min(n, this.capacity);
    return this.level >= need ? 0 : Math.ceil((need - this.level) / this.rate);
  }

  take(n: number): void {
    this.refill();
    this.level -= n;
  }

  /** Lower the level to what the server says is left (never raises it). */
  clampTo(remaining: number): void {
    this.refill();
    this.level = Math.min(this.level, remaining);
  }
}
