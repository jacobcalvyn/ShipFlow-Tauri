import { useCallback, useEffect, useRef, useState } from "react";
import {
  copyPublicApiToken,
  configureApiService,
  getApiServiceStatus,
  loadSavedApiServiceConfig,
  testExternalTrackingSource as testExternalTrackingSourceCommand,
  validateTrackingSourceConfig,
} from "../../backend/commands";
import {
  ApiServiceStatus,
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
  enabled: true,
  mode: "local",
  port: 18422,
  authToken: "",
  trackingSource: "default",
  externalApiBaseUrl: "",
  externalApiAuthToken: "",
  allowInsecureExternalApiHttp: false,
  keepRunningInTray: true,
  startAtLogin: false,
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
    left.enabled === right.enabled &&
    left.mode === right.mode &&
    left.port === right.port &&
    left.authToken === right.authToken &&
    left.authTokenConfigured === right.authTokenConfigured &&
    left.trackingSource === right.trackingSource &&
    left.externalApiBaseUrl === right.externalApiBaseUrl &&
    left.externalApiAuthToken === right.externalApiAuthToken &&
    left.externalApiAuthTokenConfigured === right.externalApiAuthTokenConfigured &&
    left.allowInsecureExternalApiHttp === right.allowInsecureExternalApiHttp &&
    left.keepRunningInTray === right.keepRunningInTray &&
    left.startAtLogin === right.startAtLogin &&
    left.lastUpdatedAt === right.lastUpdatedAt
  );
}

function normalizeServiceConfig(config: ServiceConfig): ServiceConfig {
  const normalizedPort = normalizeServicePort(config.port);
  const normalizedConfig: ServiceConfig = {
    ...DEFAULT_SERVICE_CONFIG,
    ...config,
    enabled: true,
    port: normalizedPort,
  };

  if (!normalizedConfig.authToken.trim() && !normalizedConfig.authTokenConfigured) {
    normalizedConfig.authToken = createServiceToken();
  }

  return normalizedConfig;
}

type UseServiceSettingsControllerOptions = {
  copyText: (value: string) => Promise<void>;
  showNotice: (notice: ServiceSettingsNotice) => void;
};

