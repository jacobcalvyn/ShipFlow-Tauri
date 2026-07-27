const DEFAULT_RECOVERY_WINDOW_MS = 60_000;
const DEFAULT_MAX_RECOVERIES = 3;

export function isRecoverableRendererExit(reason: string) {
  return reason !== "clean-exit";
}

export class RendererRecoveryPolicy {
  #attempts: number[] = [];

  constructor(
    private readonly maxRecoveries = DEFAULT_MAX_RECOVERIES,
    private readonly recoveryWindowMs = DEFAULT_RECOVERY_WINDOW_MS,
  ) {}

  registerAttempt(now = Date.now()) {
    this.#attempts = this.#attempts.filter(
      (attempt) => now - attempt < this.recoveryWindowMs,
    );
    if (this.#attempts.length >= this.maxRecoveries) {
      return false;
    }
    this.#attempts.push(now);
    return true;
  }
}
