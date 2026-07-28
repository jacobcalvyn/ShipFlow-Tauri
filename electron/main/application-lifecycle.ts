export type ApplicationQuitReason = "app" | "relaunch" | "update";
export type ApplicationQuitDecision = "cancel" | "discard";

export type QuitAwareWindow = {
  label: string;
  isDirty: boolean;
  allowClose: boolean;
  closeRequestPending: boolean;
};

type PendingQuit<T extends QuitAwareWindow> = {
  reason: ApplicationQuitReason;
  remaining: T[];
  resolved: T[];
  current: T | null;
};

type ApplicationQuitCoordinatorOptions<T extends QuitAwareWindow> = {
  windows: () => Iterable<T>;
  requestDecision: (record: T) => void;
  finalize: (reason: ApplicationQuitReason) => Promise<void> | void;
};

export class ApplicationQuitCoordinator<T extends QuitAwareWindow> {
  #pending: PendingQuit<T> | null = null;
  #finalizing = false;

  constructor(
    private readonly options: ApplicationQuitCoordinatorOptions<T>,
  ) {}

  get isPending() {
    return this.#pending !== null || this.#finalizing;
  }

  request(reason: ApplicationQuitReason) {
    if (this.isPending) {
      return;
    }
    const remaining = [...this.options.windows()].filter(
      (record) => record.isDirty && !record.allowClose,
    );
    if (remaining.length === 0) {
      this.#beginFinalize(reason);
      return;
    }
    this.#pending = {
      reason,
      remaining,
      resolved: [],
      current: null,
    };
    this.#requestNextDecision();
  }

  resolve(record: T, decision: ApplicationQuitDecision) {
    const pending = this.#pending;
    if (!pending || pending.current !== record) {
      return false;
    }
    record.closeRequestPending = false;
    pending.current = null;
    if (decision === "cancel") {
      for (const resolved of pending.resolved) {
        resolved.allowClose = false;
      }
      this.#pending = null;
      return true;
    }
    record.allowClose = true;
    pending.resolved.push(record);
    this.#requestNextDecision();
    return true;
  }

  remove(record: T) {
    const pending = this.#pending;
    if (!pending) {
      return;
    }
    pending.remaining = pending.remaining.filter((candidate) => candidate !== record);
    pending.resolved = pending.resolved.filter((candidate) => candidate !== record);
    if (pending.current === record) {
      record.closeRequestPending = false;
      pending.current = null;
      this.#requestNextDecision();
    }
  }

  #requestNextDecision() {
    const pending = this.#pending;
    if (!pending) {
      return;
    }
    const next = pending.remaining.shift();
    if (!next) {
      const reason = pending.reason;
      this.#pending = null;
      this.#beginFinalize(reason);
      return;
    }
    if (!next.isDirty || next.allowClose) {
      this.#requestNextDecision();
      return;
    }
    pending.current = next;
    next.closeRequestPending = true;
    this.options.requestDecision(next);
  }

  #beginFinalize(reason: ApplicationQuitReason) {
    this.#finalizing = true;
    void Promise.resolve(this.options.finalize(reason))
      .finally(() => {
        this.#finalizing = false;
      })
      .catch(() => {
        // The integration callback owns operational error reporting.
      });
  }
}
