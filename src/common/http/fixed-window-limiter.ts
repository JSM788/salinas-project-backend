interface Window {
  start: number;
  count: number;
}

/**
 * In-memory fixed-window limiter for unauthenticated endpoints.
 * State is per process; the key map is bounded so spoofed keys cannot grow memory.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const current = this.now();
    const existing = this.windows.get(key);
    if (!existing || current - existing.start >= this.windowMs) {
      if (!existing && this.windows.size >= this.maxKeys) this.prune(current);
      if (!existing && this.windows.size >= this.maxKeys) return false;
      this.windows.set(key, { start: current, count: 1 });
      return true;
    }
    if (existing.count >= this.limit) return false;
    existing.count += 1;
    return true;
  }

  private prune(current: number) {
    for (const [key, window] of this.windows)
      if (current - window.start >= this.windowMs) this.windows.delete(key);
  }
}
