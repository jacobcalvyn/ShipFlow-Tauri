import { useEffect } from "react";
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

function App() {
  useEffect(() => {
    const platform = resolveDesktopPlatform();
    document.documentElement.dataset.platform = platform;

    return () => {
      delete document.documentElement.dataset.platform;
    };
  }, []);

  return <WorkspaceApp />;
}

export default App;
