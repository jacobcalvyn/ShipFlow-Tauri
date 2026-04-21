import { useWorkspaceDocumentController } from "./useWorkspaceDocumentController";
import { useWorkspaceShellController } from "./useWorkspaceShellController";
import { useWorkspaceServiceSurfaceController } from "./useWorkspaceServiceSurfaceController";

type UseWorkspaceShellSettingsSurfaceControllerOptions = {
  document: ReturnType<typeof useWorkspaceDocumentController>;
  service: ReturnType<typeof useWorkspaceServiceSurfaceController>;
};

export function useWorkspaceShellSettingsSurfaceController({
  document,
  service,
}: UseWorkspaceShellSettingsSurfaceControllerOptions) {
  return useWorkspaceShellController({
    hasPendingServiceConfigChanges: service.hasPendingServiceConfigChanges,
    cancelServiceConfigPreview: service.cancelServiceConfigPreview,
    confirmServiceConfig: service.confirmServiceConfig,
    createNewWorkspaceDocument: document.createNewWorkspaceDocument,
    openWorkspaceDocumentWithPicker: document.openWorkspaceDocumentWithPicker,
    saveCurrentWorkspaceDocument: document.saveCurrentWorkspaceDocument,
    saveWorkspaceDocumentAs: document.saveWorkspaceDocumentAs,
    createNewWorkspaceWindow: document.createNewWorkspaceWindow,
    openWorkspaceInNewWindow: document.openWorkspaceInNewWindow,
    openShipFlowServiceApp: service.openShipFlowServiceApp,
  });
}
