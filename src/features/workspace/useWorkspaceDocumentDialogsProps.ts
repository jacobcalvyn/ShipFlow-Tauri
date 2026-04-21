import { ComponentProps } from "react";
import { WorkspaceDocumentDialogs } from "./components/WorkspaceDocumentDialogs";

type UseWorkspaceDocumentDialogsPropsOptions = {
  documentDialogMode: ComponentProps<typeof WorkspaceDocumentDialogs>["documentDialogMode"];
  documentPathDraft: ComponentProps<typeof WorkspaceDocumentDialogs>["documentPathDraft"];
  pendingWindowCloseRequest: ComponentProps<typeof WorkspaceDocumentDialogs>["pendingWindowCloseRequest"];
  isResolvingWindowClose: ComponentProps<typeof WorkspaceDocumentDialogs>["isResolvingWindowClose"];
  documentMeta: ComponentProps<typeof WorkspaceDocumentDialogs>["documentMeta"];
  setDocumentPathDraft: ComponentProps<typeof WorkspaceDocumentDialogs>["onDocumentPathDraftChange"];
  closeDocumentDialog: ComponentProps<typeof WorkspaceDocumentDialogs>["onCloseDocumentDialog"];
  submitDocumentDialog: ComponentProps<typeof WorkspaceDocumentDialogs>["onSubmitDocumentDialog"];
  cancelPendingWindowClose: ComponentProps<typeof WorkspaceDocumentDialogs>["onCancelPendingWindowClose"];
  discardPendingWindowClose: ComponentProps<typeof WorkspaceDocumentDialogs>["onDiscardPendingWindowClose"];
  saveAndCloseWindow: ComponentProps<typeof WorkspaceDocumentDialogs>["onSaveAndCloseWindow"];
};

export function useWorkspaceDocumentDialogsProps({
  documentDialogMode,
  documentPathDraft,
  pendingWindowCloseRequest,
  isResolvingWindowClose,
  documentMeta,
  setDocumentPathDraft,
  closeDocumentDialog,
  submitDocumentDialog,
  cancelPendingWindowClose,
  discardPendingWindowClose,
  saveAndCloseWindow,
}: UseWorkspaceDocumentDialogsPropsOptions): ComponentProps<typeof WorkspaceDocumentDialogs> {
  return {
    documentDialogMode,
    documentPathDraft,
    pendingWindowCloseRequest,
    isResolvingWindowClose,
    documentMeta,
    onDocumentPathDraftChange: setDocumentPathDraft,
    onCloseDocumentDialog: closeDocumentDialog,
    onSubmitDocumentDialog: submitDocumentDialog,
    onCancelPendingWindowClose: cancelPendingWindowClose,
    onDiscardPendingWindowClose: discardPendingWindowClose,
    onSaveAndCloseWindow: saveAndCloseWindow,
  };
}
