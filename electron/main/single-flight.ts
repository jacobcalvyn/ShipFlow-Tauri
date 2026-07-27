export class SingleFlight<T> {
  #active: Promise<T> | null = null;

  get current() {
    return this.#active;
  }

  run(operation: () => Promise<T>) {
    if (this.#active) {
      return this.#active;
    }
    const active = Promise.resolve().then(operation);
    this.#active = active;
    void active.finally(() => {
      if (this.#active === active) {
        this.#active = null;
      }
    }).catch(() => {
      // The caller observes the original operation rejection.
    });
    return active;
  }
}
