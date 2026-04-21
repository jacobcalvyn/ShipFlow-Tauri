import { ComponentProps } from "react";
import { SheetTabs } from "./components/SheetTabs";

type UseWorkspaceTabsPropsOptions = {
  workspaceTabs: ComponentProps<typeof SheetTabs>["tabs"];
  activeSheetId: string;
  effectiveDisplayScale: ComponentProps<typeof SheetTabs>["displayScale"];
  settingsOpenRequestToken: number;
  recentDocumentItems: NonNullable<ComponentProps<typeof SheetTabs>["recentDocuments"]>;
  canUseAutosave: boolean;
  isAutosaveActive: boolean;
  effectiveServiceConfig: ComponentProps<typeof SheetTabs>["serviceConfig"];
  apiServiceStatus: ComponentProps<typeof SheetTabs>["serviceStatus"];
  hasPendingServiceConfigChanges: boolean;
  toggleAutosave: NonNullable<ComponentProps<typeof SheetTabs>["onToggleAutosave"]>;
  createNewWorkspaceDocument: NonNullable<ComponentProps<typeof SheetTabs>["onCreateDocument"]>;
  openWorkspaceDocumentWithPicker: () => Promise<unknown>;
  saveCurrentWorkspaceDocument: () => Promise<unknown>;
  saveWorkspaceDocumentAs: () => Promise<unknown>;
  createNewWorkspaceWindow: () => Promise<unknown>;
  openWorkspaceInNewWindow: () => Promise<unknown>;
  openShipFlowServiceApp: () => Promise<unknown>;
  openWorkspaceDocumentFromPath: (path: string) => Promise<unknown>;
  activateSheet: ComponentProps<typeof SheetTabs>["onActivateSheet"];
  createSheet: ComponentProps<typeof SheetTabs>["onCreateSheet"];
  duplicateSheet: ComponentProps<typeof SheetTabs>["onDuplicateSheet"];
  renameActiveSheet: ComponentProps<typeof SheetTabs>["onRenameSheet"];
  deleteActiveSheet: ComponentProps<typeof SheetTabs>["onDeleteSheet"];
  previewDisplayScale: ComponentProps<typeof SheetTabs>["onPreviewDisplayScale"];
  previewServiceEnabled: ComponentProps<typeof SheetTabs>["onPreviewServiceEnabled"];
  previewServiceMode: ComponentProps<typeof SheetTabs>["onPreviewServiceMode"];
  previewServicePort: ComponentProps<typeof SheetTabs>["onPreviewServicePort"];
  previewTrackingSource: NonNullable<ComponentProps<typeof SheetTabs>["onPreviewTrackingSource"]>;
  previewExternalApiBaseUrl: NonNullable<ComponentProps<typeof SheetTabs>["onPreviewExternalApiBaseUrl"]>;
  previewExternalApiAuthToken: NonNullable<ComponentProps<typeof SheetTabs>["onPreviewExternalApiAuthToken"]>;
  previewAllowInsecureExternalApiHttp: NonNullable<ComponentProps<typeof SheetTabs>["onPreviewAllowInsecureExternalApiHttp"]>;
  previewGenerateServiceToken: ComponentProps<typeof SheetTabs>["onGenerateServiceToken"];
  previewRegenerateServiceToken: ComponentProps<typeof SheetTabs>["onRegenerateServiceToken"];
  copyServiceEndpoint: NonNullable<ComponentProps<typeof SheetTabs>["onCopyServiceEndpoint"]>;
  copyServiceToken: NonNullable<ComponentProps<typeof SheetTabs>["onCopyServiceToken"]>;
  testExternalTrackingSource: NonNullable<ComponentProps<typeof SheetTabs>["onTestExternalTrackingSource"]>;
  confirmSettings: ComponentProps<typeof SheetTabs>["onConfirmSettings"];
  cancelSettingsPreview: ComponentProps<typeof SheetTabs>["onCancelSettings"];
  isSheetTransferDragActive: boolean;
  dropSelectedIdsToExistingSheet: NonNullable<ComponentProps<typeof SheetTabs>["onDropSelectionToSheet"]>;
  dropSelectedIdsToNewSheet: NonNullable<ComponentProps<typeof SheetTabs>["onDropSelectionToNewSheet"]>;
};

