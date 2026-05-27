import { listen, type Event } from "@tauri-apps/api/event";

function isTauriEventBridgeReady() {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

export function listenToTauriEvent<T>(
  eventName: string,
  handler: (event: Event<T>) => void
) {
  if (!isTauriEventBridgeReady()) {
    return Promise.resolve(() => undefined);
  }

  try {
    return listen<T>(eventName, handler).catch(() => () => undefined);
  } catch {
    return Promise.resolve(() => undefined);
  }
}
