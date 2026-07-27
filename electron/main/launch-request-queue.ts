export type ApplicationLaunchRequest =
  | { kind: "workspace" }
  | { kind: "service-settings" }
  | { kind: "document"; documentPath: string };

export function applicationLaunchRequestFromArgs(
  argv: string[],
): ApplicationLaunchRequest {
  if (argv.includes("--service-settings")) {
    return { kind: "service-settings" };
  }
  const documentPath =
    argv.find((argument) => argument.toLowerCase().endsWith(".shipflow")) ?? null;
  return documentPath
    ? { kind: "document", documentPath }
    : { kind: "workspace" };
}

function requestKey(request: ApplicationLaunchRequest) {
  return request.kind === "document"
    ? `${request.kind}:${request.documentPath}`
    : request.kind;
}

export class ApplicationLaunchQueue {
  #ready = false;
  #pending: ApplicationLaunchRequest[] = [];
  #dispatchTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dispatch: (
      request: ApplicationLaunchRequest,
    ) => Promise<void> | void,
  ) {}

  enqueue(request: ApplicationLaunchRequest) {
    if (this.#ready) {
      this.#scheduleDispatch(request);
      return;
    }
    const key = requestKey(request);
    if (!this.#pending.some((pending) => requestKey(pending) === key)) {
      this.#pending.push(request);
    }
  }

  markReady() {
    if (this.#ready) {
      return;
    }
    this.#ready = true;
    const pending = this.#pending;
    this.#pending = [];
    for (const request of pending) {
      this.#scheduleDispatch(request);
    }
  }

  whenIdle() {
    return this.#dispatchTail;
  }

  #scheduleDispatch(request: ApplicationLaunchRequest) {
    this.#dispatchTail = this.#dispatchTail
      .catch(() => undefined)
      .then(() => this.dispatch(request));
  }
}
