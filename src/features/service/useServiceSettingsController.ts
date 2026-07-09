import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkAppUpdate,
  configureApiService,
  getReleaseHealth,
  getApiServiceStatus,
  installAppUpdate,
  loadSavedApiServiceConfig,
  testApiServiceConnection as testApiServiceConnectionCommand,
  testExternalTrackingSource as testExternalTrackingSourceCommand,
  validateTrackingSourceConfig,
} from "../../backend/commands";
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
  desktopConnectionMode: "custom",
  desktopServiceUrl: "http://127.0.0.1:18422",
  desktopServiceAuthToken: "",
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

const SERVICE_RUNTIME_DEFAULT_CONFIG: ServiceConfig = {
  ...DEFAULT_SERVICE_CONFIG,
  desktopConnectionMode: "managedLocal",
  desktopServiceAuthToken: "",
  enabled: true,
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

function normalizeDesktopServiceUrlForLocalPort(serviceUrl: string, fallbackPort: number) {
  try {
    const parsedUrl = new URL(serviceUrl);
    const port = parsedUrl.port
      ? Number.parseInt(parsedUrl.port, 10)
      : fallbackPort;

    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return `http://127.0.0.1:${port}`;
    }
  } catch {
    // Fall through to the validated fallback port.
  }

  return `http://127.0.0.1:${normalizeServicePort(fallbackPort)}`;
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
    left.startAtLogin === right.startAtLogin &&
    left.lastUpdatedAt === right.lastUpdatedAt
  );
}

type ServiceSettingsProfile = "desktopConnection" | "serviceRuntime";

function defaultServiceConfigForProfile(profile: ServiceSettingsProfile): ServiceConfig {
  return profile === "serviceRuntime"
    ? SERVICE_RUNTIME_DEFAULT_CONFIG
    : DEFAULT_SERVICE_CONFIG;
}

function normalizeServiceConfig(
  config: ServiceConfig,
  profile: ServiceSettingsProfile
): ServiceConfig {
  const defaultConfig = defaultServiceConfigForProfile(profile);
  const normalizedPort = normalizeServicePort(config.port);
  const normalizedConfig: ServiceConfig = {
    ...defaultConfig,
    ...config,
    desktopConnectionMode:
      profile === "serviceRuntime" ? "managedLocal" : "custom",
    enabled: profile === "serviceRuntime" ? true : config.enabled,
    port: normalizedPort,
  };

  if (profile === "serviceRuntime" && !normalizedConfig.authToken.trim()) {
    normalizedConfig.authToken = createServiceToken();
  }

  if (profile === "desktopConnection") {
    return {
      ...normalizedConfig,
      desktopServiceUrl: normalizeDesktopServiceUrlForLocalPort(
        normalizedConfig.desktopServiceUrl,
        normalizedPort
      ),
    };
  }

  return normalizedConfig;
}

type UseServiceSettingsControllerOptions = {
  copyText: (value: string) => Promise<void>;
  pasteText?: () => Promise<string>;
  showNotice: (notice: ServiceSettingsNotice) => void;
  profile?: ServiceSettingsProfile;
};

