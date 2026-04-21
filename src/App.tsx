import { useEffect } from "react";
import { ServiceSettingsApp } from "./features/service/ServiceSettingsApp";
import { WorkspaceApp } from "./features/workspace/WorkspaceApp";

function resolveDesktopPlatform() {
  if (typeof navigator === "undefined") {
    return "other";
  }

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = (
    navigatorWithUserAgentData.userAgentData?.platform ??
    navigator.platform ??
    ""
  ).toLowerCase();

  if (platform.includes("mac")) {
    return "macos";
  }

  if (platform.includes("win")) {
    return "windows";
  }

  return "other";
}

function resolveShipFlowWindowKind() {
  if (typeof window === "undefined") {
    return "workspace" as const;
  }

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get("windowKind") === "service-settings") {
    return "service-settings" as const;
  }

  const shipflowWindow = window as Window & {
    __SHIPFLOW_WINDOW_KIND__?: string;
  };

  return shipflowWindow.__SHIPFLOW_WINDOW_KIND__ === "service-settings"
    ? ("service-settings" as const)
    : ("workspace" as const);
}

function App() {
  useEffect(() => {
    const platform = resolveDesktopPlatform();
    document.documentElement.dataset.platform = platform;

    return () => {
      delete document.documentElement.dataset.platform;
    };
  }, []);

  if (resolveShipFlowWindowKind() === "service-settings") {
    return <ServiceSettingsApp />;
  }

  return <WorkspaceApp />;
}

export default App;
