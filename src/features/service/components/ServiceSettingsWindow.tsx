import { useEffect, useMemo, useState } from "react";
import type { ServiceConfig, ServiceMode, TrackingSource } from "../../../types";
import type { ServiceSettingsNotice } from "../useServiceSettingsController";

type ServiceSettingsWindowProps = {
  activeView: "runtime" | "api";
  serviceConfig: ServiceConfig;
  hasPendingServiceConfigChanges: boolean;
  onPreviewServiceMode: (mode: ServiceMode) => void;
  onPreviewServicePort: (port: number) => void;
  onPreviewKeepRunningInTray: (enabled: boolean) => void;
  onPreviewStartAtLogin: (enabled: boolean) => void;
  onPreviewTrackingSource: (trackingSource: TrackingSource) => void;
  onPreviewExternalApiBaseUrl: (baseUrl: string) => void;
  onPreviewExternalApiAuthToken: (token: string) => void;
  onPreviewAllowInsecureExternalApiHttp: (enabled: boolean) => void;
  onGenerateServiceToken: () => void;
  onRegenerateServiceToken: () => void;
  onCopyServiceEndpoint: (endpoint: string) => void;
  onCopyServiceToken: () => void;
  onTestExternalTrackingSource: (config: ServiceConfig) => Promise<string>;
  onConfirmSettings: () => Promise<boolean> | boolean;
  onCancelSettings: () => void;
  onShowNotice?: (notice: ServiceSettingsNotice) => void;
};

