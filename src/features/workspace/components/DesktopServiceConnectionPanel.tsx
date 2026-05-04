import { useState } from "react";
import { getReleaseHealth, type ReleaseHealth } from "../../../backend/commands";
import { ServiceConfig } from "../../../types";

type ServiceConnectionTestResult = {
  tone: "success" | "error";
  message: string;
} | null;

type DesktopServiceConnectionPanelProps = {
  serviceConfig: ServiceConfig;
  desktopServicePortDraft: string;
  isDesktopServicePortValid: boolean;
  isDesktopTokenVisible: boolean;
  isTestingServiceConnection: boolean;
  serviceConnectionTestResult: ServiceConnectionTestResult;
  onDesktopServicePortDraftChange: (value: string) => void;
  onPreviewDesktopServiceAuthToken: (token: string) => void;
  onClearConnectionTestResult: () => void;
  onToggleDesktopTokenVisibility: () => void;
  onCopyServiceToken: (token: string) => void;
  onPasteDesktopServiceAuthToken: () => Promise<void> | void;
  onTestServiceConnection: () => void;
};

export function DesktopServiceConnectionPanel({
  serviceConfig,
  desktopServicePortDraft,
  isDesktopServicePortValid,
  isDesktopTokenVisible,
  isTestingServiceConnection,
  serviceConnectionTestResult,
  onDesktopServicePortDraftChange,
  onPreviewDesktopServiceAuthToken,
  onClearConnectionTestResult,
  onToggleDesktopTokenVisibility,
  onCopyServiceToken,
  onPasteDesktopServiceAuthToken,
  onTestServiceConnection,
}: DesktopServiceConnectionPanelProps) {
  const [releaseHealth, setReleaseHealth] = useState<ReleaseHealth | null>(null);
  const [releaseHealthError, setReleaseHealthError] = useState<string | null>(null);

  const showReleaseHealth = () => {
    setReleaseHealthError(null);
    void getReleaseHealth()
      .then((health) => setReleaseHealth(health))
      .catch((error) =>
        setReleaseHealthError(
          error instanceof Error ? error.message : "Gagal membaca release health."
        )
      );
  };

  return (
    <>
      <div className="settings-service-launcher">
        <div className="settings-service-launcher-copy">
          <div className="settings-service-launcher-title">Koneksi Service</div>
          <div className="settings-service-launcher-description">
            Atur port localhost dan token ShipFlow Service yang dipakai Desktop untuk lacak.
          </div>
        </div>
      </div>
      <div className="service-settings-stack">
        <label className="settings-text-field settings-text-field-port">
          <span className="settings-input-label">ShipFlow Service Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            inputMode="numeric"
            aria-label="ShipFlow Service Port"
            value={desktopServicePortDraft}
            onChange={(event) => onDesktopServicePortDraftChange(event.target.value)}
          />
        </label>
        {!isDesktopServicePortValid ? (
          <div className="settings-field-help settings-field-help-error">
            Port harus antara 1 dan 65535.
          </div>
        ) : null}
        <label className="settings-text-field">
          <span className="settings-input-label">ShipFlow Service Token</span>
          <input
            type={isDesktopTokenVisible ? "text" : "password"}
            aria-label="ShipFlow Service Bearer Token"
            value={serviceConfig.desktopServiceAuthToken}
            onChange={(event) => {
              onPreviewDesktopServiceAuthToken(event.target.value);
              onClearConnectionTestResult();
            }}
          />
        </label>
        <div className="settings-inline-actions service-settings-field-actions">
          <button
            type="button"
            className="sheet-tab-action"
            onClick={onToggleDesktopTokenVisibility}
          >
            {isDesktopTokenVisible ? "Sembunyikan" : "Tampilkan"}
          </button>
          <button
            type="button"
            className="sheet-tab-action"
            onClick={() => onCopyServiceToken(serviceConfig.desktopServiceAuthToken)}
            disabled={!serviceConfig.desktopServiceAuthToken}
          >
            Copy
          </button>
          <button
            type="button"
            className="sheet-tab-action"
            onClick={() => {
              void onPasteDesktopServiceAuthToken();
              onClearConnectionTestResult();
            }}
          >
            Paste
          </button>
          <button
            type="button"
            className="sheet-tab-action"
            onClick={onTestServiceConnection}
            disabled={
              isTestingServiceConnection ||
              !isDesktopServicePortValid ||
              !serviceConfig.desktopServiceAuthToken.trim()
            }
          >
            {isTestingServiceConnection ? "Testing..." : "Tes Service"}
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
        <div className="settings-service-launcher settings-release-health">
          <div className="settings-service-launcher-copy">
            <div className="settings-service-launcher-title">Release Health</div>
            <div className="settings-service-launcher-description">
              Cek versi app, platform, dan jenis build yang sedang berjalan.
            </div>
          </div>
          <button type="button" className="sheet-tab-action" onClick={showReleaseHealth}>
            Cek Health
          </button>
        </div>
        {releaseHealth ? (
          <div className="settings-field-help settings-field-help-info" role="status">
            {releaseHealth.packageName} {releaseHealth.appVersion} · {releaseHealth.targetOs}/
            {releaseHealth.targetArch}
            {releaseHealth.debugBuild ? " · debug" : " · release"}
          </div>
        ) : null}
        {releaseHealthError ? (
          <div className="settings-field-help settings-field-help-error" role="status">
            {releaseHealthError}
          </div>
        ) : null}
      </div>
    </>
  );
}
