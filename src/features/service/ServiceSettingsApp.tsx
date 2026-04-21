import { ActionNoticeStack } from "../components/ActionNoticeStack";
import { writeClipboardText } from "../clipboard";
import { ServiceSettingsWindow } from "./components/ServiceSettingsWindow";
import { useServiceSettingsController } from "./useServiceSettingsController";
import { useActionNotices } from "../useActionNotices";

export function ServiceSettingsApp() {
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
    previewRegenerateServiceToken,
    previewServiceEnabled,
    previewServiceMode,
    previewServicePort,
    previewTrackingSource,
    testExternalTrackingSource,
  } = useServiceSettingsController({
    copyText: writeClipboardText,
    showNotice: showActionNotice,
  });

  if (!hasLoadedServiceConfig) {
    return <main className="shell service-settings-shell display-scale-small" />;
  }

  return (
    <>
      <ActionNoticeStack notices={actionNotices} />
      <ServiceSettingsWindow
        serviceConfig={effectiveServiceConfig}
        hasPendingServiceConfigChanges={hasPendingServiceConfigChanges}
        onPreviewServiceEnabled={previewServiceEnabled}
        onPreviewServiceMode={previewServiceMode}
        onPreviewServicePort={previewServicePort}
        onPreviewTrackingSource={previewTrackingSource}
        onPreviewExternalApiBaseUrl={previewExternalApiBaseUrl}
        onPreviewExternalApiAuthToken={previewExternalApiAuthToken}
        onPreviewAllowInsecureExternalApiHttp={previewAllowInsecureExternalApiHttp}
        onGenerateServiceToken={previewGenerateServiceToken}
        onRegenerateServiceToken={previewRegenerateServiceToken}
        onCopyServiceEndpoint={copyServiceEndpoint}
        onCopyServiceToken={copyServiceToken}
        onTestExternalTrackingSource={testExternalTrackingSource}
        onConfirmSettings={confirmServiceConfig}
        onCancelSettings={cancelServiceConfigPreview}
        onShowNotice={showActionNotice}
      />
    </>
  );
}
