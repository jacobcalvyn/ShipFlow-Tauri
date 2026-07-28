import { useCallback, useEffect, useState } from "react";
import { closeCurrentWindow } from "../../backend/commands";
import { IntegratedServiceSettings } from "./components/IntegratedServiceSettings";
import type { ServiceSettingsView } from "./components/ServiceSettingsWindow";

export function ServiceSettingsApp() {
  const [activeView, setActiveView] = useState<ServiceSettingsView>("general");

  const closeWindow = useCallback(() => {
    void closeCurrentWindow();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeWindow();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeWindow]);

  return (
    <main className="service-window-shell">
      <section
        className="service-window-panel"
        aria-label="Pengaturan ShipFlow Service"
      >
        <div className="service-window-layout">
          <nav
            className="settings-sidebar service-window-sidebar"
            role="tablist"
            aria-label="Bagian pengaturan Service"
            aria-orientation="vertical"
          >
            <button
              type="button"
              id="service-settings-general-tab"
              className={`settings-nav-button ${activeView === "general" ? "is-active" : ""}`}
              role="tab"
              aria-selected={activeView === "general"}
              aria-controls="service-settings-general-panel"
              onClick={() => setActiveView("general")}
            >
              Umum
            </button>
            <button
              type="button"
              id="service-settings-runtime-tab"
              className={`settings-nav-button ${activeView === "runtime" ? "is-active" : ""}`}
              role="tab"
              aria-selected={activeView === "runtime"}
              aria-controls="service-settings-runtime-panel"
              onClick={() => setActiveView("runtime")}
            >
              Sumber Lacak
            </button>
            <button
              type="button"
              id="service-settings-api-tab"
              className={`settings-nav-button ${activeView === "api" ? "is-active" : ""}`}
              role="tab"
              aria-selected={activeView === "api"}
              aria-controls="service-settings-api-panel"
              onClick={() => setActiveView("api")}
            >
              API Publik
            </button>
          </nav>

          <div className="settings-content service-window-content">
            <IntegratedServiceSettings
              activeView={activeView}
              onClose={closeWindow}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
