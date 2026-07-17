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
    createNewWorkspaceDocument: document.createNewWorkspaceDocument,
    openWorkspaceDocumentWithPicker: document.openWorkspaceDocumentWithPicker,
    saveCurrentWorkspaceDocument: document.saveCurrentWorkspaceDocument,
    saveWorkspaceDocumentAs: document.saveWorkspaceDocumentAs,
    createNewWorkspaceWindow: document.createNewWorkspaceWindow,
    openWorkspaceInNewWindow: document.openWorkspaceInNewWindow,
    checkForAppUpdate: service.checkForAppUpdate,
    installAvailableAppUpdate: service.installAvailableAppUpdate,
    showNotice: service.showNotice,
  });
}