export function useServiceSettingsController({
  copyText,
  pasteText,
  showNotice,
  profile = "desktopConnection",
}: UseServiceSettingsControllerOptions) {
  const defaultServiceConfig = defaultServiceConfigForProfile(profile);
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig>(() =>
    normalizeServiceConfig(defaultServiceConfig, profile)
  );
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
        const savedConfig = await loadSavedApiServiceConfig();
        const preservedAuthToken =
          profile === "serviceRuntime"
            ? serviceConfigRef.current.authToken || createServiceToken()
            : serviceConfigRef.current.authToken;
        const baseConfig = savedConfig
          ? normalizeServiceConfig(savedConfig, profile)
          : {
              ...normalizeServiceConfig(defaultServiceConfig, profile),
              authToken: preservedAuthToken,
            };
        const nextConfig = normalizeServiceConfig(baseConfig, profile);

        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, nextConfig)) {
            serviceConfigRef.current = nextConfig;
            setServiceConfig(nextConfig);
          }
        }

        return nextConfig;
      } catch {
        const preservedAuthToken =
          profile === "serviceRuntime"
            ? serviceConfigRef.current.authToken || createServiceToken()
            : serviceConfigRef.current.authToken;
        const fallbackConfig = {
          ...normalizeServiceConfig(defaultServiceConfig, profile),
          authToken: preservedAuthToken,
        };
        const nextFallbackConfig = normalizeServiceConfig(fallbackConfig, profile);
        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, nextFallbackConfig)) {
            serviceConfigRef.current = nextFallbackConfig;
            setServiceConfig(nextFallbackConfig);
          }
        }

        return nextFallbackConfig;
      }
    },
    [defaultServiceConfig, profile, serviceConfigPreview]
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
      return normalizeServiceConfig(updater(base), profile);
    });
  }, [profile]);

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
        enabled: desktopConnectionMode === "custom" ? true : current.enabled,
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

  const pasteDesktopServiceAuthToken = useCallback(async () => {
    if (!pasteText) {
      showNotice({
        tone: "error",
        message: "Clipboard paste tidak tersedia.",
      });
      return;
    }

    try {
      const text = (await pasteText()).trim();
      if (!text) {
        showNotice({
          tone: "error",
          message: "Clipboard kosong.",
        });
        return;
      }

      previewDesktopServiceAuthToken(text);
      showNotice({
        tone: "success",
        message: "Token service ditempel dari clipboard.",
      });
    } catch (error) {
      showNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gagal membaca clipboard.",
      });
    }
  }, [pasteText, previewDesktopServiceAuthToken, showNotice]);

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
    setServiceConfigPreview(null);
  }, []);

  const applyServiceConfig = useCallback(
    async (nextConfig: ServiceConfig) => {
      try {
        const status = await configureApiService(nextConfig);
        serviceConfigRef.current = nextConfig;
        setServiceConfig(nextConfig);
        setApiServiceStatus(status);
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
      : profile === "serviceRuntime"
        ? {
            ...serviceConfigRef.current,
            lastUpdatedAt: new Date().toISOString(),
          }
        : null;
    const normalizedNextServiceConfig = nextServiceConfig
      ? normalizeServiceConfig(nextServiceConfig, profile)
      : null;

    if (
      normalizedNextServiceConfig &&
      profile === "serviceRuntime" &&
      (normalizedNextServiceConfig.desktopConnectionMode === "managedLocal" ||
        normalizedNextServiceConfig.enabled)
    ) {
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

    setServiceConfigPreview(null);
    return true;
  }, [applyServiceConfig, profile, serviceConfigPreview, showNotice]);

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
            message: "Token API Service berhasil disalin.",
          })
        )
        .catch(() =>
          showNotice({
            tone: "error",
            message: "Gagal menyalin token API Service.",
          })
        );
    },
    [copyText, showNotice]
  );

  const testExternalTrackingSource = useCallback(async (config: ServiceConfig) => {
    return testExternalTrackingSourceCommand(config);
  }, []);

  const testApiServiceConnection = useCallback(async (config: ServiceConfig) => {
    return testApiServiceConnectionCommand(config);
  }, []);

  const checkForAppUpdate = useCallback(async () => {
    return checkAppUpdate();
  }, []);

  const getAppReleaseHealth = useCallback(async () => {
    return getReleaseHealth();
  }, []);

  const installAvailableAppUpdate = useCallback(async () => {
    return installAppUpdate();
  }, []);

  return {
    apiServiceStatus,
    cancelServiceConfigPreview,
    checkForAppUpdate,
    confirmServiceConfig,
    copyServiceEndpoint,
    copyServiceToken,
    effectiveServiceConfig,
    getAppReleaseHealth,
    hasLoadedServiceConfig,
    hasPendingServiceConfigChanges,
    previewAllowInsecureExternalApiHttp,
    previewDesktopConnectionMode,
    previewDesktopServiceAuthToken,
    previewDesktopServiceUrl,
    previewExternalApiAuthToken,
    previewExternalApiBaseUrl,
    previewGenerateServiceToken,
    previewKeepRunningInTray,
    pasteDesktopServiceAuthToken,
    previewRegenerateServiceToken,
    previewStartAtLogin,
    previewServiceEnabled,
    previewServiceMode,
    previewServicePort,
    previewTrackingSource,
    installAvailableAppUpdate,
    testApiServiceConnection,
    testExternalTrackingSource,
  };
}
