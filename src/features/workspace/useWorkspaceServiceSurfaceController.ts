import {
  checkAppUpdate,
  installAppUpdate,
} from "../../backend/commands";
import type { ServiceSettingsNotice } from "../service/useServiceSettingsController";

type UseWorkspaceServiceSurfaceControllerOptions = {
  showNotice: (notice: ServiceSettingsNotice) => void;
};

export function useWorkspaceServiceSurfaceController({
  showNotice,
}: UseWorkspaceServiceSurfaceControllerOptions) {
  return {
    showNotice,
    checkForAppUpdate: checkAppUpdate,
    installAvailableAppUpdate: installAppUpdate,
  };
}
