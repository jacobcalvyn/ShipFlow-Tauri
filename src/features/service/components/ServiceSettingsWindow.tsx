import { useEffect, useMemo, useState } from "react";
import { ServiceConfig, ServiceMode, TrackingSource } from "../../../types";
import type { ServiceSettingsNotice } from "../useServiceSettingsController";

type ServiceSettingsWindowProps = {
  serviceConfig: ServiceConfig;
  hasPendingServiceConfigChanges: boolean;
  onPreviewServiceEnabled: (enabled: boolean) => void;
  onPreviewServiceMode: (mode: ServiceMode) => void;
  onPreviewServicePort: (port: number) => void;
  onPreviewTrackingSource: (trackingSource: TrackingSource) => void;
  onPreviewExternalApiBaseUrl: (baseUrl: string) => void;
  onPreviewExternalApiAuthToken: (token: string) => void;
  onPreviewAllowInsecureExternalApiHttp: (enabled: boolean) => void;
  onGenerateServiceToken: () => void;
  onRegenerateServiceToken: () => void;
  onCopyServiceEndpoint: (endpoint: string) => void;
  onCopyServiceToken: (token: string) => void;
  onTestExternalTrackingSource: (config: ServiceConfig) => Promise<string>;
  onConfirmSettings: () => Promise<boolean> | boolean;
  onCancelSettings: () => void;
  onShowNotice?: (notice: ServiceSettingsNotice) => void;
};

