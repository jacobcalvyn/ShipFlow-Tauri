import React from "react";
import ReactDOM from "react-dom/client";
import { ServiceSettingsApp } from "./features/service/ServiceSettingsApp";
import {
  AppErrorBoundary,
  installFrontendRuntimeLogging,
} from "./renderer-runtime";
import "./styles.css";

document.title = "ShipFlow Service";
document.documentElement.dataset.rendererSafeMode = "false";
document.documentElement.dataset.windowKind = "service-settings";
installFrontendRuntimeLogging();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <ServiceSettingsApp />
    </AppErrorBoundary>
  </React.StrictMode>,
);
