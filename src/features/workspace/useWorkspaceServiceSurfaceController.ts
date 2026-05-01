import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
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
      await invoke("open_shipflow_service_app");
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