export function ServiceSettingsWindow({
  activeView,
  serviceConfig,
  hasPendingServiceConfigChanges,
  onPreviewServiceMode,
  onPreviewServicePort,
  onPreviewKeepRunningInTray,
  onPreviewStartAtLogin,
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
    Number.isInteger(normalizedPort) && normalizedPort >= 1 && normalizedPort <= 65_535;
  const serviceEndpoint = useMemo(
    () => `http://127.0.0.1:${serviceConfig.port}`,
    [serviceConfig.port],
  );

  const handlePortDraftChange = (value: string) => {
    setPortDraft(value);
    const nextPort = Number.parseInt(value, 10);
    if (Number.isInteger(nextPort) && nextPort >= 1 && nextPort <= 65_535) {
      onPreviewServicePort(nextPort);
    }
  };

  const handleTestExternalTrackingSource = async () => {
    setIsTestingExternalApi(true);
    setExternalApiTestResult(null);
    try {
      const message = await onTestExternalTrackingSource(serviceConfig);
      setExternalApiTestResult({ tone: "success", message });
    } catch (error) {
      setExternalApiTestResult({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gagal menguji koneksi API eksternal.",
      });
    } finally {
      setIsTestingExternalApi(false);
    }
  };

  const handleReset = () => {
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
        onShowNotice?.({ tone: "success", message: "Pengaturan service tersimpan." });
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

  return (
    <>
      <div className="service-settings-layout">
            <div className="service-settings-section-header">
              <h3>{activeView === "runtime" ? "Sumber Lacak" : "API Publik"}</h3>
              <p>
                {activeView === "runtime"
                  ? "Pilih scrap internal atau API eksternal sebagai sumber data service."
                  : "Atur akses API untuk klien pihak ketiga. Desktop memakai koneksi internal otomatis."}
              </p>
            </div>

            <section
              id="service-settings-runtime-panel"
              className={`settings-pane service-settings-pane ${activeView === "runtime" ? "" : "is-hidden"}`}
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
                      <span className="settings-input-label">URL Dasar</span>
                      <input
                        type="url"
                        aria-label="URL Dasar API Eksternal"
                        value={serviceConfig.externalApiBaseUrl}
                        onChange={(event) => onPreviewExternalApiBaseUrl(event.target.value)}
                      />
                    </label>
                    <label className="settings-text-field">
                      <span className="settings-input-label">Token</span>
                      <input
                        type={isExternalApiTokenVisible ? "text" : "password"}
                        aria-label="Token API Eksternal"
                        value={serviceConfig.externalApiAuthToken}
                        placeholder={
                          serviceConfig.externalApiAuthTokenConfigured
                            ? "Token tersimpan; isi untuk mengganti"
                            : "Token API dari instance ShipFlow lain"
                        }
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
                          (!serviceConfig.externalApiAuthToken.trim() &&
                            !serviceConfig.externalApiAuthTokenConfigured)
                        }
                      >
                        {isTestingExternalApi ? "Menguji..." : "Tes Koneksi"}
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
                      <span>Izinkan HTTP atau host privat tepercaya</span>
                    </label>
                    <div className="settings-field-help settings-field-help-warning">
                      Aktifkan hanya untuk deployment LAN tepercaya. Endpoint metadata dan localhost tetap ditolak.
                    </div>
                    {externalApiTestResult ? (
                      <div
                        className={`settings-field-help settings-field-help-${externalApiTestResult.tone}`}
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
              id="service-settings-api-panel"
              className={`settings-pane service-settings-pane ${activeView === "api" ? "" : "is-hidden"}`}
              role="tabpanel"
              aria-labelledby="service-settings-api-tab"
              hidden={activeView !== "api"}
            >
              <div className="service-settings-stack">
                <div className="settings-field-help settings-field-help-info">
                  Token di bawah hanya untuk aplikasi pihak ketiga. ShipFlow Desktop tidak memakai atau menampilkan token internalnya.
                </div>

                <div className="settings-field-block">
                  <span className="settings-input-label">Siklus Aplikasi</span>
                  <div className="service-settings-network-stack">
                    <label className="settings-checkbox-option service-settings-checkbox-row">
                      <input
                        type="checkbox"
                        aria-label="Biarkan ShipFlow Service tetap aktif di menu bar / system tray"
                        checked={serviceConfig.keepRunningInTray}
                        onChange={(event) =>
                          onPreviewKeepRunningInTray(event.currentTarget.checked)
                        }
                      />
                      <span>Biarkan ShipFlow tetap aktif di menu bar / system tray</span>
                    </label>
                    <label className="settings-checkbox-option service-settings-checkbox-row">
                      <input
                        type="checkbox"
                        aria-label="Jalankan ShipFlow Service saat login"
                        checked={serviceConfig.startAtLogin}
                        onChange={(event) =>
                          onPreviewStartAtLogin(event.currentTarget.checked)
                        }
                      />
                      <span>Jalankan ShipFlow otomatis saat login</span>
                    </label>
                  </div>
                </div>

                <div className="settings-field-block">
                  <span className="settings-input-label">Akses Jaringan</span>
                  <div className="service-settings-network-stack">
                    <div className="service-settings-always-on-row">
                      <span className="service-settings-always-on-dot" aria-hidden="true" />
                      <span className="settings-radio-text">Localhost aktif untuk Desktop</span>
                    </div>
                    <label className="settings-checkbox-option service-settings-checkbox-row">
                      <input
                        type="checkbox"
                        aria-label="LAN / Jaringan Lokal"
                        checked={serviceConfig.mode === "lan"}
                        onChange={(event) =>
                          onPreviewServiceMode(event.currentTarget.checked ? "lan" : "local")
                        }
                      />
                      <span>Izinkan akses LAN / jaringan lokal</span>
                    </label>
                  </div>
                </div>

                <div className="service-settings-inline-grid">
                  <label className="settings-text-field settings-text-field-port">
                    <span className="settings-input-label">Port</span>
                    <input
                      type="number"
                      min={1}
                      max={65_535}
                      inputMode="numeric"
                      aria-label="Port"
                      value={portDraft}
                      onChange={(event) => handlePortDraftChange(event.target.value)}
                    />
                  </label>
                </div>
                {!isPortValid ? (
                  <div className="settings-field-help settings-field-help-error">
                    Port harus di antara 1 dan 65535.
                  </div>
                ) : null}

                {serviceConfig.mode === "lan" ? (
                  <div className="settings-field-help settings-field-help-warning">
                    LAN membuka API publik ke perangkat lain dalam jaringan yang sama. Desktop tetap memakai localhost.
                  </div>
                ) : null}

                <div className="service-settings-field-row">
                  <label className="settings-text-field service-settings-token-field">
                    <span className="settings-input-label">Token API Publik</span>
                    <input
                      type="password"
                      readOnly
                      aria-label="Token API Service"
                      value={
                        serviceConfig.authToken ||
                        (serviceConfig.authTokenConfigured ? "configured-token" : "")
                      }
                      placeholder="Buat token wajib"
                    />
                  </label>
                  <div className="settings-inline-actions service-settings-field-actions">
                    <button
                      type="button"
                      className="sheet-tab-action"
                      onClick={onCopyServiceToken}
                      disabled={
                        !serviceConfig.authTokenConfigured || Boolean(serviceConfig.authToken)
                      }
                    >
                      Salin
                    </button>
                    {serviceConfig.authTokenConfigured || serviceConfig.authToken ? (
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
                        {isRegenerateTokenArmed ? "Konfirmasi" : "Buat Ulang"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={onGenerateServiceToken}
                      >
                        Buat
                      </button>
                    )}
                  </div>
                </div>

                <div className="service-settings-endpoint-row">
                  <div className="service-settings-endpoint-field">
                    <span className="settings-input-label">Endpoint API</span>
                    <code className="service-settings-endpoint-code">{serviceEndpoint}</code>
                  </div>
                  <button
                    type="button"
                    className="sheet-tab-action"
                    onClick={() => onCopyServiceEndpoint(serviceEndpoint)}
                  >
                    Salin Endpoint
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

      <div className="settings-modal-footer service-settings-footer">
          <button
            type="button"
            className="sheet-tab-action settings-modal-cancel"
            onClick={handleReset}
            disabled={isSaving}
          >
            Batal
          </button>
          <button
            type="button"
            className="sheet-tab-action settings-modal-ok"
            onClick={() => void handleSave()}
            disabled={!isPortValid || isSaving}
          >
            {isSaving ? "Menyimpan..." : "Simpan"}
          </button>
      </div>
    </>
  );
}
