import {
  DragEvent as ReactDragEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ApiServiceStatus,
  ServiceConfig,
  ServiceMode,
  TrackingSource,
} from "../../../types";

type SheetTabItem = {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  isActive: boolean;
};

type SheetTabsProps = {
  tabs: SheetTabItem[];
  activeSheetId: string;
  displayScale: "small" | "medium" | "large";
  recentDocuments?: Array<{ path: string; name: string }>;
  canUseAutosave?: boolean;
  isAutosaveEnabled?: boolean;
  serviceConfig: ServiceConfig;
  serviceStatus: ApiServiceStatus;
  hasPendingServiceConfigChanges: boolean;
  onToggleAutosave?: () => void;
  onCreateDocument?: () => void;
  onOpenDocument?: () => void;
  onSaveDocument?: () => void;
  onSaveDocumentAs?: () => void;
  onCreateDocumentWindow?: () => void;
  onOpenDocumentInNewWindow?: () => void;
  onOpenRecentDocument?: (path: string) => void;
  onOpenServiceSettings?: () => void;
  onActivateSheet: (sheetId: string) => void;
  onCreateSheet: () => void;
  onDuplicateSheet: (sheetId: string) => void;
  onRenameSheet: (sheetId: string, name: string) => void;
  onDeleteSheet: (sheetId: string) => void;
  onPreviewDisplayScale: (scale: "small" | "medium" | "large") => void;
  onPreviewServiceEnabled: (enabled: boolean) => void;
  onPreviewServiceMode: (mode: ServiceMode) => void;
  onPreviewServicePort: (port: number) => void;
  onPreviewServiceKeepRunningInTray?: (enabled: boolean) => void;
  onPreviewTrackingSource?: (trackingSource: TrackingSource) => void;
  onPreviewExternalApiBaseUrl?: (baseUrl: string) => void;
  onPreviewExternalApiAuthToken?: (token: string) => void;
  onPreviewAllowInsecureExternalApiHttp?: (enabled: boolean) => void;
  onGenerateServiceToken: () => void;
  onRegenerateServiceToken: () => void;
  onCopyServiceEndpoint?: (endpoint: string) => void;
  onCopyServiceToken?: (token: string) => void;
  onTestExternalTrackingSource?: (config: ServiceConfig) => Promise<string>;
  onConfirmSettings: () => Promise<boolean> | boolean;
  onCancelSettings: () => void;
  isSelectionDragActive?: boolean;
  selectionDragSourceSheetId?: string | null;
  onDropSelectionToSheet?: (sheetId: string, mode: "copy" | "move") => void;
  onDropSelectionToNewSheet?: (mode: "copy" | "move") => void;
};

type SheetDropTransferMode = "copy" | "move";

function resolveDropTransferMode(
  event: Pick<
    ReactDragEvent<HTMLElement>,
    "altKey" | "ctrlKey" | "metaKey" | "dataTransfer"
  >
): SheetDropTransferMode {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.dataTransfer.dropEffect === "copy"
  ) {
    return "copy";
  }

  return "move";
}

