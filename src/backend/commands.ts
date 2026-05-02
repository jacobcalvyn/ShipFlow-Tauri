import { invoke } from "@tauri-apps/api/core";
import type {
  ApiServiceStatus,
  BagResponse,
  ManifestResponse,
  ServiceConfig,
  TrackResponse,
} from "../types";
import type { WorkspaceDocumentFile } from "../features/workspace/document";

export type WorkspaceDocumentReadResult = {
  path: string;
  document: WorkspaceDocumentFile;
};

export type WorkspaceDocumentWriteResult = {
  path: string;
  savedAt: string;
};

export type WorkspaceWindowLaunchRequest = {
  documentPath: string | null;
  startFresh: boolean;
};

export type WorkspaceDocumentClaimResult = {
  status: "claimed" | "alreadyOpen";
  path: string | null;
  ownerLabel: string | null;
};

export type WindowCloseAction = "cancel" | "discard";

function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  if (args === undefined) {
    return invoke<T>(command);
  }

  return invoke<T>(command, args);
}

export function trackShipment(args: {
  shipmentId: string;
  forceRefresh: boolean;
  sheetId: string;
  rowKey: string;
}) {
  return invokeCommand<TrackResponse>("track_shipment", args);
}

export function trackBag(args: {
  bagId: string;
  forceRefresh: boolean;
  sheetId: string;
  rowKey: string;
}) {
  return invokeCommand<BagResponse>("track_bag", args);
}

export function trackManifest(args: {
  manifestId: string;
  forceRefresh: boolean;
  sheetId: string;
  rowKey: string;
}) {
  return invokeCommand<ManifestResponse>("track_manifest", args);
}

export function resolvePodImage(imageSource: string) {
  return invokeCommand<string>("resolve_pod_image", { imageSource });
}

export function openExternalUrl(url: string) {
  return invokeCommand<void>("open_external_url", { url });
}

export function copyToClipboard(text: string) {
  return invokeCommand<void>("copy_to_clipboard", { text });
}

export function readFromClipboard() {
  return invokeCommand<string>("read_from_clipboard");
}

export function logFrontendRuntimeEvent(level: "info" | "error", message: string) {
  return invokeCommand<void>("log_frontend_runtime_event", { level, message });
}

export function openShipflowServiceApp() {
  return invokeCommand<void>("open_shipflow_service_app");
}

export function loadSavedApiServiceConfig() {
  return invokeCommand<ServiceConfig | null>("load_saved_api_service_config");
}

export function getApiServiceStatus() {
  return invokeCommand<ApiServiceStatus>("get_api_service_status");
}

export function configureApiService(config: ServiceConfig) {
  return invokeCommand<ApiServiceStatus>("configure_api_service", { config });
}

export function validateTrackingSourceConfig(config: ServiceConfig) {
  return invokeCommand<void>("validate_tracking_source_config", { config });
}

export function testExternalTrackingSource(config: ServiceConfig) {
  return invokeCommand<string>("test_external_tracking_source", { config });
}

export function testApiServiceConnection(config: ServiceConfig) {
  return invokeCommand<string>("test_api_service_connection", { config });
}

export function pickWorkspaceDocumentPath(
  mode: "open" | "save",
  suggestedName?: string
) {
  return invokeCommand<string | null>("pick_workspace_document_path", {
    mode,
    suggestedName,
  });
}

export function getCurrentWindowLabel() {
  return invokeCommand<string>("get_current_window_label");
}

export function setCurrentWindowTitle(title: string) {
  return invokeCommand<void>("set_current_window_title", { title });
}

export function setCurrentWindowDocumentState(args: {
  isDirty: boolean;
  documentName: string;
}) {
  return invokeCommand<void>("set_current_window_document_state", args);
}

export function claimCurrentWorkspaceDocument(path: string | null) {
  return invokeCommand<WorkspaceDocumentClaimResult>("claim_current_workspace_document", {
    path,
  });
}

export function readWorkspaceDocument(path: string) {
  return invokeCommand<WorkspaceDocumentReadResult>("read_workspace_document", { path });
}

export function writeWorkspaceDocument(path: string, document: WorkspaceDocumentFile) {
  return invokeCommand<WorkspaceDocumentWriteResult>("write_workspace_document", {
    path,
    document,
  });
}

export function createWorkspaceWindow(documentPath: string | null) {
  return invokeCommand<WorkspaceDocumentClaimResult>("create_workspace_window", {
    documentPath,
  });
}

export function takePendingWorkspaceWindowRequest() {
  return invokeCommand<WorkspaceWindowLaunchRequest | null>(
    "take_pending_workspace_window_request"
  );
}

export function resolveWindowCloseRequest(action: WindowCloseAction) {
  return invokeCommand<void>("resolve_window_close_request", { action });
}
