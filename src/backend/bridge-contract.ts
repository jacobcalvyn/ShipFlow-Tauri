export const SHIPFLOW_INVOKE_CHANNEL = "shipflow:invoke";
export const SHIPFLOW_EVENT_CHANNEL = "shipflow:event";
export const SHIPFLOW_WORKSPACE_REQUEST_CHANNEL = "shipflow:workspace-request";
export const SHIPFLOW_WORKSPACE_EVENT_CHANNEL = "shipflow:workspace-event";

export type ShipFlowCommand =
  | "resolve_pod_image"
  | "open_external_url"
  | "copy_to_clipboard"
  | "read_from_clipboard"
  | "open_app_log"
  | "log_frontend_runtime_event"
  | "get_release_health"
  | "check_app_update"
  | "install_app_update"
  | "load_saved_api_service_config"
  | "get_api_service_status"
  | "configure_api_service"
  | "validate_tracking_source_config"
  | "test_external_tracking_source"
  | "pick_workspace_document_path"
  | "get_current_window_label"
  | "set_current_window_title"
  | "set_current_window_document_state"
  | "claim_current_workspace_document"
  | "read_workspace_document"
  | "write_workspace_document"
  | "export_workspace_csv"
  | "list_workspace_recovery"
  | "create_workspace_window"
  | "take_pending_workspace_window_request"
  | "resolve_window_close_request";

export type ShipFlowWorkspaceMethod =
  | "workspace.command"
  | "workspace.run_import_job_with_progress"
  | "workspace.retry_import_job_with_progress"
  | "workspace.refresh_tracking_with_progress";

export type ShipFlowRuntimeEvent<T> = {
  payload: T;
};

export type ShipFlowWorkspaceRequest = {
  requestId: string;
  method: ShipFlowWorkspaceMethod;
  params: unknown;
};

export type ShipFlowWorkspaceEvent = {
  requestId: string;
  event: unknown;
};

export interface ShipFlowBridge {
  invoke<T>(command: ShipFlowCommand, args?: Record<string, unknown>): Promise<T>;
  on<T>(eventName: string, listener: (event: ShipFlowRuntimeEvent<T>) => void): () => void;
  requestWorkspace<T>(
    method: ShipFlowWorkspaceMethod,
    params: unknown,
    onEvent?: (event: unknown) => void,
  ): Promise<T>;
}

declare global {
  interface Window {
    shipflow?: ShipFlowBridge;
  }
}
