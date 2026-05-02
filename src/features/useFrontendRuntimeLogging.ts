import { useEffect } from "react";
import { logFrontendRuntimeEvent } from "../backend/commands";

export function useFrontendRuntimeLogging() {
  useEffect(() => {
    const emitRuntimeEvent = (level: "info" | "error", message: string) => {
      void Promise.resolve(
        logFrontendRuntimeEvent(level, message)
      ).catch(() => {
        // Ignore logging failures to avoid recursive runtime errors.
      });
    };

    emitRuntimeEvent("info", "App mounted.");

    const handlePageHide = () => {
      emitRuntimeEvent("info", "window.pagehide fired.");
    };

    const handleBeforeUnload = () => {
      emitRuntimeEvent("info", "window.beforeunload fired.");
    };

    const handleVisibilityChange = () => {
      emitRuntimeEvent("info", `document.visibilityState=${document.visibilityState}`);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      emitRuntimeEvent("info", "App unmounted.");
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);
}
