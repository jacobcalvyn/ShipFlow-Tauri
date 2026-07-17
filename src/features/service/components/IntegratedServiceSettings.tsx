import { writeClipboardText } from "../../clipboard";
import { ActionNoticeStack } from "../../components/ActionNoticeStack";
import { useActionNotices } from "../../useActionNotices";
import { useServiceSettingsController } from "../useServiceSettingsController";
import { ServiceSettingsWindow } from "./ServiceSettingsWindow";

type IntegratedServiceSettingsProps = {
  activeView: "runtime" | "api";
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

  const confirmSettings = async () => {
    const didSave = await confirmServiceConfig();
    if (didSave !== false) {
      onClose();
    }
    return didSave;
  };

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
            Batal
          </button>
          <button
            type="button"
            className="sheet-tab-action settings-modal-ok"
            disabled
          >
            Memuat...
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
