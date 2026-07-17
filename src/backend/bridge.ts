import type { ShipFlowBridge } from "./bridge-contract";

let testBridge: ShipFlowBridge | null = null;

export function getShipFlowBridge(): ShipFlowBridge {
  const bridge = window.shipflow ?? testBridge;
  if (!bridge) {
    throw new Error(
      "ShipFlow native bridge is unavailable. Run the application through Electron.",
    );
  }
  return bridge;
}

export function installShipFlowTestBridge(bridge: ShipFlowBridge | null) {
  if (import.meta.env.MODE !== "test") {
    throw new Error("The ShipFlow test bridge is only available in tests.");
  }
  testBridge = bridge;
}

