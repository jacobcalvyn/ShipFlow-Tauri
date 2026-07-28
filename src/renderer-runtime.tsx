import React from "react";
import { logFrontendRuntimeEvent } from "./backend/commands";

async function logFrontendRuntime(level: "info" | "error", message: string) {
  try {
    await logFrontendRuntimeEvent(level, message);
  } catch {
    // Ignore logging failures to avoid recursive runtime errors.
  }
}

export class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { hasError: boolean; message: string }
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = {
      hasError: false,
      message: "",
    };
  }

  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown frontend error.",
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    void logFrontendRuntime(
      "error",
      `React error boundary caught: ${error.stack || error.message}\n${errorInfo.componentStack}`,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="shell app-runtime-fallback">
          <div className="runtime-fallback-card">
            <h1>ShipFlow mengalami error frontend.</h1>
            <p>Silakan reload manual. Detail error sudah dikirim ke log runtime.</p>
            <pre>{this.state.message}</pre>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}

export function installFrontendRuntimeLogging() {
  window.addEventListener("error", (event) => {
    void logFrontendRuntime(
      "error",
      `window.error: ${event.message}\n${
        event.error instanceof Error ? event.error.stack || event.error.message : ""
      }`,
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    void logFrontendRuntime(
      "error",
      `unhandledrejection: ${
        reason instanceof Error ? reason.stack || reason.message : String(reason)
      }`,
    );
  });
}