export function useServiceSettingsController({
  copyText,
  showNotice,
}: UseServiceSettingsControllerOptions) {
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig>(() =>
    normalizeServiceConfig(DEFAULT_SERVICE_CONFIG)
  );
  const [serviceConfigPreview, setServiceConfigPreview] = useState<ServiceConfig | null>(null);
  const [hasLoadedServiceConfig, setHasLoadedServiceConfig] = useState(false);
  const [apiServiceStatus, setApiServiceStatus] = useState<ApiServiceStatus>(
    DEFAULT_API_SERVICE_STATUS
  );
  const serviceConfigRef = useRef(serviceConfig);
  const serviceConfigPreviewRef = useRef(serviceConfigPreview);
  const effectiveServiceConfig = serviceConfigPreview ?? serviceConfig;
  const hasPendingServiceConfigChanges = serviceConfigPreview !== null;

  useEffect(() => {
    serviceConfigRef.current = serviceConfig;
  }, [serviceConfig]);

  useEffect(() => {
    serviceConfigPreviewRef.current = serviceConfigPreview;
  }, [serviceConfigPreview]);

  const syncServiceConfigFromBackend = useCallback(
    async (options?: { preservePreview?: boolean }) => {
      const preservePreview = options?.preservePreview ?? true;

      try {
        const savedConfig = await loadSavedApiServiceConfig();
        const preservedAuthToken =
          serviceConfigRef.current.authToken || createServiceToken();
        const baseConfig = savedConfig
          ? normalizeServiceConfig(savedConfig)
          : {
              ...normalizeServiceConfig(DEFAULT_SERVICE_CONFIG),
              authToken: preservedAuthToken,
            };
        const nextConfig = normalizeServiceConfig(baseConfig);

        if (!preservePreview || serviceConfigPreviewRef.current === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, nextConfig)) {
            serviceConfigRef.current = nextConfig;
            setServiceConfig(nextConfig);
          }
        }

        return nextConfig;
      } catch {
        const preservedAuthToken =
          serviceConfigRef.current.authToken || createServiceToken();
        const fallbackConfig = {
          ...normalizeServiceConfig(DEFAULT_SERVICE_CONFIG),
          authToken: preservedAuthToken,
        };
        const nextFallbackConfig = normalizeServiceConfig(fallbackConfig);
        if (!preservePreview || serviceConfigPreviewRef.current === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, nextFallbackConfig)) {
            serviceConfigRef.current = nextFallbackConfig;
            setServiceConfig(nextFallbackConfig);
          }
        }

        return nextFallbackConfig;
      }
    },
    []
  );

  const refreshApiServiceStatus = useCallback(async () => {
    try {
      const status = await getApiServiceStatus();
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
            : "Gagal membaca status API Service.",
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
      const nextConfig = normalizeServiceConfig(updater(base));
      serviceConfigPreviewRef.current = nextConfig;
      return nextConfig;
    });
  }, []);

  const previewServiceMode = useCallback(
    (mode: ServiceMode) => {
      previewServiceConfig((current) => ({
        ...current,
        mode,
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

  const previewKeepRunningInTray = useCallback(
    (keepRunningInTray: boolean) => {
      previewServiceConfig((current) => ({
        ...current,
        keepRunningInTray,
      }));
    },
    [previewServiceConfig]
  );

  const previewStartAtLogin = useCallback(
    (startAtLogin: boolean) => {
      previewServiceConfig((current) => ({
        ...current,
        startAtLogin,
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
    serviceConfigPreviewRef.current = null;
    setServiceConfigPreview(null);
  }, []);

  const applyServiceConfig = useCallback(
    async (nextConfig: ServiceConfig) => {
      try {
        const status = await configureApiService(nextConfig);
        const persistedConfig = normalizeServiceConfig(
          (await loadSavedApiServiceConfig()) ?? nextConfig
        );
        serviceConfigRef.current = persistedConfig;
        setServiceConfig(persistedConfig);
        setApiServiceStatus(status);
        if (status.status === "error") {
          showNotice({
            tone: "error",
            message:
              status.errorMessage ||
              "Pengaturan tersimpan, tetapi API Service belum siap.",
          });
        }
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gagal mengonfigurasi API Service.";

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
          lastUpdatedAt: new Date().toISOString(),
        }
      : {
          ...serviceConfigRef.current,
          lastUpdatedAt: new Date().toISOString(),
        };
    const normalizedNextServiceConfig = nextServiceConfig
      ? normalizeServiceConfig(nextServiceConfig)
      : null;

    if (normalizedNextServiceConfig) {
      try {
        await validateTrackingSourceConfig(normalizedNextServiceConfig);
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

    if (normalizedNextServiceConfig) {
      const didApply = await applyServiceConfig(normalizedNextServiceConfig);
      if (!didApply) {
        return false;
      }
    }

    serviceConfigPreviewRef.current = null;
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

  const copyServiceToken = useCallback(() => {
    void copyPublicApiToken()
      .then((copied) => {
        if (copied) {
          showNotice({
            tone: "success",
            message: "Token API Service berhasil disalin.",
          });
        }
      })
      .catch(() =>
        showNotice({
          tone: "error",
          message: "Gagal menyalin token API Service.",
        })
      );
  }, [showNotice]);

  const testExternalTrackingSource = useCallback(async (config: ServiceConfig) => {
    return testExternalTrackingSourceCommand(config);
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
    previewExternalApiAuthToken,
    previewExternalApiBaseUrl,
    previewGenerateServiceToken,
    previewKeepRunningInTray,
    previewRegenerateServiceToken,
    previewStartAtLogin,
    previewServiceMode,
    previewServicePort,
    previewTrackingSource,
    testExternalTrackingSource,
  };
}
