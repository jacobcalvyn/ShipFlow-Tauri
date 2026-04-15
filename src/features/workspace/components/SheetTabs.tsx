import { FormEvent, useEffect, useMemo, useState } from "react";

type SheetTabItem = {
  id: string;
  name: string;
  isActive: boolean;
};

type SheetTabsProps = {
  tabs: SheetTabItem[];
  activeSheetId: string;
  onActivateSheet: (sheetId: string) => void;
  onCreateSheet: () => void;
  onDuplicateActiveSheet: () => void;
  onRenameSheet: (sheetId: string, name: string) => void;
  onDeleteSheet: (sheetId: string) => void;
};

export function SheetTabs({
  tabs,
  activeSheetId,
  onActivateSheet,
  onCreateSheet,
  onDuplicateActiveSheet,
  onRenameSheet,
  onDeleteSheet,
}: SheetTabsProps) {
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeSheetId) ?? tabs[0] ?? null,
    [activeSheetId, tabs]
  );
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [sheetNameDraft, setSheetNameDraft] = useState("");
  const [deleteArmedSheetId, setDeleteArmedSheetId] = useState<string | null>(null);

  useEffect(() => {
    if (editingSheetId && editingSheetId !== activeSheetId) {
      setEditingSheetId(null);
      setSheetNameDraft("");
    }
  }, [activeSheetId, editingSheetId]);

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
    onCreateSheet();
  };

  const handleDuplicateSheet = () => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    onDuplicateActiveSheet();
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
      </div>
    </section>
  );
}
