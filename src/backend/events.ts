import { getShipFlowBridge } from "./bridge";
import type { ShipFlowRuntimeEvent } from "./bridge-contract";

export function listenToShipFlowEvent<T>(
  eventName: string,
  handler: (event: ShipFlowRuntimeEvent<T>) => void
) {
  try {
    return Promise.resolve(getShipFlowBridge().on(eventName, handler));
  } catch {
    return Promise.resolve(() => undefined);
  }
}
