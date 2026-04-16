import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type SheetTabItem = {
  id: string;
  name: string;
  isActive: boolean;
};

type SheetTabsProps = {
  tabs: SheetTabItem[];
  activeSheetId: string;
  displayScale: "small" | "medium" | "large";
  onActivateSheet: (sheetId: string) => void;
  onCreateSheet: () => void;
  onDuplicateActiveSheet: () => void;
  onRenameSheet: (sheetId: string, name: string) => void;
  onDeleteSheet: (sheetId: string) => void;
  onPreviewDisplayScale: (scale: "small" | "medium" | "large") => void;
  onConfirmDisplayScale: () => void;
  onCancelDisplayScale: () => void;
};

export function SheetTabs({
  tabs,
  activeSheetId,
  displayScale,
  onActivateSheet,
  onCreateSheet,
  onDuplicateActiveSheet,
  onRenameSheet,
  onDeleteSheet,
  onPreviewDisplayScale,
  onConfirmDisplayScale,
  onCancelDisplayScale,
}: SheetTabsProps) {
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeSheetId) ?? tabs[0] ?? null,
    [activeSheetId, tabs]
  );
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [sheetNameDraft, setSheetNameDraft] = useState("");
  const [deleteArmedSheetId, setDeleteArmedSheetId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsModalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (editingSheetId && editingSheetId !== activeSheetId) {
      setEditingSheetId(null);
      setSheetNameDraft("");
    }
  }, [activeSheetId, editingSheetId]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const modal = settingsModalRef.current;
    const focusableSelectors =
      'input[name="display-scale"], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const firstTarget =
        modal?.querySelector<HTMLInputElement>('input[name="display-scale"]:checked') ??
        modal?.querySelector<HTMLInputElement>('input[name="display-scale"]') ??
        modal?.querySelector<HTMLElement>("button");
      firstTarget?.focus();
    };

    focusFirst();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        modal?.querySelectorAll<HTMLElement>(focusableSelectors) ?? []
      ).filter((element) => !element.hasAttribute("disabled"));

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const currentIndex = activeElement ? focusable.indexOf(activeElement) : -1;

      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1]?.focus();
        }
        return;
      }

      if (currentIndex === -1 || currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [displayScale, isSettingsOpen]);

  const beginRename = () => {
    if (!activeTab) {
      return;
    }

    setDeleteArmedSheetId(null);
    setEditingSheetId(activeTab.id);
    setSheetNameDraft(activeTab.name);
  };

  const submitRename = (event?: FormEvent) => {
    event?.preventDefault();

    if (!editingSheetId) {
      return;
    }

    onRenameSheet(editingSheetId, sheetNameDraft);
    setEditingSheetId(null);
    setSheetNameDraft("");
  };

  const cancelRename = () => {
    setEditingSheetId(null);
    setSheetNameDraft("");
  };

  const handleDeleteSheet = () => {
    if (!activeTab) {
      return;
    }

    if (deleteArmedSheetId !== activeTab.id) {
      setDeleteArmedSheetId(activeTab.id);
      setEditingSheetId(null);
      return;
    }

    onDeleteSheet(activeTab.id);
    setDeleteArmedSheetId(null);
  };

  const handleActivateSheet = (sheetId: string) => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    onActivateSheet(sheetId);
  };

  const canDeleteSheet = tabs.length > 1;
  const isRenaming = editingSheetId !== null;

  const handleCreateSheet = () => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    onCancelDisplayScale();
    setIsSettingsOpen(false);
    onCreateSheet();
  };

  const handleDuplicateSheet = () => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    onCancelDisplayScale();
    setIsSettingsOpen(false);
    onDuplicateActiveSheet();
  };

  const closeSettings = () => {
    onCancelDisplayScale();
    setIsSettingsOpen(false);
  };

  const openSettings = () => {
    setIsSettingsOpen(true);
  };

  const confirmSettings = () => {
    onConfirmDisplayScale();
    setIsSettingsOpen(false);
  };

  return (
    <section className="sheet-tabs-panel" aria-label="Sheet tabs">
      <div className="sheet-tabs-list" role="tablist" aria-label="Workspace sheets">
        {tabs.map((tab) => {
          const isEditing = editingSheetId === tab.id;

          return (
            <div
              key={tab.id}
              className={[
                "sheet-tab",
                tab.isActive ? "sheet-tab-active" : "",
                isEditing ? "sheet-tab-editing" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {isEditing ? (
                <form className="sheet-tab-form" onSubmit={submitRename}>
                  <input
                    autoFocus
                    className="sheet-tab-input"
                    value={sheetNameDraft}
                    onChange={(event) => setSheetNameDraft(event.target.value)}
                    onBlur={submitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.isActive}
                  className="sheet-tab-button"
                  onClick={() => handleActivateSheet(tab.id)}
                >
                  {tab.name}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="sheet-tabs-actions">
        <button
          type="button"
          className="sheet-tab-action"
          onClick={handleCreateSheet}
          disabled={isRenaming}
        >
          Sheet Baru
        </button>
        <button
          type="button"
          className="sheet-tab-action"
          onClick={handleDuplicateSheet}
          disabled={!activeTab || isRenaming}
        >
          Duplikat Sheet Aktif
        </button>
        <button
          type="button"
          className="sheet-tab-action"
          onClick={editingSheetId ? submitRename : beginRename}
          disabled={!activeTab}
        >
          {editingSheetId ? "Simpan Nama" : "Ganti Nama"}
        </button>
        <button
          type="button"
          className="sheet-tab-action sheet-tab-action-danger"
          onClick={handleDeleteSheet}
          disabled={!activeTab || !canDeleteSheet || isRenaming}
        >
          {deleteArmedSheetId === activeSheetId
            ? "Konfirmasi Hapus Sheet Aktif"
            : "Hapus Sheet Aktif"}
        </button>
        <div className="sheet-settings-popover">
          <button
            type="button"
            className={[
              "sheet-tab-action",
              "tool-popover-trigger",
              isSettingsOpen ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={openSettings}
          >
            Setting
          </button>
        </div>
      </div>
      {isSettingsOpen
        ? createPortal(
            <div className="settings-modal-backdrop">
              <div
                ref={settingsModalRef}
                className="settings-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Setting"
              >
                <div className="settings-modal-header">
                  <h3>Setting</h3>
                </div>
                <div className="settings-form-group">
                  <div className="settings-modal-field-label">Ukuran Tampilan</div>
                  <div
                    className="settings-radio-group"
                    role="radiogroup"
                    aria-label="Ukuran Tampilan"
                  >
                    <label className="settings-radio-option">
                      <input
                        type="radio"
                        name="display-scale"
                        checked={displayScale === "small"}
                        onChange={() => onPreviewDisplayScale("small")}
                      />
                      <span className="settings-radio-text">Kecil</span>
                    </label>
                    <label className="settings-radio-option">
                      <input
                        type="radio"
                        name="display-scale"
                        checked={displayScale === "medium"}
                        onChange={() => onPreviewDisplayScale("medium")}
                      />
                      <span className="settings-radio-text">Sedang</span>
                    </label>
                    <label className="settings-radio-option">
                      <input
                        type="radio"
                        name="display-scale"
                        checked={displayScale === "large"}
                        onChange={() => onPreviewDisplayScale("large")}
                      />
                      <span className="settings-radio-text">Besar</span>
                    </label>
                  </div>
                </div>
                <div className="settings-modal-footer">
                  <button
                    type="button"
                    className="sheet-tab-action settings-modal-cancel"
                    onClick={closeSettings}
                  >
                    Batal
                  </button>
                  <button
                    type="button"
                    className="sheet-tab-action settings-modal-ok"
                    onClick={confirmSettings}
                  >
                    OK
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}
