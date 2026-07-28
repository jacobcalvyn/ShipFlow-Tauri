import { writeClipboardText } from "../../clipboard";
import { ActionNoticeStack } from "../../components/ActionNoticeStack";
import { useActionNotices } from "../../useActionNotices";
import { useServiceSettingsController } from "../useServiceSettingsController";
import {
  ServiceSettingsWindow,
  type ServiceSettingsView,
} from "./ServiceSettingsWindow";

type IntegratedServiceSettingsProps = {
  activeView: ServiceSettingsView;
  onClose: () => void;
};

export function IntegratedServiceSettings({
  activeView,
  onClose,
}: IntegratedServiceSettingsProps) {
  const { actionNotices, showActionNotice } = useActionNotices();
  const {
    cancelServiceConfigPreview,
    confirmServiceConfig,
    copyServiceEndpoint,
    copyServiceToken,
    effectiveServiceConfig,
    hasLoadedServiceConfig,
    hasPendingServiceConfigChanges,
    previewAllowInsecureExternalApiHttp,
    previewExternalApiAuthToken,
    previewExternalApiBaseUrl,
    previewGenerateServiceToken,
    previewKeepRunningInTray,
    previewRegenerateServiceToken,
    previewStartAtLogin,
    previewServiceMode,
    previewServicePort,
    previewTrackingSource,
    testExternalTrackingSource,
  } = useServiceSettingsController({
    copyText: writeClipboardText,
    showNotice: showActionNotice,
  });

  const cancelSettings = () => {
    cancelServiceConfigPreview();
    onClose();
  };

  const confirmSettings = () => confirmServiceConfig();

  if (!hasLoadedServiceConfig) {
    return (
      <>
        <div className="service-settings-loading" role="status">
          Memuat pengaturan ShipFlow Service...
        </div>
        <div className="settings-modal-footer service-settings-footer">
          <button
            type="button"
            className="sheet-tab-action settings-modal-cancel"
            onClick={onClose}
          >
            Tutup
          </button>
          <button
            type="button"
            className="sheet-tab-action settings-modal-ok"
            disabled
          >
            Simpan
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <ActionNoticeStack notices={actionNotices} />
      <ServiceSettingsWindow
        activeView={activeView}
        serviceConfig={effectiveServiceConfig}
        hasPendingServiceConfigChanges={hasPendingServiceConfigChanges}
        onPreviewServiceMode={previewServiceMode}
        onPreviewServicePort={previewServicePort}
        onPreviewKeepRunningInTray={previewKeepRunningInTray}
        onPreviewStartAtLogin={previewStartAtLogin}
        onPreviewTrackingSource={previewTrackingSource}
        onPreviewExternalApiBaseUrl={previewExternalApiBaseUrl}
        onPreviewExternalApiAuthToken={previewExternalApiAuthToken}
        onPreviewAllowInsecureExternalApiHttp={previewAllowInsecureExternalApiHttp}
        onGenerateServiceToken={previewGenerateServiceToken}
        onRegenerateServiceToken={previewRegenerateServiceToken}
        onCopyServiceEndpoint={copyServiceEndpoint}
        onCopyServiceToken={copyServiceToken}
        onTestExternalTrackingSource={testExternalTrackingSource}
        onConfirmSettings={confirmSettings}
        onCancelSettings={cancelSettings}
        onShowNotice={showActionNotice}
      />
    </>
  );
}
