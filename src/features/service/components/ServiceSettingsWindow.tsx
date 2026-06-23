import { useEffect, useMemo, useState } from "react";
import {
  DesktopServiceConnectionMode,
  ServiceConfig,
  ServiceMode,
  TrackingSource,
} from "../../../types";
import type { ServiceSettingsNotice } from "../useServiceSettingsController";

type ServiceSettingsWindowProps = {
  serviceConfig: ServiceConfig;
  hasPendingServiceConfigChanges: boolean;
  profile?: "desktopConnection" | "serviceRuntime";
  onPreviewDesktopConnectionMode: (mode: DesktopServiceConnectionMode) => void;
  onPreviewDesktopServiceUrl: (url: string) => void;
  onPreviewDesktopServiceAuthToken: (token: string) => void;
  onPasteDesktopServiceAuthToken: () => Promise<void> | void;
  onPreviewServiceEnabled: (enabled: boolean) => void;
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
  onCopyServiceToken: (token: string) => void;
  onTestApiServiceConnection: (config: ServiceConfig) => Promise<string>;
  onTestExternalTrackingSource: (config: ServiceConfig) => Promise<string>;
  onConfirmSettings: () => Promise<boolean> | boolean;
  onCancelSettings: () => void;
  onShowNotice?: (notice: ServiceSettingsNotice) => void;
};

