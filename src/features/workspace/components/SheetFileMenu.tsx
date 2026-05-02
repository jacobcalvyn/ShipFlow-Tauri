import { CSSProperties } from "react";
import { createPortal } from "react-dom";

type RecentDocumentItem = {
  path: string;
  name: string;
};

type SheetFileMenuProps = {
  isOpen: boolean;
  style: CSSProperties | null;
  recentDocuments: RecentDocumentItem[];
  canUseAutosave: boolean;
  isAutosaveEnabled: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onAction: (action: () => void) => void;
  onCreateDocument: () => void;
  onOpenDocument: () => void;
  onSaveDocument: () => void;
  onSaveDocumentAs: () => void;
  onCreateDocumentWindow: () => void;
  onOpenDocumentInNewWindow: () => void;
  onOpenRecentDocument: (path: string) => void;
  onToggleAutosave: () => void;
};

export function SheetFileMenu({
  isOpen,
  style,
  recentDocuments,
  canUseAutosave,
  isAutosaveEnabled,
  onMouseEnter,
  onMouseLeave,
  onAction,
  onCreateDocument,
  onOpenDocument,
  onSaveDocument,
  onSaveDocumentAs,
  onCreateDocumentWindow,
  onOpenDocumentInNewWindow,
  onOpenRecentDocument,
  onToggleAutosave,
}: SheetFileMenuProps) {
  if (!isOpen || !style) {
    return null;
  }

  return createPortal(
    <div
      className="sheet-file-menu-panel"
      style={style}
      role="menu"
      aria-label="File"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="sheet-file-menu-section">
        <button
          type="button"
          className="sheet-file-menu-button"
          role="menuitem"
          onClick={() => onAction(onCreateDocument)}
        >
          Baru
        </button>
        <button
          type="button"
          className="sheet-file-menu-button"
          role="menuitem"
          onClick={() => onAction(onOpenDocument)}
        >
          Buka
        </button>
        <button
          type="button"
          className="sheet-file-menu-button"
          role="menuitem"
          onClick={() => onAction(onSaveDocument)}
        >
          Simpan
        </button>
        <button
          type="button"
          className="sheet-file-menu-button"
          role="menuitem"
          onClick={() => onAction(onSaveDocumentAs)}
        >
          Simpan Sebagai
        </button>
        <button
          type="button"
          className="sheet-file-menu-button"
          role="menuitem"
          onClick={() => onAction(onCreateDocumentWindow)}
        >
          Jendela Baru
        </button>
        <button
          type="button"
          className="sheet-file-menu-button"
          role="menuitem"
          onClick={() => onAction(onOpenDocumentInNewWindow)}
        >
          Buka di Jendela Baru
        </button>
      </div>
      <div className="sheet-file-menu-section">
        <label className="sheet-file-menu-toggle">
          <span>Simpan Otomatis</span>
          <input
            type="checkbox"
            checked={isAutosaveEnabled}
            onChange={() => onToggleAutosave()}
            disabled={!canUseAutosave}
          />
        </label>
        {!canUseAutosave ? (
          <div className="sheet-file-menu-note">
            Simpan dokumen terlebih dahulu untuk mengaktifkan Simpan Otomatis.
          </div>
        ) : null}
      </div>
      {recentDocuments.length > 0 ? (
        <div className="sheet-file-menu-section">
          <span className="sheet-file-menu-label">Dokumen terbaru</span>
          {recentDocuments.map((document) => (
            <button
              key={document.path}
              type="button"
              className="sheet-file-menu-button is-secondary"
              role="menuitem"
              onClick={() => onAction(() => onOpenRecentDocument(document.path))}
            >
              {document.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body
  );
}
