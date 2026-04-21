import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
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
  | "show-service-settings";

type AppMenuCommandPayload = {
  command: AppMenuCommand;
};

const DISPLAY_SCALE_STORAGE_KEY = "shipflow-display-scale";

function isDisplayScale(value: string | null): value is DisplayScale {
  return value === "small" || value === "medium" || value === "large";
}

type UseWorkspaceShellControllerOptions = {
  hasPendingServiceConfigChanges: boolean;
  cancelServiceConfigPreview: () => void;
  confirmServiceConfig: () => Promise<boolean>;
  createNewWorkspaceDocument: () => void;
  openWorkspaceDocumentWithPicker: () => Promise<unknown>;
  saveCurrentWorkspaceDocument: () => Promise<unknown>;
  saveWorkspaceDocumentAs: () => Promise<unknown>;
  createNewWorkspaceWindow: () => Promise<unknown> | void;
  openWorkspaceInNewWindow: () => Promise<unknown> | void;
  openShipFlowServiceApp: () => Promise<unknown> | void;
};

export function useWorkspaceShellController({
  hasPendingServiceConfigChanges,
  cancelServiceConfigPreview,
  confirmServiceConfig,
  createNewWorkspaceDocument,
  openWorkspaceDocumentWithPicker,
  saveCurrentWorkspaceDocument,
  saveWorkspaceDocumentAs,
  createNewWorkspaceWindow,
  openWorkspaceInNewWindow,
  openShipFlowServiceApp,
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
    cancelServiceConfigPreview();
  }, [cancelServiceConfigPreview]);

  const confirmSettings = useCallback(async () => {
    if (!hasPendingServiceConfigChanges) {
      const nextDisplayScale = displayScalePreview ?? displayScale;
      setDisplayScale(nextDisplayScale);
      if (isBrowserReady()) {
        window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, nextDisplayScale);
      }
      setDisplayScalePreview(null);
      return true;
    }

    const didConfirm = await confirmServiceConfig();
    if (!didConfirm) {
      return false;
    }

    const nextDisplayScale = displayScalePreview ?? displayScale;
    setDisplayScale(nextDisplayScale);
    if (isBrowserReady()) {
      window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, nextDisplayScale);
    }
    setDisplayScalePreview(null);
    return true;
  }, [
    confirmServiceConfig,
    displayScale,
    displayScalePreview,
    hasPendingServiceConfigChanges,
  ]);

  useEffect(() => {
    let isDisposed = false;
    let unlistenAppMenu: null | (() => void) = null;

    void listen<AppMenuCommandPayload>("shipflow://app-menu-command", (event) => {
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
        case "show-service-settings":
          void openShipFlowServiceApp();
          break;
        default:
          break;
      }
    }).then((unlisten) => {
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
    openShipFlowServiceApp,
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
    previewDisplayScale,
    settingsOpenRequestToken,
  };
}