export function ServiceSettingsWindow({
  serviceConfig,
  hasPendingServiceConfigChanges,
  profile = "desktopConnection",
  onPreviewDesktopConnectionMode,
  onPreviewDesktopServiceUrl,
  onPreviewDesktopServiceAuthToken,
  onPasteDesktopServiceAuthToken,
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
  onTestApiServiceConnection,
  onTestExternalTrackingSource,
  onConfirmSettings,
  onCancelSettings,
  onShowNotice,
}: ServiceSettingsWindowProps) {
  const isServiceRuntimeProfile = profile === "serviceRuntime";
  const [activeView, setActiveView] = useState<"runtime" | "api">("runtime");
  const [isTokenVisible, setIsTokenVisible] = useState(false);
  const [isDesktopTokenVisible, setIsDesktopTokenVisible] = useState(false);
  const [isExternalApiTokenVisible, setIsExternalApiTokenVisible] = useState(false);
  const [isRegenerateTokenArmed, setIsRegenerateTokenArmed] = useState(false);
  const [isTestingServiceConnection, setIsTestingServiceConnection] = useState(false);
  const [isTestingExternalApi, setIsTestingExternalApi] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [serviceConnectionTestResult, setServiceConnectionTestResult] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);
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

  useEffect(() => {
    setServiceConnectionTestResult(null);
  }, [
    serviceConfig.desktopConnectionMode,
    serviceConfig.desktopServiceUrl,
    serviceConfig.desktopServiceAuthToken,
    serviceConfig.port,
    serviceConfig.authToken,
  ]);

  const normalizedPort = Number.parseInt(portDraft, 10);
  const isPortValid =
    Number.isInteger(normalizedPort) && normalizedPort >= 1 && normalizedPort <= 65535;

  const serviceGuideBaseUrl = useMemo(() => {
    return `http://127.0.0.1:${serviceConfig.port}`;
  }, [serviceConfig.port]);

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
          error instanceof Error
            ? error.message
            : "Gagal menguji koneksi ShipFlow Service.",
      });
    } finally {
      setIsTestingServiceConnection(false);
    }
  };

  const handleReset = () => {
    setIsTokenVisible(false);
    setIsDesktopTokenVisible(false);
    setIsExternalApiTokenVisible(false);
    setIsRegenerateTokenArmed(false);
    setIsTestingServiceConnection(false);
    setIsTestingExternalApi(false);
    setServiceConnectionTestResult(null);
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

  const activeViewTitle =
    activeView === "runtime"
      ? isServiceRuntimeProfile
        ? "Sumber Lacak"
        : "Koneksi Service"
      : isServiceRuntimeProfile
        ? "API Service"
        : "API Endpoint";
  const activeViewDescription =
    activeView === "runtime"
      ? isServiceRuntimeProfile
        ? "Pilih scrap internal atau API eksternal sebagai sumber data service."
        : "Pilih sumber lacak utama yang dipakai oleh service lokal."
      : isServiceRuntimeProfile
        ? "Atur port, token wajib, dan akses LAN opsional."
        : "Atur endpoint lokal, mode jaringan, dan token autentikasi untuk klien lain.";

  return (
    <main className="shell service-settings-shell display-scale-small">
      <section className="sheet-panel service-settings-panel">
        <div className="sheet-head service-settings-head">
          <div className="service-settings-title">
            <span className="muted-label">{isServiceRuntimeProfile ? "Service" : "Desktop"}</span>
            <h2>{isServiceRuntimeProfile ? "ShipFlow Service" : "Koneksi ShipFlow Service"}</h2>
            <p>
              {isServiceRuntimeProfile
                ? "Atur sumber lacak, port, dan token API Service."
                : "Atur alamat dan token service yang dipakai Desktop untuk lacak."}
            </p>
          </div>
        </div>

        <div className="service-settings-workbench">
          <div
            className="service-settings-tabs"
            role="tablist"
            aria-label="Bagian pengaturan service"
            aria-orientation="vertical"
          >
            <div className="service-settings-tab-list">
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
                {isServiceRuntimeProfile ? "Sumber Lacak" : "Koneksi Service"}
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
            </div>
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
                {!isServiceRuntimeProfile ? (
                <div className="settings-field-block">
                  <span className="settings-input-label">Target Service</span>
                  <div
                    className="settings-radio-group service-settings-segmented-group"
                    role="radiogroup"
                    aria-label="Koneksi Desktop ke Service"
                  >
                    <label className="settings-radio-option service-settings-segmented-option">
                      <input
                        type="radio"
                        name="desktop-service-connection"
                        checked={serviceConfig.desktopConnectionMode === "managedLocal"}
                        onChange={() => onPreviewDesktopConnectionMode("custom")}
                        disabled
                      />
                      <span className="settings-radio-text">Service bawaan lama</span>
                    </label>
                    <label className="settings-radio-option service-settings-segmented-option">
                      <input
                        type="radio"
                        name="desktop-service-connection"
                        checked={serviceConfig.desktopConnectionMode === "custom"}
                        onChange={() => onPreviewDesktopConnectionMode("custom")}
                      />
                      <span className="settings-radio-text">Service terpisah</span>
                    </label>
                  </div>
                </div>
                ) : null}

                {serviceConfig.desktopConnectionMode === "custom" ? (
                  <>
                    <label className="settings-text-field">
                      <span className="settings-input-label">URL Service ShipFlow</span>
                      <input
                        type="url"
                        aria-label="URL Service ShipFlow"
                        value={serviceConfig.desktopServiceUrl}
                        onChange={(event) =>
                          onPreviewDesktopServiceUrl(event.target.value)
                        }
                      />
                    </label>
                    <label className="settings-text-field">
                      <span className="settings-input-label">Token Service ShipFlow</span>
                      <input
                        type={isDesktopTokenVisible ? "text" : "password"}
                        aria-label="Token Service ShipFlow"
                        value={serviceConfig.desktopServiceAuthToken}
                        onChange={(event) =>
                          onPreviewDesktopServiceAuthToken(event.target.value)
                        }
                      />
                    </label>
                    <div className="settings-inline-actions service-settings-field-actions">
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={() => setIsDesktopTokenVisible((current) => !current)}
                      >
                        {isDesktopTokenVisible ? "Sembunyikan" : "Tampilkan"}
                      </button>
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={() =>
                          onCopyServiceToken(serviceConfig.desktopServiceAuthToken)
                        }
                        disabled={!serviceConfig.desktopServiceAuthToken}
                      >
                        Salin
                      </button>
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={() => {
                          void onPasteDesktopServiceAuthToken();
                          setServiceConnectionTestResult(null);
                        }}
                      >
                        Tempel
                      </button>
                      <button
                        type="button"
                        className="sheet-tab-action"
                        onClick={handleTestServiceConnection}
                        disabled={
                          isTestingServiceConnection ||
                          !serviceConfig.desktopServiceUrl.trim() ||
                          !serviceConfig.desktopServiceAuthToken.trim()
                        }
                      >
                        {isTestingServiceConnection ? "Menguji..." : "Tes Service"}
                      </button>
                    </div>
                    {serviceConnectionTestResult ? (
                      <div
                        className={[
                          "settings-field-help",
                          `settings-field-help-${serviceConnectionTestResult.tone}`,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        role="status"
                        aria-live="polite"
                      >
                        {serviceConnectionTestResult.message}
                      </div>
                    ) : null}
                  </>
                ) : null}

                {serviceConfig.desktopConnectionMode === "managedLocal" ? (
                  <>
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
                        placeholder="Token API dari instance ShipFlow lain"
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
                  </>
                ) : (
                  <div className="settings-field-help settings-field-help-info">
                    Mode lacak diatur di ShipFlow Service: scrap internal atau API eksternal.
                  </div>
                )}
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
                {serviceConfig.desktopConnectionMode === "custom" ? (
                  <div className="settings-field-help settings-field-help-info">
                    Desktop hanya memanggil ShipFlow Service. Port API Service, token, scrap internal, dan API eksternal diatur di sisi Service.
                  </div>
                ) : (
                  <>
                <div className="settings-field-help settings-field-help-info">
                  API Service selalu aktif untuk Desktop. Token wajib dipakai untuk lacak, baik sumbernya scrap internal maupun API eksternal.
                </div>

                <div className="settings-field-block">
                  <span className="settings-input-label">Siklus Service</span>
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
                      <span>Biarkan ShipFlow Service aktif di menu bar / system tray</span>
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
                      <span>Jalankan ShipFlow Service otomatis saat login</span>
                    </label>
                    <div className="settings-field-help settings-field-help-info">
                      Autostart membuka ShipFlow Service saat login. Menu bar / system tray tetap mengikuti pilihan di atas.
                    </div>
                  </div>
                </div>

                <div className="settings-field-block">
                  <span className="settings-input-label">Akses Jaringan</span>
                  <div className="service-settings-network-stack">
                    <div className="service-settings-always-on-row">
                      <span className="service-settings-always-on-dot" aria-hidden="true" />
                      <span className="settings-radio-text">Localhost selalu aktif untuk Desktop</span>
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
                      <span>LAN / Jaringan Lokal</span>
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
                    Port harus di antara 1 dan 65535.
                  </div>
                ) : null}

                {serviceConfig.mode === "lan" ? (
                  <div className="settings-field-help settings-field-help-warning">
                    LAN membuka endpoint tambahan ke perangkat lain dalam jaringan yang sama. Desktop tetap memakai localhost.
                  </div>
                ) : null}

                <div className="service-settings-field-row">
                  <label className="settings-text-field service-settings-token-field">
                    <span className="settings-input-label">Token API Service</span>
                    <input
                      type={isTokenVisible ? "text" : "password"}
                      readOnly
                      aria-label="Token API Service"
                      value={serviceConfig.authToken}
                      placeholder="Buat token wajib"
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
                      Salin
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
                    <span className="settings-input-label">Endpoint Desktop</span>
                    <code className="service-settings-endpoint-code">{serviceGuideBaseUrl}</code>
                  </div>
                  <button
                    type="button"
                    className="sheet-tab-action"
                    onClick={() => onCopyServiceEndpoint(serviceGuideBaseUrl)}
                  >
                    Salin Endpoint
                  </button>
                </div>

                  </>
                )}
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
            disabled={
              (serviceConfig.desktopConnectionMode === "managedLocal" && !isPortValid) ||
              isSaving
            }
          >
            {isSaving ? "Menyimpan..." : "Simpan"}
          </button>
        </div>
      </section>
    </main>
  );
}
