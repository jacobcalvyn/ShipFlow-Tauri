export const SERVICE_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const SERVICE_CRASH_WINDOW_MS = 2 * 60_000;

export type ServiceRestartDecision = {
  attempt: number;
  delayMs: number;
};

export class ServiceRestartPolicy {
  readonly #crashTimestamps: number[] = [];

  registerCrash(now = Date.now()): ServiceRestartDecision | null {
    const cutoff = now - SERVICE_CRASH_WINDOW_MS;
    while (this.#crashTimestamps[0] !== undefined && this.#crashTimestamps[0] < cutoff) {
      this.#crashTimestamps.shift();
    }
    this.#crashTimestamps.push(now);
    if (this.#crashTimestamps.length > SERVICE_RESTART_DELAYS_MS.length) {
      return null;
    }

    const attempt = this.#crashTimestamps.length;
    return {
      attempt,
      delayMs: SERVICE_RESTART_DELAYS_MS[attempt - 1],
    };
  }

  reset() {
    this.#crashTimestamps.length = 0;
  }
}