export function useWorkspaceTabsProps({
  workspaceTabs,
  activeSheetId,
  effectiveDisplayScale,
  settingsOpenRequestToken,
  recentDocumentItems,
  canUseAutosave,
  isAutosaveActive,
  effectiveServiceConfig,
  apiServiceStatus,
  hasPendingServiceConfigChanges,
  toggleAutosave,
  createNewWorkspaceDocument,
  openWorkspaceDocumentWithPicker,
  saveCurrentWorkspaceDocument,
  saveWorkspaceDocumentAs,
  createNewWorkspaceWindow,
  openWorkspaceInNewWindow,
  openShipFlowServiceApp,
  openWorkspaceDocumentFromPath,
  activateSheet,
  createSheet,
  duplicateSheet,
  renameActiveSheet,
  deleteActiveSheet,
  previewDisplayScale,
  previewServiceEnabled,
  previewServiceMode,
  previewServicePort,
  previewTrackingSource,
  previewExternalApiBaseUrl,
  previewExternalApiAuthToken,
  previewAllowInsecureExternalApiHttp,
  previewGenerateServiceToken,
  previewRegenerateServiceToken,
  copyServiceEndpoint,
  copyServiceToken,
  testExternalTrackingSource,
  confirmSettings,
  cancelSettingsPreview,
  isSheetTransferDragActive,
  dropSelectedIdsToExistingSheet,
  dropSelectedIdsToNewSheet,
}: UseWorkspaceTabsPropsOptions): ComponentProps<typeof SheetTabs> {
  return {
    tabs: workspaceTabs,
    activeSheetId,
    displayScale: effectiveDisplayScale,
    settingsOpenRequestToken,
    recentDocuments: recentDocumentItems,
    canUseAutosave,
    isAutosaveEnabled: isAutosaveActive,
    serviceConfig: effectiveServiceConfig,
    serviceStatus: apiServiceStatus,
    hasPendingServiceConfigChanges,
    onToggleAutosave: toggleAutosave,
    onCreateDocument: createNewWorkspaceDocument,
    onOpenDocument: () => {
      void openWorkspaceDocumentWithPicker();
    },
    onSaveDocument: () => {
      void saveCurrentWorkspaceDocument();
    },
    onSaveDocumentAs: () => {
      void saveWorkspaceDocumentAs();
    },
    onCreateDocumentWindow: () => {
      void createNewWorkspaceWindow();
    },
    onOpenDocumentInNewWindow: () => {
      void openWorkspaceInNewWindow();
    },
    onOpenServiceSettings: () => {
      void openShipFlowServiceApp();
    },
    onOpenRecentDocument: (path) => {
      void openWorkspaceDocumentFromPath(path);
    },
    onActivateSheet: activateSheet,
    onCreateSheet: createSheet,
    onDuplicateSheet: duplicateSheet,
    onRenameSheet: renameActiveSheet,
    onDeleteSheet: deleteActiveSheet,
    onPreviewDisplayScale: previewDisplayScale,
    onPreviewServiceEnabled: previewServiceEnabled,
    onPreviewServiceMode: previewServiceMode,
    onPreviewServicePort: previewServicePort,
    onPreviewTrackingSource: previewTrackingSource,
    onPreviewExternalApiBaseUrl: previewExternalApiBaseUrl,
    onPreviewExternalApiAuthToken: previewExternalApiAuthToken,
    onPreviewAllowInsecureExternalApiHttp: previewAllowInsecureExternalApiHttp,
    onGenerateServiceToken: previewGenerateServiceToken,
    onRegenerateServiceToken: previewRegenerateServiceToken,
    onCopyServiceEndpoint: copyServiceEndpoint,
    onCopyServiceToken: copyServiceToken,
    onTestExternalTrackingSource: testExternalTrackingSource,
    onConfirmSettings: confirmSettings,
    onCancelSettings: cancelSettingsPreview,
    isSelectionDragActive: isSheetTransferDragActive,
    selectionDragSourceSheetId: isSheetTransferDragActive ? activeSheetId : null,
    onDropSelectionToSheet: dropSelectedIdsToExistingSheet,
    onDropSelectionToNewSheet: dropSelectedIdsToNewSheet,
  };
}
