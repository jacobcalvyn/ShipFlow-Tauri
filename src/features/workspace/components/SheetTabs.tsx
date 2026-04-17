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
  onDuplicateSheet: (sheetId: string) => void;
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

type SettingsSection = "display" | "service";

export function SheetTabs({
  tabs,
  activeSheetId,
  displayScale,
  serviceConfig,
  serviceStatus,
  hasPendingServiceConfigChanges,
  onActivateSheet,
  onCreateSheet,
  onDuplicateSheet,
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
  const [hoveredSheetId, setHoveredSheetId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("display");
  const [isTokenVisible, setIsTokenVisible] = useState(false);
  const [portDraft, setPortDraft] = useState(String(serviceConfig.port));
  const settingsModalRef = useRef<HTMLDivElement | null>(null);
  const hoveredSheetTimeoutRef = useRef<number | null>(null);
  const sheetTabRefs = useRef(new Map<string, HTMLDivElement | null>());

  useEffect(() => {
    if (editingSheetId && editingSheetId !== activeSheetId) {
      setEditingSheetId(null);
      setSheetNameDraft("");
    }
  }, [activeSheetId, editingSheetId]);

  useEffect(() => {
    return () => {
      if (hoveredSheetTimeoutRef.current !== null) {
        window.clearTimeout(hoveredSheetTimeoutRef.current);
      }
    };
  }, []);

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
          settingsSection === "display"
            ? 'input[name="display-scale"]:checked, input[name="display-scale"]'
            : 'input[name="service-mode"]:checked, input[name="service-mode"], input[type="checkbox"], input[type="number"]'
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
  }, [displayScale, isSettingsOpen, settingsSection]);

  useEffect(() => {
    if (!isSettingsOpen) {
      setIsTokenVisible(false);
      setPortDraft(String(serviceConfig.port));
      setSettingsSection("display");
    }
  }, [isSettingsOpen, serviceConfig.port]);

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

  const openSettings = () => {
    setIsTokenVisible(false);
    setPortDraft(String(serviceConfig.port));
    setSettingsSection("display");
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
    if (hoveredSheetTimeoutRef.current !== null) {
      window.clearTimeout(hoveredSheetTimeoutRef.current);
      hoveredSheetTimeoutRef.current = null;
    }
    setHoveredSheetId(sheetId);
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

  const serviceGuideBaseUrl = useMemo(() => {
    if (serviceStatus.status === "running" && serviceStatus.bindAddress && serviceStatus.port) {
      return `http://${serviceStatus.bindAddress}:${serviceStatus.port}`;
    }

    if (serviceConfig.mode === "local") {
      return `http://127.0.0.1:${serviceConfig.port}`;
    }

    return `http://<device-ip>:${serviceConfig.port}`;
  }, [serviceConfig.mode, serviceConfig.port, serviceStatus]);

  const handlePortDraftChange = (value: string) => {
    setPortDraft(value);
    const nextPort = Number.parseInt(value, 10);
    if (Number.isInteger(nextPort) && nextPort >= 1 && nextPort <= 65535) {
      onPreviewServicePort(nextPort);
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

  return (
    <section className="sheet-tabs-panel" aria-label="Sheet tabs">
      <div className="sheet-tabs-list" role="tablist" aria-label="Workspace sheets">
        {tabs.map((tab) => {
          const isEditing = editingSheetId === tab.id;
          const isHovered = hoveredSheetId === tab.id;

          return (
            <div
              key={tab.id}
              className={[
                "sheet-tab",
                tab.isActive ? "sheet-tab-active" : "",
                isEditing ? "sheet-tab-editing" : "",
                isHovered ? "sheet-tab-hovered" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              ref={(element) => {
                sheetTabRefs.current.set(tab.id, element);
              }}
              onMouseEnter={() => activateHoveredSheet(tab.id)}
              onMouseLeave={scheduleClearHoveredSheet}
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
        <button
          type="button"
          className="sheet-tab-add-button"
          onClick={handleCreateSheet}
          disabled={isRenaming}
          aria-label="Sheet Baru"
          title="Sheet Baru"
        >
          <span className="sheet-tab-add-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path strokeLinecap="round" d="M10 4.5v11" />
              <path strokeLinecap="round" d="M4.5 10h11" />
            </svg>
          </span>
        </button>
      </div>
      <div className="sheet-tabs-actions">
        <div className="sheet-settings-popover">
          {serviceConfig.enabled ? (
            <span
              className={[
                "sheet-service-indicator",
                `is-${serviceStatus.status}`,
              ].join(" ")}
              aria-label={`API Service ${serviceStatusLabel}`}
              title={`API Service ${serviceStatusLabel}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="4" y="5" width="16" height="6" rx="2" />
                <rect x="4" y="13" width="16" height="6" rx="2" />
                <path strokeLinecap="round" d="M8 8h.01M8 16h.01M12 8h4M12 16h4" />
              </svg>
            </span>
          ) : null}
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
        </div>
      </div>
      {hoveredSheetId && hoveredSheetMenuStyle && !editingSheetId
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
                <div className="settings-layout">
                  <aside className="settings-sidebar" aria-label="Setting sections">
                    <button
                      type="button"
                      className={[
                        "settings-nav-button",
                        settingsSection === "display" ? "is-active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => setSettingsSection("display")}
                    >
                      Tampilan
                    </button>
                    <button
                      type="button"
                      className={[
                        "settings-nav-button",
                        settingsSection === "service" ? "is-active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => setSettingsSection("service")}
                    >
                      API Service
                    </button>
                  </aside>

                  <div className="settings-content">
                    {settingsSection === "display" ? (
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
                    ) : (
                      <section className="settings-pane">
                        <div className="settings-pane-header">
                          <h4>API Service</h4>
                          <p>
                            Aktifkan endpoint lokal atau LAN agar aplikasi lain bisa memakai
                            engine tracking dari app desktop ini.
                          </p>
                        </div>

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

                        <div className="settings-field-block">
                          <span className="settings-input-label">Service Mode</span>
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
                        </div>

                        <label className="settings-text-field settings-text-field-port">
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

                        <div className="settings-api-guide">
                          <div className="settings-api-guide-header">
                            <span className="settings-service-status-label">Panduan API</span>
                          </div>
                          <div className="settings-api-guide-row">
                            <span className="settings-api-guide-key">Base URL</span>
                            <code className="settings-api-guide-code">{serviceGuideBaseUrl}</code>
                          </div>
                          <div className="settings-api-guide-row">
                            <span className="settings-api-guide-key">Auth</span>
                            <span className="settings-service-status-meta">
                              Gunakan header{" "}
                              <code className="settings-api-guide-inline">
                                Authorization: Bearer &lt;token&gt;
                              </code>{" "}
                              untuk semua endpoint selain <code>/health</code>.
                            </span>
                          </div>
                          <div className="settings-api-guide-endpoints">
                            <div className="settings-api-guide-endpoint">
                              <code className="settings-api-guide-code">GET /health</code>
                              <span className="settings-service-status-meta">
                                Health check tanpa auth.
                              </span>
                            </div>
                            <div className="settings-api-guide-endpoint">
                              <code className="settings-api-guide-code">GET /status</code>
                              <span className="settings-service-status-meta">
                                Status runtime service dengan auth bearer.
                              </span>
                            </div>
                            <div className="settings-api-guide-endpoint">
                              <code className="settings-api-guide-code">
                                GET /track/:shipment_id
                              </code>
                              <span className="settings-service-status-meta">
                                Ambil JSON tracking untuk satu ID kiriman.
                              </span>
                            </div>
                          </div>
                          {serviceConfig.mode === "lan" ? (
                            <div className="settings-field-help settings-field-help-info">
                              Untuk LAN API, ganti <code>&lt;device-ip&gt;</code> dengan IP mesin
                              yang menjalankan app ini.
                            </div>
                          ) : null}
                        </div>
                      </section>
                    )}
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
