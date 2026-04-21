import { KeyboardEvent } from "react";
import { WorkspaceDocumentMeta } from "../document";

type WorkspaceDocumentDialogMode = "open" | "saveAs";

type PendingWindowCloseRequest = {
  documentName: string;
};

type WorkspaceDocumentDialogsProps = {
  documentDialogMode: WorkspaceDocumentDialogMode | null;
  documentPathDraft: string;
  pendingWindowCloseRequest: PendingWindowCloseRequest | null;
  isResolvingWindowClose: boolean;
  documentMeta: WorkspaceDocumentMeta;
  onDocumentPathDraftChange: (value: string) => void;
  onCloseDocumentDialog: () => void;
  onSubmitDocumentDialog: () => Promise<void>;
  onCancelPendingWindowClose: () => void;
  onDiscardPendingWindowClose: () => void;
  onSaveAndCloseWindow: () => void;
};

export function WorkspaceDocumentDialogs({
  documentDialogMode,
  documentPathDraft,
  pendingWindowCloseRequest,
  isResolvingWindowClose,
  documentMeta,
  onDocumentPathDraftChange,
  onCloseDocumentDialog,
  onSubmitDocumentDialog,
  onCancelPendingWindowClose,
  onDiscardPendingWindowClose,
  onSaveAndCloseWindow,
}: WorkspaceDocumentDialogsProps) {
  const handleDocumentPathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void onSubmitDocumentDialog();
    }
  };

  return (
    <>
      {documentDialogMode ? (
        <div className="document-dialog-backdrop">
          <div
            className="document-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Dokumen"
          >
            <div className="document-dialog-header">
              <h3>{documentDialogMode === "open" ? "Buka Dokumen" : "Simpan Dokumen"}</h3>
              <p>
                {documentDialogMode === "open"
                  ? "Masukkan lokasi file yang ingin dibuka."
                  : "Masukkan lokasi file tujuan untuk dokumen ini."}
              </p>
            </div>
            <label className="settings-text-field">
              <span className="settings-input-label">Lokasi File</span>
              <input
                type="text"
                aria-label="Lokasi File"
                value={documentPathDraft}
                placeholder="~/Documents/dokumen.shipflow"
                onChange={(event) => onDocumentPathDraftChange(event.target.value)}
                onKeyDown={handleDocumentPathKeyDown}
                autoFocus
              />
            </label>
            <div className="document-dialog-actions">
              <button type="button" className="sheet-tab-action" onClick={onCloseDocumentDialog}>
                Batal
              </button>
              <button
                type="button"
                className="sheet-tab-action"
                onClick={() => {
                  void onSubmitDocumentDialog();
                }}
                disabled={!documentPathDraft.trim()}
              >
                {documentDialogMode === "open" ? "Buka" : "Simpan"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingWindowCloseRequest ? (
        <div className="document-dialog-backdrop">
          <div
            className="document-dialog document-close-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Tutup Dokumen"
          >
            <div className="document-dialog-header">
              <h3>Tutup Dokumen?</h3>
              <p>
                Perubahan pada <strong>{pendingWindowCloseRequest.documentName}</strong> belum
                disimpan. Jika keluar sekarang, perubahan ini tidak akan tersimpan.
              </p>
            </div>
            <div className="document-dialog-actions">
              <button
                type="button"
                className="sheet-tab-action"
                onClick={onCancelPendingWindowClose}
                disabled={isResolvingWindowClose}
              >
                Batal
              </button>
              <button
                type="button"
                className="sheet-tab-action"
                onClick={onDiscardPendingWindowClose}
                disabled={isResolvingWindowClose}
              >
                Jangan Simpan
              </button>
              <button
                type="button"
                className="sheet-tab-action"
                onClick={onSaveAndCloseWindow}
                disabled={isResolvingWindowClose || documentMeta.persistenceStatus === "saving"}
              >
                Simpan & Tutup
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
