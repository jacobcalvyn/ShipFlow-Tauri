import { contextBridge, ipcRenderer } from "electron";
import {
  SHIPFLOW_EVENT_CHANNEL,
  SHIPFLOW_INVOKE_CHANNEL,
  SHIPFLOW_WORKSPACE_EVENT_CHANNEL,
  SHIPFLOW_WORKSPACE_REQUEST_CHANNEL,
  type ShipFlowCommand,
  type ShipFlowBridge,
  type ShipFlowRuntimeEvent,
  type ShipFlowWorkspaceEvent,
} from "../../src/backend/bridge-contract";

const ALLOWED_EVENTS = new Set([
  "shipflow://app-menu-command",
  "shipflow://window-close-requested",
]);
const ALLOWED_COMMANDS = new Set<ShipFlowCommand>([
  "resolve_pod_image",
  "open_external_url",
  "copy_to_clipboard",
  "read_from_clipboard",
  "open_app_log",
  "close_current_window",
  "log_frontend_runtime_event",
  "get_release_health",
  "check_app_update",
  "install_app_update",
  "load_saved_api_service_config",
  "copy_public_api_token",
  "get_api_service_status",
  "configure_api_service",
  "validate_tracking_source_config",
  "test_external_tracking_source",
  "pick_workspace_document_path",
  "authorize_workspace_document_path",
  "get_current_window_label",
  "set_current_window_title",
  "set_current_window_document_state",
  "claim_current_workspace_document",
  "read_workspace_document",
  "write_workspace_document",
  "export_workspace_csv",
  "list_workspace_recovery",
  "create_workspace_window",
  "take_pending_workspace_window_request",
  "resolve_window_close_request",
]);

let requestSequence = 0;

function nextRequestId() {
  requestSequence += 1;
  return `${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

const bridge: ShipFlowBridge = Object.freeze({
  invoke<T>(command: ShipFlowCommand, args?: Record<string, unknown>) {
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`Unsupported ShipFlow command: ${command}`);
    }
    return ipcRenderer.invoke(SHIPFLOW_INVOKE_CHANNEL, command, args) as Promise<T>;
  },

  on<T>(eventName: string, listener: (event: ShipFlowRuntimeEvent<T>) => void) {
    if (!ALLOWED_EVENTS.has(eventName)) {
      throw new Error(`Unsupported ShipFlow event: ${eventName}`);
    }

    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      receivedEventName: string,
      payload: T,
    ) => {
      if (receivedEventName === eventName) {
        listener({ payload });
      }
    };
    ipcRenderer.on(SHIPFLOW_EVENT_CHANNEL, wrappedListener);
    return () => ipcRenderer.removeListener(SHIPFLOW_EVENT_CHANNEL, wrappedListener);
  },

  requestWorkspace<T>(
    method: string,
    params: unknown,
    onEvent?: (event: unknown) => void,
  ) {
    const requestId = nextRequestId();
    const workspaceEventListener = (
      _event: Electron.IpcRendererEvent,
      message: ShipFlowWorkspaceEvent,
    ) => {
      if (message.requestId === requestId) {
        onEvent?.(message.event);
      }
    };
    ipcRenderer.on(SHIPFLOW_WORKSPACE_EVENT_CHANNEL, workspaceEventListener);

    return (
      ipcRenderer.invoke(SHIPFLOW_WORKSPACE_REQUEST_CHANNEL, {
        requestId,
        method,
        params,
      }) as Promise<T>
    ).finally(() => {
      ipcRenderer.removeListener(
        SHIPFLOW_WORKSPACE_EVENT_CHANNEL,
        workspaceEventListener,
      );
    });
  },
});

contextBridge.exposeInMainWorld("shipflow", bridge);
