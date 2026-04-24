import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiServiceStatus,
  DesktopServiceConnectionMode,
  ServiceConfig,
  ServiceMode,
  TrackingSource,
} from "../../types";

export type ServiceSettingsNotice = {
  id?: string;
  tone: "success" | "error" | "info";
  message: string;
};

const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  version: 1,
  desktopConnectionMode: "managedLocal",
  desktopServiceUrl: "http://127.0.0.1:18422",
  desktopServiceAuthToken: "",
  enabled: false,
  mode: "local",
  port: 18422,
  authToken: "",
  trackingSource: "default",
  externalApiBaseUrl: "",
  externalApiAuthToken: "",
  allowInsecureExternalApiHttp: false,
  keepRunningInTray: true,
  lastUpdatedAt: "",
};

const DEFAULT_API_SERVICE_STATUS: ApiServiceStatus = {
  status: "stopped",
  enabled: false,
  mode: null,
  bindAddress: null,
  port: null,
  errorMessage: null,
};

function normalizeServicePort(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_SERVICE_CONFIG.port;
  }

  if (value < 1 || value > 65535) {
    return DEFAULT_SERVICE_CONFIG.port;
  }

  return value;
}

function createServiceToken() {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return `sf_${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
  }

  return `sf_${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function areServiceConfigsEqual(left: ServiceConfig, right: ServiceConfig) {
  return (
    left.version === right.version &&
    left.desktopConnectionMode === right.desktopConnectionMode &&
    left.desktopServiceUrl === right.desktopServiceUrl &&
    left.desktopServiceAuthToken === right.desktopServiceAuthToken &&
    left.enabled === right.enabled &&
    left.mode === right.mode &&
    left.port === right.port &&
    left.authToken === right.authToken &&
    left.trackingSource === right.trackingSource &&
    left.externalApiBaseUrl === right.externalApiBaseUrl &&
    left.externalApiAuthToken === right.externalApiAuthToken &&
    left.allowInsecureExternalApiHttp === right.allowInsecureExternalApiHttp &&
    left.keepRunningInTray === right.keepRunningInTray &&
    left.lastUpdatedAt === right.lastUpdatedAt
  );
}

function normalizeServiceConfig(config: ServiceConfig): ServiceConfig {
  return {
    ...DEFAULT_SERVICE_CONFIG,
    ...config,
    port: normalizeServicePort(config.port),
    keepRunningInTray: true,
  };
}

type UseServiceSettingsControllerOptions = {
  copyText: (value: string) => Promise<void>;
  showNotice: (notice: ServiceSettingsNotice) => void;
};

export function useServiceSettingsController({
  copyText,
  showNotice,
}: UseServiceSettingsControllerOptions) {
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig>(DEFAULT_SERVICE_CONFIG);
  const [serviceConfigPreview, setServiceConfigPreview] = useState<ServiceConfig | null>(null);
  const [hasLoadedServiceConfig, setHasLoadedServiceConfig] = useState(false);
  const [apiServiceStatus, setApiServiceStatus] = useState<ApiServiceStatus>(
    DEFAULT_API_SERVICE_STATUS
  );
  const serviceConfigRef = useRef(serviceConfig);
  const effectiveServiceConfig = serviceConfigPreview ?? serviceConfig;
  const hasPendingServiceConfigChanges = serviceConfigPreview !== null;

  useEffect(() => {
    serviceConfigRef.current = serviceConfig;
  }, [serviceConfig]);

  const syncServiceConfigFromBackend = useCallback(
    async (options?: { preservePreview?: boolean }) => {
      const preservePreview = options?.preservePreview ?? true;

      try {
        const savedConfig = await invoke<ServiceConfig | null>("load_saved_api_service_config");
        const nextConfig = savedConfig ? normalizeServiceConfig(savedConfig) : DEFAULT_SERVICE_CONFIG;

        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, nextConfig)) {
            serviceConfigRef.current = nextConfig;
            setServiceConfig(nextConfig);
          }
        }

        return nextConfig;
      } catch {
        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, DEFAULT_SERVICE_CONFIG)) {
            serviceConfigRef.current = DEFAULT_SERVICE_CONFIG;
            setServiceConfig(DEFAULT_SERVICE_CONFIG);
          }
        }

        return DEFAULT_SERVICE_CONFIG;
      }
    },
    [serviceConfigPreview]
  );

  const refreshApiServiceStatus = useCallback(async () => {
    try {
      const status = await invoke<ApiServiceStatus>("get_api_service_status");
      setApiServiceStatus(status);
    } catch (error) {
      setApiServiceStatus({
        status: "error",
        enabled: serviceConfigRef.current.enabled,
        mode: serviceConfigRef.current.mode,
        bindAddress: serviceConfigRef.current.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
        port: serviceConfigRef.current.port,
        errorMessage:
          error instanceof Error
            ? error.message
            : "Gagal membaca status akses API eksternal.",
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void syncServiceConfigFromBackend({ preservePreview: false }).finally(() => {
      if (!cancelled) {
        setHasLoadedServiceConfig(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [syncServiceConfigFromBackend]);

  useEffect(() => {
    if (!hasLoadedServiceConfig) {
      return;
    }

    void refreshApiServiceStatus();
  }, [hasLoadedServiceConfig, refreshApiServiceStatus]);

  useEffect(() => {
    if (!hasLoadedServiceConfig) {
      return;
    }

    const syncFromService = () => {
      void syncServiceConfigFromBackend();
      void refreshApiServiceStatus();
    };

    const intervalId = window.setInterval(syncFromService, 5000);
    window.addEventListener("focus", syncFromService);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncFromService);
    };
  }, [hasLoadedServiceConfig, refreshApiServiceStatus, syncServiceConfigFromBackend]);

  const previewServiceConfig = useCallback((updater: (config: ServiceConfig) => ServiceConfig) => {
    setServiceConfigPreview((current) => {
      const base = current ?? serviceConfigRef.current;
      return updater(base);
    });
  }, []);

  const previewServiceEnabled = useCallback(
    (enabled: boolean) => {
      previewServiceConfig((current) => ({
        ...current,
        enabled,
      }));
    },
    [previewServiceConfig]
  );

  const previewServiceMode = useCallback(
    (mode: ServiceMode) => {
      previewServiceConfig((current) => ({
        ...current,
        mode,
      }));
    },
    [previewServiceConfig]
  );

  const previewDesktopConnectionMode = useCallback(
    (desktopConnectionMode: DesktopServiceConnectionMode) => {
      previewServiceConfig((current) => ({
        ...current,
        desktopConnectionMode,
        enabled: desktopConnectionMode === "custom" ? false : current.enabled,
      }));
    },
    [previewServiceConfig]
  );

  const previewDesktopServiceUrl = useCallback(
    (desktopServiceUrl: string) => {
      previewServiceConfig((current) => ({
        ...current,
        desktopServiceUrl,
      }));
    },
    [previewServiceConfig]
  );

  const previewDesktopServiceAuthToken = useCallback(
    (desktopServiceAuthToken: string) => {
      previewServiceConfig((current) => ({
        ...current,
        desktopServiceAuthToken,
      }));
    },
    [previewServiceConfig]
  );

  const previewServicePort = useCallback(
    (port: number) => {
      previewServiceConfig((current) => ({
        ...current,
        port: normalizeServicePort(port),
      }));
    },
    [previewServiceConfig]
  );

  const previewTrackingSource = useCallback(
    (trackingSource: TrackingSource) => {
      previewServiceConfig((current) => ({
        ...current,
        trackingSource,
      }));
    },
    [previewServiceConfig]
  );

  const previewExternalApiBaseUrl = useCallback(
    (externalApiBaseUrl: string) => {
      previewServiceConfig((current) => ({
        ...current,
        externalApiBaseUrl,
      }));
    },
    [previewServiceConfig]
  );

  const previewExternalApiAuthToken = useCallback(
    (externalApiAuthToken: string) => {
      previewServiceConfig((current) => ({
        ...current,
        externalApiAuthToken,
      }));
    },
    [previewServiceConfig]
  );

  const previewAllowInsecureExternalApiHttp = useCallback(
    (allowInsecureExternalApiHttp: boolean) => {
      previewServiceConfig((current) => ({
        ...current,
        allowInsecureExternalApiHttp,
      }));
    },
    [previewServiceConfig]
  );

  const previewGenerateServiceToken = useCallback(() => {
    previewServiceConfig((current) => ({
      ...current,
      authToken: createServiceToken(),
    }));
  }, [previewServiceConfig]);

  const previewRegenerateServiceToken = useCallback(() => {
    previewServiceConfig((current) => ({
      ...current,
      authToken: createServiceToken(),
    }));
  }, [previewServiceConfig]);

  const cancelServiceConfigPreview = useCallback(() => {
    setServiceConfigPreview(null);
  }, []);

  const applyServiceConfig = useCallback(
    async (nextConfig: ServiceConfig) => {
      try {
        const status = await invoke<ApiServiceStatus>("configure_api_service", {
          config: nextConfig,
        });
        serviceConfigRef.current = nextConfig;
        setServiceConfig(nextConfig);
        setApiServiceStatus(status);
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gagal mengonfigurasi akses API eksternal.";

        setApiServiceStatus({
          status: "error",
          enabled: nextConfig.enabled,
          mode: nextConfig.mode,
          bindAddress: nextConfig.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
          port: nextConfig.port,
          errorMessage: message,
        });
        showNotice({
          tone: "error",
          message,
        });
        return false;
      }
    },
    [showNotice]
  );

  const confirmServiceConfig = useCallback(async () => {
    const nextServiceConfig = serviceConfigPreview
      ? {
          ...serviceConfigPreview,
          keepRunningInTray: true,
          lastUpdatedAt: new Date().toISOString(),
        }
      : null;

    if (
      nextServiceConfig &&
      (nextServiceConfig.desktopConnectionMode === "managedLocal" || nextServiceConfig.enabled)
    ) {
      try {
        await invoke("validate_tracking_source_config", { config: nextServiceConfig });
      } catch (error) {
        showNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Konfigurasi sumber tracking tidak valid.",
        });
        return false;
      }
    }

    if (nextServiceConfig) {
      const didApply = await applyServiceConfig(nextServiceConfig);
      if (!didApply) {
        return false;
      }
    }

    setServiceConfigPreview(null);
    return true;
  }, [applyServiceConfig, serviceConfigPreview, showNotice]);

  const copyServiceEndpoint = useCallback(
    (endpoint: string) => {
      if (!endpoint.trim()) {
        return;
      }

      void copyText(endpoint)
        .then(() =>
          showNotice({
            tone: "success",
            message: "Endpoint API berhasil disalin.",
          })
        )
        .catch(() =>
          showNotice({
            tone: "error",
            message: "Gagal menyalin endpoint API.",
          })
        );
    },
    [copyText, showNotice]
  );

  const copyServiceToken = useCallback(
    (token: string) => {
      if (!token.trim()) {
        return;
      }

      void copyText(token)
        .then(() =>
          showNotice({
            tone: "success",
            message: "Token API berhasil disalin.",
          })
        )
        .catch(() =>
          showNotice({
            tone: "error",
            message: "Gagal menyalin token API.",
          })
        );
    },
    [copyText, showNotice]
  );

  const testExternalTrackingSource = useCallback(async (config: ServiceConfig) => {
    return invoke<string>("test_external_tracking_source", { config });
  }, []);

  const testApiServiceConnection = useCallback(async (config: ServiceConfig) => {
    return invoke<string>("test_api_service_connection", { config });
  }, []);

  return {
    apiServiceStatus,
    cancelServiceConfigPreview,
    confirmServiceConfig,
    copyServiceEndpoint,
    copyServiceToken,
    effectiveServiceConfig,
    hasLoadedServiceConfig,
    hasPendingServiceConfigChanges,
    previewAllowInsecureExternalApiHttp,
    previewDesktopConnectionMode,
    previewDesktopServiceAuthToken,
    previewDesktopServiceUrl,
    previewExternalApiAuthToken,
    previewExternalApiBaseUrl,
    previewGenerateServiceToken,
    previewRegenerateServiceToken,
    previewServiceEnabled,
    previewServiceMode,
    previewServicePort,
    previewTrackingSource,
    testApiServiceConnection,
    testExternalTrackingSource,
  };
}
