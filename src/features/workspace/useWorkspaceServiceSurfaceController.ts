import { useCallback } from "react";
import { openShipflowServiceApp } from "../../backend/commands";
import {
  ServiceSettingsNotice,
  useServiceSettingsController,
} from "../service/useServiceSettingsController";
import { readClipboardText, writeClipboardText } from "../clipboard";

type UseWorkspaceServiceSurfaceControllerOptions = {
  showNotice: (notice: ServiceSettingsNotice) => void;
};

export function useWorkspaceServiceSurfaceController({
  showNotice,
}: UseWorkspaceServiceSurfaceControllerOptions) {
  const serviceSettings = useServiceSettingsController({
    copyText: writeClipboardText,
    pasteText: readClipboardText,
    showNotice,
  });

  const openShipFlowServiceApp = useCallback(async () => {
    try {
      await openShipflowServiceApp();
    } catch {
      showNotice({
        tone: "error",
        message: "Gagal membuka pengaturan koneksi service.",
      });
    }
  }, [showNotice]);

  return {
    ...serviceSettings,
    openShipFlowServiceApp,
  };
}