export function SheetTabs({
  tabs,
  activeSheetId,
  displayScale,
  recentDocuments = [],
  canUseAutosave = false,
  isAutosaveEnabled = false,
  serviceConfig,
  serviceStatus,
  onToggleAutosave = () => {},
  onCreateDocument = () => {},
  onOpenDocument = () => {},
  onSaveDocument = () => {},
  onSaveDocumentAs = () => {},
  onCreateDocumentWindow = () => {},
  onOpenDocumentInNewWindow = () => {},
  onOpenRecentDocument = () => {},
  onOpenServiceSettings = () => {},
  onActivateSheet,
  onCreateSheet,
  onDuplicateSheet,
  onRenameSheet,
  onDeleteSheet,
  onPreviewDisplayScale,
  onPreviewServiceEnabled,
  onPreviewServiceMode,
  onPreviewServicePort,
  onPreviewServiceKeepRunningInTray = () => {},
  onPreviewTrackingSource = () => {},
  onPreviewExternalApiBaseUrl = () => {},
  onPreviewExternalApiAuthToken = () => {},
  onPreviewAllowInsecureExternalApiHttp = () => {},
  onGenerateServiceToken,
  onRegenerateServiceToken,
  onCopyServiceEndpoint = () => {},
  onCopyServiceToken = () => {},
  onTestExternalTrackingSource = async () => "",
  onConfirmSettings,
  onCancelSettings,
  isSelectionDragActive = false,
  selectionDragSourceSheetId = null,
  onDropSelectionToSheet,
  onDropSelectionToNewSheet,
}: SheetTabsProps) {
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeSheetId) ?? tabs[0] ?? null,
    [activeSheetId, tabs]
  );
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [sheetNameDraft, setSheetNameDraft] = useState("");
  const [deleteArmedSheetId, setDeleteArmedSheetId] = useState<string | null>(null);
  const [hoveredSheetId, setHoveredSheetId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isConfirmingSettings, setIsConfirmingSettings] = useState(false);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [dropTargetSheetId, setDropTargetSheetId] = useState<string | null>(null);
  const [dropTargetMode, setDropTargetMode] = useState<SheetDropTransferMode>("move");
  const [isAddButtonDropActive, setIsAddButtonDropActive] = useState(false);
  const settingsModalRef = useRef<HTMLDivElement | null>(null);
  const hoveredSheetTimeoutRef = useRef<number | null>(null);
  const fileMenuTimeoutRef = useRef<number | null>(null);
  const fileMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sheetTabRefs = useRef(new Map<string, HTMLDivElement | null>());

  useEffect(() => {
    if (editingSheetId && !tabs.some((tab) => tab.id === editingSheetId)) {
      setEditingSheetId(null);
      setSheetNameDraft("");
    }
  }, [editingSheetId, tabs]);

  useEffect(() => {
    return () => {
      if (hoveredSheetTimeoutRef.current !== null) {
        window.clearTimeout(hoveredSheetTimeoutRef.current);
      }
      if (fileMenuTimeoutRef.current !== null) {
        window.clearTimeout(fileMenuTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isSelectionDragActive) {
      setDropTargetSheetId(null);
      setDropTargetMode("move");
      setIsAddButtonDropActive(false);
      return;
    }

    setHoveredSheetId(null);
    setDeleteArmedSheetId(null);
  }, [isSelectionDragActive]);

  useEffect(() => {
    if (!isFileMenuOpen) {
      return;
    }

    setHoveredSheetId(null);
    setDeleteArmedSheetId(null);
  }, [isFileMenuOpen]);

  useEffect(() => {
    if (!isFileMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (target instanceof Element && target.closest(".sheet-file-menu-panel")) {
        return;
      }

      if (fileMenuTriggerRef.current?.contains(target)) {
        return;
      }

      setIsFileMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFileMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFileMenuOpen]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    setIsFileMenuOpen(false);
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const modal = settingsModalRef.current;
    const focusableSelectors =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const firstTarget =
        modal?.querySelector<HTMLElement>(
          'input[name="display-scale"]:checked, input[name="display-scale"]'
        ) ??
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
  }, [isSettingsOpen]);

  const beginRename = (sheetId: string) => {
    const targetTab = tabs.find((tab) => tab.id === sheetId);
    if (!targetTab) {
      return;
    }

    setDeleteArmedSheetId(null);
    setHoveredSheetId(null);
    setEditingSheetId(targetTab.id);
    setSheetNameDraft(targetTab.name);
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

  const handleDeleteSheet = (sheetId: string) => {
    const targetTab = tabs.find((tab) => tab.id === sheetId);
    if (!targetTab) {
      return;
    }

    if (deleteArmedSheetId !== targetTab.id) {
      setDeleteArmedSheetId(targetTab.id);
      setEditingSheetId(null);
      return;
    }

    onDeleteSheet(targetTab.id);
    setHoveredSheetId(null);
    setDeleteArmedSheetId(null);
  };

  const handleActivateSheet = (sheetId: string) => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setHoveredSheetId(null);
    onActivateSheet(sheetId);
  };

  const canDeleteSheet = tabs.length > 1;
  const isRenaming = editingSheetId !== null;

  const handleCreateSheet = () => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    onCancelSettings();
    setIsSettingsOpen(false);
    onCreateSheet();
  };

  const handleDuplicateSheet = (sheetId: string) => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    setHoveredSheetId(null);
    onCancelSettings();
    setIsSettingsOpen(false);
    onDuplicateSheet(sheetId);
  };

  const closeSettings = () => {
    onCancelSettings();
    setIsSettingsOpen(false);
  };

  const openFileMenu = () => {
    if (fileMenuTimeoutRef.current !== null) {
      window.clearTimeout(fileMenuTimeoutRef.current);
      fileMenuTimeoutRef.current = null;
    }
    setIsFileMenuOpen(true);
  };

  const scheduleCloseFileMenu = () => {
    if (fileMenuTimeoutRef.current !== null) {
      window.clearTimeout(fileMenuTimeoutRef.current);
    }
    fileMenuTimeoutRef.current = window.setTimeout(() => {
      setIsFileMenuOpen(false);
      fileMenuTimeoutRef.current = null;
    }, 120);
  };

  const handleFileAction = (action: () => void) => {
    setIsFileMenuOpen(false);
    action();
  };

  const openSettings = () => {
    setIsFileMenuOpen(false);
    setIsSettingsOpen(true);
  };

  const clearHoveredSheet = () => {
    if (hoveredSheetTimeoutRef.current !== null) {
      window.clearTimeout(hoveredSheetTimeoutRef.current);
      hoveredSheetTimeoutRef.current = null;
    }
    setHoveredSheetId(null);
  };

  const scheduleClearHoveredSheet = () => {
    if (hoveredSheetTimeoutRef.current !== null) {
      window.clearTimeout(hoveredSheetTimeoutRef.current);
    }
    hoveredSheetTimeoutRef.current = window.setTimeout(() => {
      setHoveredSheetId(null);
      hoveredSheetTimeoutRef.current = null;
    }, 120);
  };

  const activateHoveredSheet = (sheetId: string) => {
    if (isSelectionDragActive) {
      return;
    }

    if (hoveredSheetTimeoutRef.current !== null) {
      window.clearTimeout(hoveredSheetTimeoutRef.current);
      hoveredSheetTimeoutRef.current = null;
    }
    setHoveredSheetId(sheetId);
  };

  const confirmSettings = async () => {
    setIsConfirmingSettings(true);

    try {
      const didConfirm = await onConfirmSettings();
      if (didConfirm !== false) {
        setIsSettingsOpen(false);
      }
    } finally {
      setIsConfirmingSettings(false);
    }
  };

  const hoveredSheetMenuStyle = useMemo(() => {
    if (!hoveredSheetId || editingSheetId) {
      return null;
    }

    const target = sheetTabRefs.current.get(hoveredSheetId);
    if (!target) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    return {
      top: rect.bottom + 6,
      left: rect.left,
    };
  }, [editingSheetId, hoveredSheetId, tabs, activeSheetId]);

  const apiAccessStatusLabel = useMemo(() => {
    switch (serviceStatus.status) {
      case "running":
        return "Terbuka";
      case "error":
        return "Bermasalah";
      default:
        return "Tertutup";
    }
  }, [serviceStatus.status]);

  const fileMenuStyle = useMemo(() => {
    if (!isFileMenuOpen) {
      return null;
    }

    const trigger = fileMenuTriggerRef.current;
    if (!trigger) {
      return null;
    }

    const rect = trigger.getBoundingClientRect();
    const menuWidth = displayScale === "large" ? 304 : displayScale === "medium" ? 288 : 272;
    const viewportPadding = 12;
    const left = Math.min(
      Math.max(viewportPadding, rect.right - menuWidth),
      window.innerWidth - menuWidth - viewportPadding
    );
    const top = Math.min(rect.bottom + 8, window.innerHeight - viewportPadding);
    return {
      top,
      left,
      width: menuWidth,
      maxWidth: `calc(100vw - ${viewportPadding * 2}px)`,
    } as const;
  }, [displayScale, isFileMenuOpen]);

  const handleSheetDropHover = (
    event: ReactDragEvent<HTMLDivElement>,
    targetSheetId: string
  ) => {
    if (
      !isSelectionDragActive ||
      !onDropSelectionToSheet ||
      targetSheetId === selectionDragSourceSheetId
    ) {
      return;
    }

    event.preventDefault();
    const nextMode = resolveDropTransferMode(event);
    event.dataTransfer.dropEffect = nextMode;
    setDropTargetSheetId(targetSheetId);
    setDropTargetMode(nextMode);
    setHoveredSheetId(null);
  };

  const clearSheetDropHover = (event: ReactDragEvent<HTMLDivElement>, targetSheetId: string) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    if (dropTargetSheetId === targetSheetId) {
      setDropTargetSheetId(null);
    }
  };

  const handleDropOnSheet = (
    event: ReactDragEvent<HTMLDivElement>,
    targetSheetId: string
  ) => {
    if (
      !isSelectionDragActive ||
      !onDropSelectionToSheet ||
      targetSheetId === selectionDragSourceSheetId
    ) {
      return;
    }

    event.preventDefault();
    onDropSelectionToSheet(targetSheetId, resolveDropTransferMode(event));
    setDropTargetSheetId(null);
    setIsAddButtonDropActive(false);
  };

  const handleAddButtonDropHover = (event: ReactDragEvent<HTMLButtonElement>) => {
    if (!isSelectionDragActive || !onDropSelectionToNewSheet) {
      return;
    }

    event.preventDefault();
    const nextMode = resolveDropTransferMode(event);
    event.dataTransfer.dropEffect = nextMode;
    setDropTargetSheetId(null);
    setDropTargetMode(nextMode);
    setIsAddButtonDropActive(true);
  };

  const handleDropOnAddButton = (event: ReactDragEvent<HTMLButtonElement>) => {
    if (!isSelectionDragActive || !onDropSelectionToNewSheet) {
      return;
    }

    event.preventDefault();
    onDropSelectionToNewSheet(resolveDropTransferMode(event));
    setDropTargetSheetId(null);
    setIsAddButtonDropActive(false);
  };

  return (
    <section
      className={["sheet-tabs-panel", `display-scale-${displayScale}`].join(" ")}
      aria-label="Sheet tabs"
    >
      <div className="sheet-tabs-bar">
        <div className="sheet-tabs-list" role="tablist" aria-label="Workspace sheets">
          {tabs.map((tab) => {
            const isEditing = editingSheetId === tab.id;
            const isHovered = hoveredSheetId === tab.id;
            const isDropTarget =
              isSelectionDragActive &&
              dropTargetSheetId === tab.id &&
              tab.id !== selectionDragSourceSheetId;

            return (
              <div
                key={tab.id}
                className={[
                  "sheet-tab",
                  tab.isActive ? "sheet-tab-active" : "",
                  isEditing ? "sheet-tab-editing" : "",
                  isHovered ? "sheet-tab-hovered" : "",
                  isDropTarget ? "is-drop-target" : "",
                  isDropTarget && dropTargetMode === "copy" ? "is-drop-copy" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                ref={(element) => {
                  sheetTabRefs.current.set(tab.id, element);
                }}
                onMouseEnter={() => activateHoveredSheet(tab.id)}
                onMouseLeave={scheduleClearHoveredSheet}
                onDragEnter={(event) => handleSheetDropHover(event, tab.id)}
                onDragOver={(event) => handleSheetDropHover(event, tab.id)}
                onDragLeave={(event) => clearSheetDropHover(event, tab.id)}
                onDrop={(event) => handleDropOnSheet(event, tab.id)}
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
                    title={tab.name}
                  >
                    <span className="sheet-tab-label">{tab.name}</span>
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className={[
              "sheet-tab-add-button",
              isSelectionDragActive && isAddButtonDropActive ? "is-drop-target" : "",
              isSelectionDragActive &&
              isAddButtonDropActive &&
              dropTargetMode === "copy"
                ? "is-drop-copy"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={handleCreateSheet}
            disabled={isRenaming}
            aria-label="Sheet Baru"
            title={
              isSelectionDragActive
                ? "Drop di sini untuk buat sheet baru. Tahan Alt/Option saat drop untuk salin."
                : "Sheet Baru"
            }
            onDragEnter={handleAddButtonDropHover}
            onDragOver={handleAddButtonDropHover}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                return;
              }

              setIsAddButtonDropActive(false);
            }}
            onDrop={handleDropOnAddButton}
          >
            <span className="sheet-tab-add-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
                <path strokeLinecap="round" d="M12 5v14" />
                <path strokeLinecap="round" d="M5 12h14" />
              </svg>
            </span>
          </button>
        </div>
        <div className="sheet-tabs-actions">
          <div className="sheet-settings-popover">
            <button
              type="button"
              className={[
                "sheet-tab-action",
                "sheet-tab-action-icon-only",
                "tool-popover-trigger",
                isSettingsOpen ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={openSettings}
              aria-label="Setting"
              title="Setting"
            >
              <span className="action-button-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10.325 4.317a1.724 1.724 0 0 1 3.35 0 1.724 1.724 0 0 0 2.573 1.066 1.724 1.724 0 0 1 2.898 1.675 1.724 1.724 0 0 0 .536 2.704 1.724 1.724 0 0 1 0 2.976 1.724 1.724 0 0 0-.536 2.704 1.724 1.724 0 0 1-2.898 1.675 1.724 1.724 0 0 0-2.573 1.066 1.724 1.724 0 0 1-3.35 0 1.724 1.724 0 0 0-2.573-1.066 1.724 1.724 0 0 1-2.898-1.675 1.724 1.724 0 0 0-.536-2.704 1.724 1.724 0 0 1 0-2.976 1.724 1.724 0 0 0 .536-2.704 1.724 1.724 0 0 1 2.898-1.675 1.724 1.724 0 0 0 2.573-1.066Z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z" />
                </svg>
              </span>
            </button>
            <div
              className="sheet-file-menu"
              onMouseEnter={openFileMenu}
              onMouseLeave={scheduleCloseFileMenu}
            >
              <button
                type="button"
                ref={fileMenuTriggerRef}
                className={[
                  "sheet-tab-action",
                  "sheet-file-menu-trigger",
                  isFileMenuOpen ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-haspopup="menu"
                aria-expanded={isFileMenuOpen}
                aria-label="File"
                onClick={openFileMenu}
              >
                File
              </button>
            </div>
          </div>
        </div>
      </div>
      {isSelectionDragActive ? (
        <div className="sheet-transfer-drop-hint" role="status" aria-live="polite">
          Drop ke tab untuk pindah. Tahan Alt/Option saat drop untuk salin. Drop ke tombol
          tambah untuk sheet baru.
        </div>
      ) : null}
      {hoveredSheetId &&
      hoveredSheetMenuStyle &&
      !editingSheetId &&
      !isSelectionDragActive
        ? createPortal(
            <div
              className="sheet-tab-hover-menu"
              style={{
                top: hoveredSheetMenuStyle.top,
                left: hoveredSheetMenuStyle.left,
              }}
              role="menu"
              aria-label={`${
                tabs.find((tab) => tab.id === hoveredSheetId)?.name ?? "Sheet"
              } actions`}
              onMouseEnter={() => activateHoveredSheet(hoveredSheetId)}
              onMouseLeave={scheduleClearHoveredSheet}
            >
              <button
                type="button"
                className="sheet-tab-hover-menu-button"
                role="menuitem"
                onClick={() => handleDuplicateSheet(hoveredSheetId)}
                disabled={isRenaming}
              >
                Duplikat
              </button>
              <button
                type="button"
                className="sheet-tab-hover-menu-button"
                role="menuitem"
                onClick={() => beginRename(hoveredSheetId)}
              >
                Ganti Nama
              </button>
              <button
                type="button"
                className={[
                  "sheet-tab-hover-menu-button",
                  "is-danger",
                ].join(" ")}
                role="menuitem"
                onClick={() => handleDeleteSheet(hoveredSheetId)}
                disabled={!canDeleteSheet || isRenaming}
              >
                {deleteArmedSheetId === hoveredSheetId
                  ? "Konfirmasi Hapus"
                  : "Hapus"}
              </button>
            </div>,
            document.body
          )
        : null}
      {isFileMenuOpen && fileMenuStyle
        ? createPortal(
            <div
              className="sheet-file-menu-panel"
              style={fileMenuStyle}
              role="menu"
              aria-label="File"
              onMouseEnter={openFileMenu}
              onMouseLeave={scheduleCloseFileMenu}
            >
              <div className="sheet-file-menu-section">
                <button
                  type="button"
                  className="sheet-file-menu-button"
                  role="menuitem"
                  onClick={() => handleFileAction(onCreateDocument)}
                >
                  Baru
                </button>
                <button
                  type="button"
                  className="sheet-file-menu-button"
                  role="menuitem"
                  onClick={() => handleFileAction(onOpenDocument)}
                >
                  Buka
                </button>
                <button
                  type="button"
                  className="sheet-file-menu-button"
                  role="menuitem"
                  onClick={() => handleFileAction(onSaveDocument)}
                >
                  Simpan
                </button>
                <button
                  type="button"
                  className="sheet-file-menu-button"
                  role="menuitem"
                  onClick={() => handleFileAction(onSaveDocumentAs)}
                >
                  Simpan Sebagai
                </button>
                <button
                  type="button"
                  className="sheet-file-menu-button"
                  role="menuitem"
                  onClick={() => handleFileAction(onCreateDocumentWindow)}
                >
                  Jendela Baru
                </button>
                <button
                  type="button"
                  className="sheet-file-menu-button"
                  role="menuitem"
                  onClick={() => handleFileAction(onOpenDocumentInNewWindow)}
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
                      onClick={() => handleFileAction(() => onOpenRecentDocument(document.path))}
                    >
                      {document.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}
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
                <div className="settings-content settings-content-single">
                  <section className="settings-pane">
                    <div className="settings-pane-header">
                      <h4>Ukuran Tampilan</h4>
                      <p>Pilih ukuran workspace sesuai kenyamanan kerja di desktop.</p>
                    </div>
                    <div
                      className="settings-option-list"
                      role="radiogroup"
                      aria-label="Ukuran Tampilan"
                    >
                      <label className="settings-option-row">
                        <div className="settings-option-main">
                          <input
                            type="radio"
                            name="display-scale"
                            checked={displayScale === "small"}
                            onChange={() => onPreviewDisplayScale("small")}
                          />
                          <div>
                            <div className="settings-option-title">Kecil</div>
                            <div className="settings-option-description">
                              Layout paling rapat untuk melihat lebih banyak data sekaligus.
                            </div>
                          </div>
                        </div>
                      </label>
                      <label className="settings-option-row">
                        <div className="settings-option-main">
                          <input
                            type="radio"
                            name="display-scale"
                            checked={displayScale === "medium"}
                            onChange={() => onPreviewDisplayScale("medium")}
                          />
                          <div>
                            <div className="settings-option-title">Sedang</div>
                            <div className="settings-option-description">
                              Keseimbangan antara kepadatan tabel dan keterbacaan.
                            </div>
                          </div>
                        </div>
                      </label>
                      <label className="settings-option-row">
                        <div className="settings-option-main">
                          <input
                            type="radio"
                            name="display-scale"
                            checked={displayScale === "large"}
                            onChange={() => onPreviewDisplayScale("large")}
                          />
                          <div>
                            <div className="settings-option-title">Besar</div>
                            <div className="settings-option-description">
                              Tampilan lebih lega untuk jarak pandang yang santai.
                            </div>
                          </div>
                        </div>
                      </label>
                    </div>
                  </section>
                  <section className="settings-pane">
                    <div className="settings-pane-header">
                      <h4>Service</h4>
                      <p>
                        Sumber data tracking ShipFlow Desktop dikelola oleh app ShipFlow Service.
                      </p>
                    </div>
                    <div className="settings-service-status" role="status" aria-live="polite">
                      <div className="settings-service-status-row">
                        <span className="settings-service-status-label">API Eksternal</span>
                        <span
                          className={[
                            "settings-service-status-badge",
                            `is-${serviceStatus.status}`,
                          ].join(" ")}
                        >
                          {apiAccessStatusLabel}
                        </span>
                      </div>
                      <div className="settings-service-status-meta">
                        Pengaturan runtime tracking dan akses API eksternal dikelola di
                        ShipFlow Service.
                      </div>
                    </div>
                    <div className="settings-inline-actions">
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={onOpenServiceSettings}
                      >
                        Buka ShipFlow Service
                      </button>
                    </div>
                  </section>
                </div>
                <div className="settings-modal-footer">
                  <button
                    type="button"
                    className="sheet-tab-action settings-modal-cancel"
                    onClick={closeSettings}
                    disabled={isConfirmingSettings}
                  >
                    Batal
                  </button>
                  <button
                    type="button"
                    className="sheet-tab-action settings-modal-ok"
                    onClick={() => {
                      void confirmSettings();
                    }}
                    disabled={isConfirmingSettings}
                  >
                    {isConfirmingSettings ? "Menyimpan..." : "OK"}
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