export function ServiceSettingsWindow({
  serviceConfig,
  hasPendingServiceConfigChanges,
  onPreviewServiceEnabled,
  onPreviewServiceMode,
  onPreviewServicePort,
  onPreviewTrackingSource,
  onPreviewExternalApiBaseUrl,
  onPreviewExternalApiAuthToken,
  onPreviewAllowInsecureExternalApiHttp,
  onGenerateServiceToken,
  onRegenerateServiceToken,
  onCopyServiceEndpoint,
  onCopyServiceToken,
  onTestExternalTrackingSource,
  onConfirmSettings,
  onCancelSettings,
  onShowNotice,
}: ServiceSettingsWindowProps) {
  const [activeView, setActiveView] = useState<"runtime" | "api">("runtime");
  const [isTokenVisible, setIsTokenVisible] = useState(false);
  const [isExternalApiTokenVisible, setIsExternalApiTokenVisible] = useState(false);
  const [isRegenerateTokenArmed, setIsRegenerateTokenArmed] = useState(false);
  const [isTestingExternalApi, setIsTestingExternalApi] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [externalApiTestResult, setExternalApiTestResult] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [portDraft, setPortDraft] = useState(String(serviceConfig.port));

  useEffect(() => {
    setPortDraft(String(serviceConfig.port));
  }, [serviceConfig.port]);

  useEffect(() => {
    setExternalApiTestResult(null);
  }, [
    serviceConfig.trackingSource,
    serviceConfig.externalApiBaseUrl,
    serviceConfig.externalApiAuthToken,
  ]);

  const normalizedPort = Number.parseInt(portDraft, 10);
  const isPortValid =
    Number.isInteger(normalizedPort) && normalizedPort >= 1 && normalizedPort <= 65535;

  const serviceGuideBaseUrl = useMemo(() => {
    if (serviceConfig.mode === "local") {
      return `http://127.0.0.1:${serviceConfig.port}`;
    }

    return `http://<device-ip>:${serviceConfig.port}`;
  }, [serviceConfig.mode, serviceConfig.port]);

  const handlePortDraftChange = (value: string) => {
    setPortDraft(value);
    const nextPort = Number.parseInt(value, 10);
    if (Number.isInteger(nextPort) && nextPort >= 1 && nextPort <= 65535) {
      onPreviewServicePort(nextPort);
    }
  };

  const handleTestExternalTrackingSource = async () => {
    setIsTestingExternalApi(true);
    setExternalApiTestResult(null);

    try {
      const message = await onTestExternalTrackingSource(serviceConfig);
      setExternalApiTestResult({
        tone: "success",
        message,
      });
    } catch (error) {
      setExternalApiTestResult({
        tone: "error",
        message: error instanceof Error ? error.message : "Gagal menguji koneksi API eksternal.",
      });
    } finally {
      setIsTestingExternalApi(false);
    }
  };

  const handleReset = () => {
    setIsTokenVisible(false);
    setIsExternalApiTokenVisible(false);
    setIsRegenerateTokenArmed(false);
    setIsTestingExternalApi(false);
    setExternalApiTestResult(null);
    onCancelSettings();
  };

  const handleSave = async () => {
    setIsSaving(true);

    try {
      const didSave = await onConfirmSettings();
      if (didSave !== false) {
        setIsRegenerateTokenArmed(false);
        onShowNotice?.({
          tone: "success",
          message: "Pengaturan service tersimpan.",
        });
      }
    } catch (error) {
      onShowNotice?.({
        tone: "error",
        message: error instanceof Error ? error.message : "Gagal menyimpan pengaturan service.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const activeViewTitle = activeView === "runtime" ? "Runtime Internal" : "API Endpoint";
  const activeViewDescription =
    activeView === "runtime"
      ? "Pilih sumber tracking utama yang dipakai oleh service lokal."
      : "Atur endpoint lokal, mode jaringan, dan token autentikasi untuk klien lain.";

  return (
    <main className="shell service-settings-shell display-scale-small">
      <section className="sheet-panel service-settings-panel">
        <div className="sheet-head service-settings-head">
          <div className="service-settings-title">
            <span className="muted-label">Service</span>
            <h2>ShipFlow Service</h2>
            <p>Konfigurasi runtime tracking dan endpoint lokal untuk integrasi desktop.</p>
          </div>
        </div>

        <div className="service-settings-workbench">
          <div
            className="service-settings-tabs"
            role="tablist"
            aria-label="Service sections"
            aria-orientation="vertical"
          >
            <button
              type="button"
              id="service-settings-runtime-tab"
              role="tab"
              aria-selected={activeView === "runtime"}
              className={[
                "service-settings-tab",
                activeView === "runtime" ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setActiveView("runtime")}
            >
              Runtime Internal
            </button>
            <button
              type="button"
              id="service-settings-api-tab"
              role="tab"
              aria-selected={activeView === "api"}
              className={[
                "service-settings-tab",
                activeView === "api" ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setActiveView("api")}
            >
              API
            </button>
            {hasPendingServiceConfigChanges ? (
              <div className="service-settings-sidebar-note" role="status" aria-live="polite">
                Ada perubahan lokal yang belum disimpan.
              </div>
            ) : null}
          </div>

          <div className="service-settings-layout">
            <div className="service-settings-section-header">
              <h3>{activeViewTitle}</h3>
              <p>{activeViewDescription}</p>
            </div>
            <section
              className={[
                "settings-pane",
                "service-settings-pane",
                activeView === "runtime" ? "" : "is-hidden",
              ]
                .filter(Boolean)
                .join(" ")}
              role="tabpanel"
              aria-labelledby="service-settings-runtime-tab"
              hidden={activeView !== "runtime"}
            >
              <div className="service-settings-stack">
                <div className="settings-field-block">
                  <span className="settings-input-label">Sumber</span>
                  <div
                    className="settings-radio-group service-settings-segmented-group"
                    role="radiogroup"
                    aria-label="Sumber Tracking"
                  >
                    <label className="settings-radio-option service-settings-segmented-option">
                      <input
                        type="radio"
                        name="tracking-source"
                        checked={serviceConfig.trackingSource === "default"}
                        onChange={() => onPreviewTrackingSource("default")}
                      />
                      <span className="settings-radio-text">Internal ShipFlow</span>
                    </label>
                    <label className="settings-radio-option service-settings-segmented-option">
                      <input
                        type="radio"
                        name="tracking-source"
                        checked={serviceConfig.trackingSource === "externalApi"}
                        onChange={() => onPreviewTrackingSource("externalApi")}
                      />
                      <span className="settings-radio-text">API ShipFlow Eksternal</span>
                    </label>
                  </div>
                </div>

                {serviceConfig.trackingSource === "externalApi" ? (
                  <>
                    <label className="settings-text-field">
                      <span className="settings-input-label">Base URL</span>
                      <input
                        type="url"
                        aria-label="External API Base URL"
                        value={serviceConfig.externalApiBaseUrl}
                        onChange={(event) => onPreviewExternalApiBaseUrl(event.target.value)}
                      />
                    </label>
                    <label className="settings-text-field">
                      <span className="settings-input-label">Token</span>
                      <input
                        type={isExternalApiTokenVisible ? "text" : "password"}
                        aria-label="External API Bearer Token"
                        value={serviceConfig.externalApiAuthToken}
                        placeholder="Bearer token dari instance ShipFlow lain"
                        onChange={(event) => onPreviewExternalApiAuthToken(event.target.value)}
                      />
                    </label>
                    <div className="settings-inline-actions service-settings-field-actions">
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={() => setIsExternalApiTokenVisible((current) => !current)}
                      >
                        {isExternalApiTokenVisible ? "Sembunyikan" : "Tampilkan"}
                      </button>
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={handleTestExternalTrackingSource}
                        disabled={
                          isTestingExternalApi ||
                          !serviceConfig.externalApiBaseUrl.trim() ||
                          !serviceConfig.externalApiAuthToken.trim()
                        }
                      >
                        {isTestingExternalApi ? "Testing..." : "Tes"}
                      </button>
                    </div>
                    <label className="settings-checkbox-option">
                      <input
                        type="checkbox"
                        checked={serviceConfig.allowInsecureExternalApiHttp}
                        onChange={(event) =>
                          onPreviewAllowInsecureExternalApiHttp(event.currentTarget.checked)
                        }
                      />
                      <span>Izinkan HTTP non-TLS</span>
                    </label>
                    <div className="settings-field-help settings-field-help-warning">
                      Aktifkan HTTP non-TLS hanya kalau endpoint memang tidak mendukung HTTPS.
                    </div>
                    {externalApiTestResult ? (
                      <div
                        className={[
                          "settings-field-help",
                          `settings-field-help-${externalApiTestResult.tone}`,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        role="status"
                        aria-live="polite"
                      >
                        {externalApiTestResult.message}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </section>

            <section
              className={[
                "settings-pane",
                "service-settings-pane",
                activeView === "api" ? "" : "is-hidden",
              ]
                .filter(Boolean)
                .join(" ")}
              role="tabpanel"
              aria-labelledby="service-settings-api-tab"
              hidden={activeView !== "api"}
            >
              <div className="service-settings-stack">
                <label className="settings-checkbox-option service-settings-checkbox-row">
                  <input
                    type="checkbox"
                    aria-label="Buka Akses API Eksternal"
                    checked={serviceConfig.enabled}
                    onChange={(event) => onPreviewServiceEnabled(event.currentTarget.checked)}
                  />
                  <span>Buka akses API eksternal</span>
                </label>

                <div className="settings-field-block">
                  <span className="settings-input-label">Mode</span>
                  <div
                    className="settings-radio-group service-settings-segmented-group"
                    role="radiogroup"
                    aria-label="Mode Akses API"
                  >
                    <label className="settings-radio-option service-settings-segmented-option">
                      <input
                        type="radio"
                        name="service-mode"
                        checked={serviceConfig.mode === "local"}
                        onChange={() => onPreviewServiceMode("local")}
                      />
                      <span className="settings-radio-text">Localhost Saja</span>
                    </label>
                    <label className="settings-radio-option service-settings-segmented-option">
                      <input
                        type="radio"
                        name="service-mode"
                        checked={serviceConfig.mode === "lan"}
                        onChange={() => onPreviewServiceMode("lan")}
                      />
                      <span className="settings-radio-text">LAN / Jaringan Lokal</span>
                    </label>
                  </div>
                </div>

                <div className="service-settings-inline-grid">
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
                </div>
                {!isPortValid ? (
                  <div className="settings-field-help settings-field-help-error">
                    Port must be between 1 and 65535.
                  </div>
                ) : null}

                {serviceConfig.mode === "lan" ? (
                  <div className="settings-field-help settings-field-help-warning">
                    LAN membuka endpoint ke perangkat lain dalam jaringan yang sama.
                  </div>
                ) : null}

                <div className="service-settings-field-row">
                  <label className="settings-text-field service-settings-token-field">
                    <span className="settings-input-label">Token</span>
                    <input
                      type={isTokenVisible ? "text" : "password"}
                      readOnly
                      aria-label="Token API"
                      value={serviceConfig.authToken}
                      placeholder="Generate token"
                    />
                  </label>
                  <div className="settings-inline-actions service-settings-field-actions">
                    <button
                      type="button"
                      className="sheet-tab-action"
                      onClick={() => setIsTokenVisible((current) => !current)}
                    >
                      {isTokenVisible ? "Sembunyikan" : "Tampilkan"}
                    </button>
                    <button
                      type="button"
                      className="sheet-tab-action"
                      onClick={() => onCopyServiceToken(serviceConfig.authToken)}
                      disabled={!serviceConfig.authToken}
                    >
                      Copy
                    </button>
                    {serviceConfig.authToken ? (
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={() => {
                          if (!isRegenerateTokenArmed) {
                            setIsRegenerateTokenArmed(true);
                            return;
                          }

                          setIsRegenerateTokenArmed(false);
                          onRegenerateServiceToken();
                        }}
                      >
                        {isRegenerateTokenArmed ? "Konfirmasi" : "Regenerate"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={onGenerateServiceToken}
                      >
                        Generate
                      </button>
                    )}
                  </div>
                </div>

                <div className="service-settings-endpoint-row">
                  <div className="service-settings-endpoint-field">
                    <span className="settings-input-label">Endpoint</span>
                    <code className="service-settings-endpoint-code">{serviceGuideBaseUrl}</code>
                  </div>
                  <button
                    type="button"
                    className="sheet-tab-action"
                    onClick={() => onCopyServiceEndpoint(serviceGuideBaseUrl)}
                  >
                    Copy Endpoint
                  </button>
                </div>
              </div>

              {hasPendingServiceConfigChanges ? (
                <div className="settings-field-help settings-field-help-info">
                  Perubahan belum diterapkan. Klik Simpan untuk menyimpan.
                </div>
              ) : null}
            </section>
          </div>
        </div>

        <div className="settings-modal-footer service-settings-footer">
          <button
            type="button"
            className="sheet-tab-action settings-modal-cancel"
            onClick={handleReset}
            disabled={isSaving}
          >
            Reset Perubahan
          </button>
          <button
            type="button"
            className="sheet-tab-action settings-modal-ok"
            onClick={() => {
              void handleSave();
            }}
            disabled={!isPortValid || isSaving}
          >
            {isSaving ? "Menyimpan..." : "Simpan"}
          </button>
        </div>
      </section>
    </main>
  );
}
