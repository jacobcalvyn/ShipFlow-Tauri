import { vi } from "vitest";
import type { ShipFlowBridge } from "../backend/bridge-contract";
import { installShipFlowTestBridge } from "../backend/bridge";

export type InvokeMock = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const LEGACY_WORKSPACE_METHODS: Record<string, string> = {
  "workspace.run_import_job_with_progress":
    "workspace_engine_run_import_job_with_progress",
  "workspace.retry_import_job_with_progress":
    "workspace_engine_retry_import_job_failed_with_progress",
  "workspace.refresh_tracking_with_progress":
    "workspace_engine_refresh_sheet_rows_tracking_with_progress",
};

export function createTestBridge(options?: {
  invoke?: InvokeMock;
  on?: ShipFlowBridge["on"];
  requestWorkspace?: ShipFlowBridge["requestWorkspace"];
}): ShipFlowBridge {
  const invoke = options?.invoke ?? vi.fn(async () => undefined);

  return {
    invoke: (command, args) => invoke(command, args) as Promise<never>,
    on: options?.on ?? (() => () => undefined),
    requestWorkspace:
      options?.requestWorkspace ??
      (async (method, params, onEvent) => {
        if (method === "workspace.command") {
          return invoke("workspace_engine_command", {
            command: params,
          });
        }

        const legacyCommand = LEGACY_WORKSPACE_METHODS[method];
        if (!legacyCommand) {
          throw new Error(`Unsupported workspace test method: ${method}`);
        }

        return invoke(legacyCommand, {
          request: params,
          onEvent: onEvent ? { onmessage: onEvent } : undefined,
        });
      }) as ShipFlowBridge["requestWorkspace"],
  };
}

export function installTestBridge(options?: Parameters<typeof createTestBridge>[0]) {
  const bridge = createTestBridge(options);
  installShipFlowTestBridge(bridge);
  return bridge;
}
