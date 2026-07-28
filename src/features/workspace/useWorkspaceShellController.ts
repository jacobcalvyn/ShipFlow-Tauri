import { useCallback, useEffect, useState } from "react";
import { listenToShipFlowEvent } from "../../backend/events";
import { isBrowserReady } from "../sheet/utils";

export type DisplayScale = "small" | "medium" | "large";

type AppMenuCommand =
  | "new-document"
  | "open-document"
  | "save-document"
  | "save-document-as"
  | "new-window"
  | "open-document-in-new-window"
  | "show-settings"
  | "check-for-updates"
  | "install-app-update";

type AppMenuCommandPayload = {
  command: AppMenuCommand;
};

const DISPLAY_SCALE_STORAGE_KEY = "shipflow-display-scale";

function isDisplayScale(value: string | null): value is DisplayScale {
  return value === "small" || value === "medium" || value === "large";
}

type UseWorkspaceShellControllerOptions = {
  createNewWorkspaceDocument: () => void;
  openWorkspaceDocumentWithPicker: () => Promise<unknown>;
  saveCurrentWorkspaceDocument: () => Promise<unknown>;
  saveWorkspaceDocumentAs: () => Promise<unknown>;
  createNewWorkspaceWindow: () => Promise<unknown> | void;
  openWorkspaceInNewWindow: () => Promise<unknown> | void;
  checkForAppUpdate: () => Promise<{
    available: boolean;
    currentVersion: string;
    version: string | null;
  }>;
  installAvailableAppUpdate: () => Promise<{
    available: boolean;
    currentVersion: string;
    version: string | null;
  }>;
  showNotice: (notice: { tone: "success" | "error" | "info"; message: string }) => void;
};

export function useWorkspaceShellController({
  createNewWorkspaceDocument,
  openWorkspaceDocumentWithPicker,
  saveCurrentWorkspaceDocument,
  saveWorkspaceDocumentAs,
  createNewWorkspaceWindow,
  openWorkspaceInNewWindow,
  checkForAppUpdate,
  installAvailableAppUpdate,
  showNotice,
}: UseWorkspaceShellControllerOptions) {
  const [settingsOpenRequestToken, setSettingsOpenRequestToken] = useState(0);
  const [displayScale, setDisplayScale] = useState<DisplayScale>(() => {
    if (!isBrowserReady()) {
      return "small";
    }

    const storedDisplayScale = window.localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY);
    return isDisplayScale(storedDisplayScale) ? storedDisplayScale : "small";
  });
  const [displayScalePreview, setDisplayScalePreview] = useState<DisplayScale | null>(null);
  const effectiveDisplayScale = displayScalePreview ?? displayScale;
  const hasPendingSettingsChanges =
    displayScalePreview !== null && displayScalePreview !== displayScale;

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, displayScale);
  }, [displayScale]);

  const previewDisplayScale = useCallback((scale: DisplayScale) => {
    setDisplayScalePreview(scale);
  }, []);

  const cancelSettingsPreview = useCallback(() => {
    setDisplayScalePreview(null);
  }, []);

  const confirmSettings = useCallback(() => {
    const nextDisplayScale = displayScalePreview ?? displayScale;
    setDisplayScale(nextDisplayScale);
    if (isBrowserReady()) {
      window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, nextDisplayScale);
    }
    setDisplayScalePreview(null);
    return true;
  }, [displayScale, displayScalePreview]);

  const handleCheckForUpdates = useCallback(async () => {
    try {
      const status = await checkForAppUpdate();
      showNotice({
        tone: status.available ? "info" : "success",
        message: status.available
          ? `Update ShipFlow ${status.version ?? ""} tersedia.`
          : `ShipFlow sudah versi terbaru (${status.currentVersion}).`,
      });
    } catch (error) {
      showNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Gagal memeriksa update ShipFlow.",
      });
    }
  }, [checkForAppUpdate, showNotice]);

  const handleInstallAppUpdate = useCallback(async () => {
    try {
      const status = await installAvailableAppUpdate();
      showNotice({
        tone: status.available ? "info" : "success",
        message: status.available
          ? "Installer update ShipFlow sedang dijalankan."
          : `ShipFlow sudah versi terbaru (${status.currentVersion}).`,
      });
    } catch (error) {
      showNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Gagal menginstall update ShipFlow.",
      });
    }
  }, [installAvailableAppUpdate, showNotice]);

  useEffect(() => {
    let isDisposed = false;
    let unlistenAppMenu: null | (() => void) = null;

    void listenToShipFlowEvent<AppMenuCommandPayload>(
      "shipflow://app-menu-command",
      (event) => {
        switch (event.payload.command) {
          case "new-document":
            createNewWorkspaceDocument();
            break;
          case "open-document":
            void openWorkspaceDocumentWithPicker();
            break;
          case "save-document":
            void saveCurrentWorkspaceDocument();
            break;
          case "save-document-as":
            void saveWorkspaceDocumentAs();
            break;
          case "new-window":
            void createNewWorkspaceWindow();
            break;
          case "open-document-in-new-window":
            void openWorkspaceInNewWindow();
            break;
          case "show-settings":
            setSettingsOpenRequestToken((current) => current + 1);
            break;
          case "check-for-updates":
            void handleCheckForUpdates();
            break;
          case "install-app-update":
            void handleInstallAppUpdate();
            break;
          default:
            break;
        }
      }
    ).then((unlisten) => {
      if (isDisposed) {
        void unlisten();
        return;
      }

      unlistenAppMenu = unlisten;
    });

    return () => {
      isDisposed = true;
      if (unlistenAppMenu) {
        void unlistenAppMenu();
      }
    };
  }, [
    createNewWorkspaceDocument,
    createNewWorkspaceWindow,
    handleCheckForUpdates,
    handleInstallAppUpdate,
    openWorkspaceDocumentWithPicker,
    openWorkspaceInNewWindow,
    saveCurrentWorkspaceDocument,
    saveWorkspaceDocumentAs,
  ]);

  return {
    cancelSettingsPreview,
    confirmSettings,
    displayScale,
    effectiveDisplayScale,
    hasPendingSettingsChanges,
    previewDisplayScale,
    settingsOpenRequestToken,
  };
}
