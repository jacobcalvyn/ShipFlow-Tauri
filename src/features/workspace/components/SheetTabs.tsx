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
import { DesktopServiceConnectionPanel } from "./DesktopServiceConnectionPanel";
import { SheetFileMenu } from "./SheetFileMenu";

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
  settingsOpenRequestToken?: number;
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
  onPreviewDesktopServiceUrl?: (url: string) => void;
  onPreviewDesktopServiceAuthToken?: (token: string) => void;
  onPasteDesktopServiceAuthToken?: () => Promise<void> | void;
  onGenerateServiceToken: () => void;
  onRegenerateServiceToken: () => void;
  onCopyServiceEndpoint?: (endpoint: string) => void;
  onCopyServiceToken?: (token: string) => void;
  onTestApiServiceConnection?: (config: ServiceConfig) => Promise<string>;
  onTestExternalTrackingSource?: (config: ServiceConfig) => Promise<string>;
  onConfirmSettings: () => Promise<boolean> | boolean;
  onCancelSettings: () => void;
  isSelectionDragActive?: boolean;
  selectionDragSourceSheetId?: string | null;
  onDropSelectionToSheet?: (sheetId: string, mode: "copy" | "move") => void;
  onDropSelectionToNewSheet?: (mode: "copy" | "move") => void;
};

type SheetDropTransferMode = "copy" | "move";
type DesktopSettingsTab = "display" | "service";

const DEFAULT_DESKTOP_SERVICE_PORT = 18422;

function parseDesktopServicePortDraft(serviceUrl: string) {
  try {
    const parsedUrl = new URL(serviceUrl);
    const port = parsedUrl.port
      ? Number.parseInt(parsedUrl.port, 10)
      : DEFAULT_DESKTOP_SERVICE_PORT;
    return String(port);
  } catch {
    return String(DEFAULT_DESKTOP_SERVICE_PORT);
  }
}

function buildDesktopServiceUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

function resolveDropTransferMode(
  event: Pick<
    ReactDragEvent<HTMLElement>,
    "altKey" | "ctrlKey" | "metaKey" | "dataTransfer"
  >
): SheetDropTransferMode {
  const platform = (() => {
    if (typeof navigator === "undefined") {
      return "";
    }

    const navigatorWithUserAgentData = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };

    return (
      navigatorWithUserAgentData.userAgentData?.platform ??
      navigator.platform ??
      ""
    ).toLowerCase();
  })();

  if (event.dataTransfer.dropEffect === "copy") {
    return "copy";
  }

  if (platform.includes("mac")) {
    return event.altKey ? "copy" : "move";
  }

  if (platform.includes("win")) {
    return event.ctrlKey ? "copy" : "move";
  }

  if (event.altKey || event.ctrlKey) {
    return "copy";
  }

  return "move";
}

