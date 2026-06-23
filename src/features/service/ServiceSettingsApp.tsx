import { ActionNoticeStack } from "../components/ActionNoticeStack";
import { readClipboardText, writeClipboardText } from "../clipboard";
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
    previewDesktopConnectionMode,
    previewDesktopServiceAuthToken,
    previewDesktopServiceUrl,
    previewExternalApiAuthToken,
    previewExternalApiBaseUrl,
    previewGenerateServiceToken,
    previewKeepRunningInTray,
    pasteDesktopServiceAuthToken,
    previewRegenerateServiceToken,
    previewStartAtLogin,
    previewServiceEnabled,
    previewServiceMode,
    previewServicePort,
    previewTrackingSource,
    testApiServiceConnection,
    testExternalTrackingSource,
  } = useServiceSettingsController({
    copyText: writeClipboardText,
    pasteText: readClipboardText,
    showNotice: showActionNotice,
    profile: "serviceRuntime",
  });

  if (!hasLoadedServiceConfig) {
    return (
      <main className="shell service-settings-shell display-scale-small">
        <section className="sheet-panel service-settings-panel">
          <div className="settings-field-help settings-field-help-info" role="status">
            Memuat pengaturan ShipFlow Service...
          </div>
        </section>
      </main>
    );
  }

  return (
    <>
      <ActionNoticeStack notices={actionNotices} />
      <ServiceSettingsWindow
        serviceConfig={effectiveServiceConfig}
        hasPendingServiceConfigChanges={hasPendingServiceConfigChanges}
        profile="serviceRuntime"
        onPreviewDesktopConnectionMode={previewDesktopConnectionMode}
        onPreviewDesktopServiceUrl={previewDesktopServiceUrl}
        onPreviewDesktopServiceAuthToken={previewDesktopServiceAuthToken}
        onPasteDesktopServiceAuthToken={pasteDesktopServiceAuthToken}
        onPreviewServiceEnabled={previewServiceEnabled}
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
        onTestApiServiceConnection={testApiServiceConnection}
        onTestExternalTrackingSource={testExternalTrackingSource}
        onConfirmSettings={confirmServiceConfig}
        onCancelSettings={cancelServiceConfigPreview}
        onShowNotice={showActionNotice}
      />
    </>
  );
}
