import { ActionNoticeStack } from "../components/ActionNoticeStack";
import { writeClipboardText } from "../clipboard";
import { ServiceSettingsWindow } from "./components/ServiceSettingsWindow";
import { useServiceSettingsController } from "./useServiceSettingsController";
import { useActionNotices } from "../useActionNotices";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
    previewDesktopConnectionMode,
    previewDesktopServiceAuthToken,
    previewDesktopServiceUrl,
    previewExternalApiAuthToken,
    previewExternalApiBaseUrl,
    previewGenerateServiceToken,
    previewRegenerateServiceToken,
    previewServiceEnabled,
    previewServiceMode,
    previewServicePort,
    previewTrackingSource,
    testApiServiceConnection,
    testExternalTrackingSource,
  } = useServiceSettingsController({
    copyText: writeClipboardText,
    showNotice: showActionNotice,
  });

  const hideServiceWindow = async () => {
    try {
      await getCurrentWindow().hide();
    } catch (error) {
      showActionNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gagal menyembunyikan window ShipFlow Service.",
      });
    }
  };

  if (!hasLoadedServiceConfig) {
    return <main className="shell service-settings-shell display-scale-small" />;
  }

  return (
    <>
      <ActionNoticeStack notices={actionNotices} />
      <ServiceSettingsWindow
        serviceConfig={effectiveServiceConfig}
        hasPendingServiceConfigChanges={hasPendingServiceConfigChanges}
        onPreviewDesktopConnectionMode={previewDesktopConnectionMode}
        onPreviewDesktopServiceUrl={previewDesktopServiceUrl}
        onPreviewDesktopServiceAuthToken={previewDesktopServiceAuthToken}
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
        onTestApiServiceConnection={testApiServiceConnection}
        onTestExternalTrackingSource={testExternalTrackingSource}
        onConfirmSettings={confirmServiceConfig}
        onCancelSettings={cancelServiceConfigPreview}
        onHideWindow={hideServiceWindow}
        onShowNotice={showActionNotice}
      />
    </>
  );
}