export function SheetTabs({
  tabs,
  activeSheetId,
  displayScale,
  settingsOpenRequestToken = 0,
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
  onPreviewDesktopServiceUrl = () => {},
  onPreviewDesktopServiceAuthToken = () => {},
  onPasteDesktopServiceAuthToken = () => {},
  onGenerateServiceToken,
  onRegenerateServiceToken,
  onCopyServiceEndpoint = () => {},
  onCopyServiceToken = () => {},
  onTestApiServiceConnection = async () => "",
  onTestExternalTrackingSource = async () => "",
  onConfirmSettings,
  onCancelSettings,
  isSelectionDragActive = false,
  selectionDragSourceSheetId = null,
  onDropSelectionToSheet,
  onDropSelectionToNewSheet,
}: SheetTabsProps) {
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [sheetNameDraft, setSheetNameDraft] = useState("");
  const [deleteArmedSheetId, setDeleteArmedSheetId] = useState<string | null>(null);
  const [openSheetMenuSheetId, setOpenSheetMenuSheetId] = useState<string | null>(null);
  const [sheetMenuPosition, setSheetMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<DesktopSettingsTab>("display");
  const [isConfirmingSettings, setIsConfirmingSettings] = useState(false);
  const [isDesktopTokenVisible, setIsDesktopTokenVisible] = useState(false);
  const [isTestingServiceConnection, setIsTestingServiceConnection] = useState(false);
  const [desktopServicePortDraft, setDesktopServicePortDraft] = useState(() =>
    parseDesktopServicePortDraft(serviceConfig.desktopServiceUrl)
  );
  const [serviceConnectionTestResult, setServiceConnectionTestResult] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [dropTargetSheetId, setDropTargetSheetId] = useState<string | null>(null);
  const [dropTargetMode, setDropTargetMode] = useState<SheetDropTransferMode>("move");
  const [isAddButtonDropActive, setIsAddButtonDropActive] = useState(false);
  const settingsModalRef = useRef<HTMLDivElement | null>(null);
  const sheetMenuRef = useRef<HTMLDivElement | null>(null);
  const fileMenuTimeoutRef = useRef<number | null>(null);
  const fileMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (editingSheetId && !tabs.some((tab) => tab.id === editingSheetId)) {
      setEditingSheetId(null);
      setSheetNameDraft("");
    }
  }, [editingSheetId, tabs]);

  useEffect(() => {
    return () => {
      if (fileMenuTimeoutRef.current !== null) {
        window.clearTimeout(fileMenuTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setDesktopServicePortDraft(parseDesktopServicePortDraft(serviceConfig.desktopServiceUrl));
  }, [serviceConfig.desktopServiceUrl]);

  useEffect(() => {
    if (!isSelectionDragActive) {
      setDropTargetSheetId(null);
      setDropTargetMode("move");
      setIsAddButtonDropActive(false);
      return;
    }

    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    setDeleteArmedSheetId(null);
  }, [isSelectionDragActive]);

  useEffect(() => {
    if (!isFileMenuOpen) {
      return;
    }

    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    setDeleteArmedSheetId(null);
  }, [isFileMenuOpen]);

  useEffect(() => {
    if (!openSheetMenuSheetId) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (sheetMenuRef.current?.contains(target)) {
        return;
      }

      setOpenSheetMenuSheetId(null);
      setSheetMenuPosition(null);
      setDeleteArmedSheetId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenSheetMenuSheetId(null);
        setSheetMenuPosition(null);
        setDeleteArmedSheetId(null);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openSheetMenuSheetId]);

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
    if (settingsOpenRequestToken === 0) {
      return;
    }

    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    setDeleteArmedSheetId(null);
    setIsFileMenuOpen(false);
    setActiveSettingsTab("display");
    setIsSettingsOpen(true);
  }, [settingsOpenRequestToken]);

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
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
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
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    setDeleteArmedSheetId(null);
  };

  const handleActivateSheet = (sheetId: string) => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    onActivateSheet(sheetId);
  };

  const canDeleteSheet = tabs.length > 1;
  const isRenaming = editingSheetId !== null;

  const handleCreateSheet = () => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    onCancelSettings();
    setIsSettingsOpen(false);
    onCreateSheet();
  };

  const handleDuplicateSheet = (sheetId: string) => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
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
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    setDeleteArmedSheetId(null);
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
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
    setDeleteArmedSheetId(null);
    setActiveSettingsTab("display");
    setIsSettingsOpen(true);
  };

  const handleTestServiceConnection = async () => {
    setIsTestingServiceConnection(true);
    setServiceConnectionTestResult(null);

    try {
      const message = await onTestApiServiceConnection(serviceConfig);
      setServiceConnectionTestResult({
        tone: "success",
        message,
      });
    } catch (error) {
      setServiceConnectionTestResult({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Gagal menguji koneksi ShipFlow Service.",
      });
    } finally {
      setIsTestingServiceConnection(false);
    }
  };

  const normalizedDesktopServicePort = Number.parseInt(desktopServicePortDraft, 10);
  const isDesktopServicePortValid =
    Number.isInteger(normalizedDesktopServicePort) &&
    normalizedDesktopServicePort >= 1 &&
    normalizedDesktopServicePort <= 65535;

  const handleDesktopServicePortDraftChange = (value: string) => {
    setDesktopServicePortDraft(value);
    setServiceConnectionTestResult(null);

    const nextPort = Number.parseInt(value, 10);
    if (Number.isInteger(nextPort) && nextPort >= 1 && nextPort <= 65535) {
      onPreviewDesktopServiceUrl(buildDesktopServiceUrl(nextPort));
    }
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

  const openSheetMenu = (
    sheetId: string,
    options?: {
      clientPosition?: { left: number; top: number };
    }
  ) => {
    const menuWidth = 188;
    const viewportPadding = 12;
    const left = options?.clientPosition
      ? Math.min(
          Math.max(viewportPadding, options.clientPosition.left),
          window.innerWidth - menuWidth - viewportPadding
        )
      : viewportPadding;
    const top = options?.clientPosition
      ? Math.min(options.clientPosition.top, window.innerHeight - viewportPadding)
      : viewportPadding;

    setDeleteArmedSheetId(null);
    setOpenSheetMenuSheetId(sheetId);
    setSheetMenuPosition({
      top,
      left,
    });
  };

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
    setOpenSheetMenuSheetId(null);
    setSheetMenuPosition(null);
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
                  isDropTarget ? "is-drop-target" : "",
                  isDropTarget && dropTargetMode === "copy" ? "is-drop-copy" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
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
                  <div className="sheet-tab-main">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab.isActive}
                      className="sheet-tab-button"
                      onClick={() => handleActivateSheet(tab.id)}
                      onContextMenu={(event) => {
                        if (isSelectionDragActive || isEditing) {
                          return;
                        }

                        event.preventDefault();
                        openSheetMenu(tab.id, {
                          clientPosition: {
                            left: event.clientX,
                            top: event.clientY,
                          },
                        });
                      }}
                      title={tab.name}
                    >
                      <span className="sheet-tab-label">{tab.name}</span>
                    </button>
                  </div>
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
      {openSheetMenuSheetId &&
      sheetMenuPosition &&
      !editingSheetId &&
      !isSelectionDragActive
        ? createPortal(
            <div
              ref={sheetMenuRef}
              className="sheet-tab-hover-menu"
              style={{
                top: sheetMenuPosition.top,
                left: sheetMenuPosition.left,
              }}
              role="menu"
              aria-label={`${
                tabs.find((tab) => tab.id === openSheetMenuSheetId)?.name ?? "Sheet"
              } actions`}
            >
              <button
                type="button"
                className="sheet-tab-hover-menu-button"
                role="menuitem"
                onClick={() => handleDuplicateSheet(openSheetMenuSheetId)}
                disabled={isRenaming}
              >
                Duplikat
              </button>
              <button
                type="button"
                className="sheet-tab-hover-menu-button"
                role="menuitem"
                onClick={() => beginRename(openSheetMenuSheetId)}
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
                onClick={() => handleDeleteSheet(openSheetMenuSheetId)}
                disabled={!canDeleteSheet || isRenaming}
              >
                {deleteArmedSheetId === openSheetMenuSheetId
                  ? "Konfirmasi Hapus"
                  : "Hapus"}
              </button>
            </div>,
            document.body
          )
        : null}
      <SheetFileMenu
        isOpen={isFileMenuOpen}
        style={fileMenuStyle}
        recentDocuments={recentDocuments}
        canUseAutosave={canUseAutosave}
        isAutosaveEnabled={isAutosaveEnabled}
        onMouseEnter={openFileMenu}
        onMouseLeave={scheduleCloseFileMenu}
        onAction={handleFileAction}
        onCreateDocument={onCreateDocument}
        onOpenDocument={onOpenDocument}
        onSaveDocument={onSaveDocument}
        onSaveDocumentAs={onSaveDocumentAs}
        onCreateDocumentWindow={onCreateDocumentWindow}
        onOpenDocumentInNewWindow={onOpenDocumentInNewWindow}
        onOpenRecentDocument={onOpenRecentDocument}
        onToggleAutosave={onToggleAutosave}
      />
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
                <div className="settings-layout settings-layout-tabs">
                  <div className="settings-sidebar" role="tablist" aria-label="Setting">
                    <button
                      type="button"
                      id="desktop-settings-display-tab"
                      className={[
                        "settings-nav-button",
                        activeSettingsTab === "display" ? "is-active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      role="tab"
                      aria-selected={activeSettingsTab === "display"}
                      aria-controls="desktop-settings-display-panel"
                      onClick={() => setActiveSettingsTab("display")}
                    >
                      Ukuran Tampilan
                    </button>
                    <button
                      type="button"
                      id="desktop-settings-service-tab"
                      className={[
                        "settings-nav-button",
                        activeSettingsTab === "service" ? "is-active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      role="tab"
                      aria-selected={activeSettingsTab === "service"}
                      aria-controls="desktop-settings-service-panel"
                      onClick={() => setActiveSettingsTab("service")}
                    >
                      Koneksi Service
                    </button>
                  </div>
                  <div className="settings-content">
                    {activeSettingsTab === "display" ? (
                      <section
                        id="desktop-settings-display-panel"
                        className="settings-pane"
                        role="tabpanel"
                        aria-labelledby="desktop-settings-display-tab"
                      >
                        <div className="settings-pane-header">
                          <h4>Ukuran Tampilan</h4>
                          <p>Pilih ukuran workspace sesuai kenyamanan kerja di desktop.</p>
                        </div>
                        <div
                          className="settings-scale-options"
                          role="radiogroup"
                          aria-label="Ukuran Tampilan"
                        >
                          <button
                            type="button"
                            className={[
                              "settings-scale-option",
                              displayScale === "small" ? "is-active" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            role="radio"
                            aria-checked={displayScale === "small"}
                            onClick={() => onPreviewDisplayScale("small")}
                          >
                            Kecil
                          </button>
                          <button
                            type="button"
                            className={[
                              "settings-scale-option",
                              displayScale === "medium" ? "is-active" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            role="radio"
                            aria-checked={displayScale === "medium"}
                            onClick={() => onPreviewDisplayScale("medium")}
                          >
                            Sedang
                          </button>
                          <button
                            type="button"
                            className={[
                              "settings-scale-option",
                              displayScale === "large" ? "is-active" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            role="radio"
                            aria-checked={displayScale === "large"}
                            onClick={() => onPreviewDisplayScale("large")}
                          >
                            Besar
                          </button>
                        </div>
                      </section>
                    ) : null}
                    {activeSettingsTab === "service" ? (
                      <section
                        id="desktop-settings-service-panel"
                        role="tabpanel"
                        aria-labelledby="desktop-settings-service-tab"
                      >
                        <DesktopServiceConnectionPanel
                          serviceConfig={serviceConfig}
                          desktopServicePortDraft={desktopServicePortDraft}
                          isDesktopServicePortValid={isDesktopServicePortValid}
                          isDesktopTokenVisible={isDesktopTokenVisible}
                          isTestingServiceConnection={isTestingServiceConnection}
                          serviceConnectionTestResult={serviceConnectionTestResult}
                          onDesktopServicePortDraftChange={handleDesktopServicePortDraftChange}
                          onPreviewDesktopServiceAuthToken={onPreviewDesktopServiceAuthToken}
                          onClearConnectionTestResult={() => setServiceConnectionTestResult(null)}
                          onToggleDesktopTokenVisibility={() =>
                            setIsDesktopTokenVisible((current) => !current)
                          }
                          onCopyServiceToken={onCopyServiceToken}
                          onPasteDesktopServiceAuthToken={onPasteDesktopServiceAuthToken}
                          onTestServiceConnection={handleTestServiceConnection}
                        />
                      </section>
                    ) : null}
                  </div>
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
                    disabled={isConfirmingSettings || !isDesktopServicePortValid}
                  >
                    {isConfirmingSettings ? "Menyimpan..." : "Simpan"}
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
