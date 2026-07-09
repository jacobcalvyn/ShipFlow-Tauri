import { ServiceConfig } from "../../../types";

type ServiceConnectionTestResult = {
  tone: "success" | "error";
  message: string;
} | null;

type DesktopServiceConnectionPanelProps = {
  serviceConfig: ServiceConfig;
  desktopServiceUrlDraft: string;
  isDesktopServiceUrlValid: boolean;
  isDesktopTokenVisible: boolean;
  isTestingServiceConnection: boolean;
  serviceConnectionTestResult: ServiceConnectionTestResult;
  onDesktopServiceUrlDraftChange: (value: string) => void;
  onPreviewDesktopServiceAuthToken: (token: string) => void;
  onClearConnectionTestResult: () => void;
  onToggleDesktopTokenVisibility: () => void;
  onCopyServiceToken: (token: string) => void;
  onPasteDesktopServiceAuthToken: () => Promise<void> | void;
  onTestServiceConnection: () => void;
};

export function DesktopServiceConnectionPanel({
  serviceConfig,
  desktopServiceUrlDraft,
  isDesktopServiceUrlValid,
  isDesktopTokenVisible,
  isTestingServiceConnection,
  serviceConnectionTestResult,
  onDesktopServiceUrlDraftChange,
  onPreviewDesktopServiceAuthToken,
  onClearConnectionTestResult,
  onToggleDesktopTokenVisibility,
  onCopyServiceToken,
  onPasteDesktopServiceAuthToken,
  onTestServiceConnection,
}: DesktopServiceConnectionPanelProps) {
  return (
    <div className="settings-pane">
      <div className="settings-pane-header">
        <h4>Koneksi Service</h4>
        <p>Atur endpoint dan token ShipFlow Service yang dipakai Desktop untuk lacak.</p>
      </div>
      <div className="service-settings-stack">
        <label className="settings-text-field">
          <span className="settings-input-label">URL Service ShipFlow</span>
          <input
            type="url"
            aria-label="URL Service ShipFlow"
            value={desktopServiceUrlDraft}
            onChange={(event) => onDesktopServiceUrlDraftChange(event.target.value)}
            placeholder="http://127.0.0.1:18422"
          />
        </label>
        {!isDesktopServiceUrlValid ? (
          <div className="settings-field-help settings-field-help-error">
            URL harus memakai HTTP/HTTPS, memiliki host, dan tidak memakai query atau fragment.
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
            Salin
          </button>
          <button
            type="button"
            className="sheet-tab-action"
            onClick={() => {
              void onPasteDesktopServiceAuthToken();
              onClearConnectionTestResult();
            }}
          >
            Tempel
          </button>
          <button
            type="button"
            className="sheet-tab-action"
            onClick={onTestServiceConnection}
            disabled={
              isTestingServiceConnection ||
              !isDesktopServiceUrlValid ||
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
      </div>
    </div>
  );
}
