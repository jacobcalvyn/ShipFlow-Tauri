import { ComponentProps } from "react";
import { SheetTabs } from "./components/SheetTabs";

type UseWorkspaceTabsPropsOptions = {
  workspaceTabs: ComponentProps<typeof SheetTabs>["tabs"];
  activeSheetId: string;
  effectiveDisplayScale: ComponentProps<typeof SheetTabs>["displayScale"];
  hasPendingSettingsChanges: boolean;
  settingsOpenRequestToken: number;
  recentDocumentItems: NonNullable<ComponentProps<typeof SheetTabs>["recentDocuments"]>;
  canUseAutosave: boolean;
  isAutosaveActive: boolean;
  toggleAutosave: NonNullable<ComponentProps<typeof SheetTabs>["onToggleAutosave"]>;
  createNewWorkspaceDocument: NonNullable<ComponentProps<typeof SheetTabs>["onCreateDocument"]>;
  openWorkspaceDocumentWithPicker: () => Promise<unknown>;
  saveCurrentWorkspaceDocument: () => Promise<unknown>;
  saveWorkspaceDocumentAs: () => Promise<unknown>;
  createNewWorkspaceWindow: () => Promise<unknown>;
  openWorkspaceInNewWindow: () => Promise<unknown>;
  openWorkspaceDocumentFromPath: (path: string) => Promise<unknown>;
  activateSheet: ComponentProps<typeof SheetTabs>["onActivateSheet"];
  createSheet: ComponentProps<typeof SheetTabs>["onCreateSheet"];
  duplicateSheet: ComponentProps<typeof SheetTabs>["onDuplicateSheet"];
  renameActiveSheet: ComponentProps<typeof SheetTabs>["onRenameSheet"];
  deleteActiveSheet: ComponentProps<typeof SheetTabs>["onDeleteSheet"];
  previewDisplayScale: ComponentProps<typeof SheetTabs>["onPreviewDisplayScale"];
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
  hasPendingSettingsChanges,
  settingsOpenRequestToken,
  recentDocumentItems,
  canUseAutosave,
  isAutosaveActive,
  toggleAutosave,
  createNewWorkspaceDocument,
  openWorkspaceDocumentWithPicker,
  saveCurrentWorkspaceDocument,
  saveWorkspaceDocumentAs,
  createNewWorkspaceWindow,
  openWorkspaceInNewWindow,
  openWorkspaceDocumentFromPath,
  activateSheet,
  createSheet,
  duplicateSheet,
  renameActiveSheet,
  deleteActiveSheet,
  previewDisplayScale,
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
    hasPendingSettingsChanges,
    settingsOpenRequestToken,
    recentDocuments: recentDocumentItems,
    canUseAutosave,
    isAutosaveEnabled: isAutosaveActive,
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
    onOpenRecentDocument: (path) => {
      void openWorkspaceDocumentFromPath(path);
    },
    onActivateSheet: activateSheet,
    onCreateSheet: createSheet,
    onDuplicateSheet: duplicateSheet,
    onRenameSheet: renameActiveSheet,
    onDeleteSheet: deleteActiveSheet,
    onPreviewDisplayScale: previewDisplayScale,
    onConfirmSettings: confirmSettings,
    onCancelSettings: cancelSettingsPreview,
    isSelectionDragActive: isSheetTransferDragActive,
    selectionDragSourceSheetId: isSheetTransferDragActive ? activeSheetId : null,
    onDropSelectionToSheet: dropSelectedIdsToExistingSheet,
    onDropSelectionToNewSheet: dropSelectedIdsToNewSheet,
  };
}
