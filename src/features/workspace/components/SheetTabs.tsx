import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiServiceStatus, ServiceConfig, ServiceMode } from "../../../types";

type SheetTabItem = {
  id: string;
  name: string;
  isActive: boolean;
};

type SheetTabsProps = {
  tabs: SheetTabItem[];
  activeSheetId: string;
  displayScale: "small" | "medium" | "large";
  serviceConfig: ServiceConfig;
  serviceStatus: ApiServiceStatus;
  hasPendingServiceConfigChanges: boolean;
  onActivateSheet: (sheetId: string) => void;
  onCreateSheet: () => void;
  onDuplicateActiveSheet: () => void;
  onRenameSheet: (sheetId: string, name: string) => void;
  onDeleteSheet: (sheetId: string) => void;
  onPreviewDisplayScale: (scale: "small" | "medium" | "large") => void;
  onPreviewServiceEnabled: (enabled: boolean) => void;
  onPreviewServiceMode: (mode: ServiceMode) => void;
  onPreviewServicePort: (port: number) => void;
  onGenerateServiceToken: () => void;
  onRegenerateServiceToken: () => void;
  onConfirmSettings: () => void;
  onCancelSettings: () => void;
};

export function SheetTabs({
  tabs,
  activeSheetId,
  displayScale,
  serviceConfig,
  serviceStatus,
  hasPendingServiceConfigChanges,
  onActivateSheet,
  onCreateSheet,
  onDuplicateActiveSheet,
  onRenameSheet,
  onDeleteSheet,
  onPreviewDisplayScale,
  onPreviewServiceEnabled,
  onPreviewServiceMode,
  onPreviewServicePort,
  onGenerateServiceToken,
  onRegenerateServiceToken,
  onConfirmSettings,
  onCancelSettings,
}: SheetTabsProps) {
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeSheetId) ?? tabs[0] ?? null,
    [activeSheetId, tabs]
  );
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [sheetNameDraft, setSheetNameDraft] = useState("");
  const [deleteArmedSheetId, setDeleteArmedSheetId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTokenVisible, setIsTokenVisible] = useState(false);
  const [portDraft, setPortDraft] = useState(String(serviceConfig.port));
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

  useEffect(() => {
    if (!isSettingsOpen) {
      setIsTokenVisible(false);
      setPortDraft(String(serviceConfig.port));
    }
  }, [isSettingsOpen, serviceConfig.port]);

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
    onCancelSettings();
    setIsSettingsOpen(false);
    onCreateSheet();
  };

  const handleDuplicateSheet = () => {
    setDeleteArmedSheetId(null);
    setEditingSheetId(null);
    setSheetNameDraft("");
    onCancelSettings();
    setIsSettingsOpen(false);
    onDuplicateActiveSheet();
  };

  const closeSettings = () => {
    onCancelSettings();
    setIsSettingsOpen(false);
  };

  const openSettings = () => {
    setIsTokenVisible(false);
    setPortDraft(String(serviceConfig.port));
    setIsSettingsOpen(true);
  };

  const confirmSettings = () => {
    onConfirmSettings();
    setIsSettingsOpen(false);
  };

  const normalizedPort = Number.parseInt(portDraft, 10);
  const isPortValid =
    Number.isInteger(normalizedPort) && normalizedPort >= 1 && normalizedPort <= 65535;

  const serviceStatusLabel = useMemo(() => {
    switch (serviceStatus.status) {
      case "running":
        return "Running";
      case "error":
        return "Error";
      default:
        return "Stopped";
    }
  }, [serviceStatus.status]);

  const handlePortDraftChange = (value: string) => {
    setPortDraft(value);
    const nextPort = Number.parseInt(value, 10);
    if (Number.isInteger(nextPort) && nextPort >= 1 && nextPort <= 65535) {
      onPreviewServicePort(nextPort);
    }
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
                <div className="settings-form-group">
                  <div className="settings-modal-field-label">API Service</div>
                  <label className="settings-checkbox-option">
                    <input
                      type="checkbox"
                      checked={serviceConfig.enabled}
                      onChange={(event) =>
                        onPreviewServiceEnabled(event.currentTarget.checked)
                      }
                    />
                    <span>Enable API Service</span>
                  </label>

                  <div
                    className="settings-radio-group"
                    role="radiogroup"
                    aria-label="Service Mode"
                  >
                    <label className="settings-radio-option">
                      <input
                        type="radio"
                        name="service-mode"
                        checked={serviceConfig.mode === "local"}
                        onChange={() => onPreviewServiceMode("local")}
                      />
                      <span className="settings-radio-text">Local API</span>
                    </label>
                    <label className="settings-radio-option">
                      <input
                        type="radio"
                        name="service-mode"
                        checked={serviceConfig.mode === "lan"}
                        onChange={() => onPreviewServiceMode("lan")}
                      />
                      <span className="settings-radio-text">LAN API</span>
                    </label>
                  </div>

                  <label className="settings-text-field">
                    <span className="settings-input-label">Port</span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      inputMode="numeric"
                      aria-label="Port"
                      value={portDraft}
                      onChange={(event) => handlePortDraftChange(event.target.value)}
                    />
                  </label>
                  {!isPortValid ? (
                    <div className="settings-field-help settings-field-help-error">
                      Port must be between 1 and 65535.
                    </div>
                  ) : null}

                  <label className="settings-text-field">
                    <span className="settings-input-label">Auth Token</span>
                    <input
                      type={isTokenVisible ? "text" : "password"}
                      readOnly
                      aria-label="Auth Token"
                      value={serviceConfig.authToken}
                      placeholder="Generate token from the app"
                    />
                  </label>
                  <div className="settings-inline-actions">
                    <button
                      type="button"
                      className="sheet-tab-action"
                      onClick={() => setIsTokenVisible((current) => !current)}
                    >
                      {isTokenVisible ? "Hide Token" : "Reveal Token"}
                    </button>
                    {serviceConfig.authToken ? (
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={onRegenerateServiceToken}
                      >
                        Regenerate Token
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={onGenerateServiceToken}
                      >
                        Generate Token
                      </button>
                    )}
                  </div>
                  {serviceConfig.mode === "lan" ? (
                    <div className="settings-field-help settings-field-help-warning">
                      LAN API exposes the service to other devices on the same network.
                    </div>
                  ) : null}

                  {hasPendingServiceConfigChanges ? (
                    <div className="settings-field-help settings-field-help-info">
                      Perubahan API service belum diterapkan. Klik OK untuk menyimpan.
                    </div>
                  ) : null}

                  <div className="settings-service-status" role="status" aria-live="polite">
                    <div className="settings-service-status-row">
                      <span className="settings-service-status-label">Runtime Status</span>
                      <span
                        className={[
                          "settings-service-status-badge",
                          `is-${serviceStatus.status}`,
                        ].join(" ")}
                      >
                        {serviceStatusLabel}
                      </span>
                    </div>
                    <div className="settings-service-status-meta">
                      {serviceStatus.bindAddress && serviceStatus.port
                        ? `${serviceStatus.bindAddress}:${serviceStatus.port}`
                        : "Service belum aktif."}
                    </div>
                    {serviceStatus.mode ? (
                      <div className="settings-service-status-meta">
                        Mode: {serviceStatus.mode === "lan" ? "LAN API" : "Local API"}
                      </div>
                    ) : null}
                    {serviceStatus.errorMessage ? (
                      <div className="settings-field-help settings-field-help-error">
                        {serviceStatus.errorMessage}
                      </div>
                    ) : null}
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
                    disabled={!isPortValid}
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
