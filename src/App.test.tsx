import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import {
  BagResponse,
  ManifestResponse,
  ServiceConfig,
  TrackResponse,
} from "./types";
import { WorkspaceDocumentFile } from "./features/workspace/document";

const { mockedHideWindow, mockedInvoke } = vi.hoisted(() => ({
  mockedHideWindow: vi.fn<() => Promise<void>>(),
  mockedInvoke: vi.fn<
    (
      command: string,
      args?: {
        shipmentId?: string;
        bagId?: string;
        manifestId?: string;
        forceRefresh?: boolean;
        sheetId?: string;
        rowKey?: string;
        imageSource?: string;
        text?: string;
        path?: string | null;
        title?: string;
        mode?: string;
        suggestedName?: string;
        documentPath?: string | null;
        config?: ServiceConfig;
        document?: WorkspaceDocumentFile;
      }
    ) => Promise<unknown>
  >(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockedInvoke,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: mockedHideWindow,
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createTrackingResponse(shipmentId: string): TrackResponse {
  return {
    url: `https://example.test/track/${shipmentId}`,
    detail: {
      shipment_header: {
        nomor_kiriman: shipmentId,
      },
      origin_detail: {},
      package_detail: {
        berat_actual: 0,
        berat_volumetric: 0,
      },
      billing_detail: {
        bea_dasar: 0,
        nilai_barang: 0,
        htnb: 0,
        cod_info: {
          is_cod: false,
          total_cod: 0,
        },
      },
      actors: {
        pengirim: {
          nama: "Sender",
        },
        penerima: {
          nama: "Receiver",
        },
      },
      performance_detail: {},
    },
    status_akhir: {
      status: "INVEHICLE",
    },
    pod: {},
    history: [],
    history_summary: {
      irregularity: [],
      bagging_unbagging: [],
      manifest_r7: [],
      delivery_runsheet: [],
    },
  };
}

function createBagResponse(bagId: string): BagResponse {
  const trackingId = bagId.endsWith("-3")
    ? "P260000000003"
    : bagId.endsWith("-2")
      ? "P260000000002"
      : "P260000000001";

  return {
    url: `https://example.test/bag/${bagId}`,
    nomor_kantung: bagId,
    items: [
      {
        no: "1",
        no_resi: trackingId,
        status: "UNBAGGING",
      },
    ],
  };
}

function createManifestResponse(manifestId: string): ManifestResponse {
  const bagId = manifestId.endsWith("-3")
    ? "PID123456-3"
    : manifestId.endsWith("-2")
      ? "PID123456-2"
      : "PID123456";

  return {
    url: `https://example.test/manifest/${manifestId}`,
    total_berat: "12.5",
    items: [
      {
        no: "1",
        nomor_kantung: bagId,
        status: "ARRIVED",
      },
    ],
  };
}

function getInvokeCalls(command: string) {
  return mockedInvoke.mock.calls.filter(([name]) => name === command);
}

function expectInvokeCount(command: string, count: number) {
  expect(getInvokeCalls(command)).toHaveLength(count);
}

function openSheetTabMenu(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.contextMenu(tab, {
    clientX: 24,
    clientY: 24,
  });
  return tab;
}

function openFileMenu() {
  fireEvent.click(screen.getByRole("button", { name: "File" }));
}

function setShipFlowWindowKind(kind: "workspace" | "service-settings") {
  const shipflowWindow = window as Window & {
    __SHIPFLOW_WINDOW_KIND__?: string;
  };

  if (kind === "service-settings") {
    shipflowWindow.__SHIPFLOW_WINDOW_KIND__ = "service-settings";
    return;
  }

  delete shipflowWindow.__SHIPFLOW_WINDOW_KIND__;
}

describe("App workspace isolation", () => {
  const pendingRequests = new Map<string, Deferred<TrackResponse>>();
  const pendingBagRequests = new Map<string, Deferred<BagResponse>>();
  const pendingManifestRequests = new Map<string, Deferred<ManifestResponse>>();
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let persistedServiceConfig: ServiceConfig | null;

  function resolveRequest(shipmentId: string) {
    const request = pendingRequests.get(shipmentId);
    if (!request) {
      throw new Error(`No pending request for ${shipmentId}`);
    }

    request.resolve(createTrackingResponse(shipmentId));
  }

  function resolveBagRequest(bagId: string) {
    const request = pendingBagRequests.get(bagId);
    if (!request) {
      throw new Error(`No pending bag request for ${bagId}`);
    }

    request.resolve(createBagResponse(bagId));
  }

  function resolveManifestRequest(manifestId: string) {
    const request = pendingManifestRequests.get(manifestId);
    if (!request) {
      throw new Error(`No pending manifest request for ${manifestId}`);
    }

    request.resolve(createManifestResponse(manifestId));
  }

  beforeEach(() => {
    pendingRequests.clear();
    pendingBagRequests.clear();
    pendingManifestRequests.clear();
    mockedHideWindow.mockReset();
    persistedServiceConfig = null;
    window.localStorage.clear();
    setShipFlowWindowKind("workspace");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "configure_api_service") {
        const config = args?.config ?? {
          enabled: false,
          mode: "local",
          port: 18422,
        };
        persistedServiceConfig = config as ServiceConfig;

        return Promise.resolve({
          status: config.enabled ? "running" : "stopped",
          enabled: config.enabled,
          mode: config.mode,
          bindAddress: config.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
          port: config.port,
          errorMessage: null,
        } as unknown as TrackResponse);
      }

      if (command === "load_saved_api_service_config") {
        return Promise.resolve(persistedServiceConfig);
      }

      if (command === "get_api_service_status") {
        return Promise.resolve({
          status: "stopped",
          enabled: false,
          mode: "local",
          bindAddress: "127.0.0.1",
          port: 18422,
          errorMessage: null,
        } as unknown as TrackResponse);
      }

      if (command === "test_external_tracking_source") {
        return Promise.resolve(
          "Koneksi berhasil. Akses API aktif via lan (0.0.0.0:18422)." as unknown as TrackResponse
        );
      }

      if (command === "test_api_service_connection") {
        const config = args?.config;
        const baseUrl =
          config?.desktopConnectionMode === "custom"
            ? config.desktopServiceUrl
            : `http://127.0.0.1:${config?.port ?? 18422}`;
        return Promise.resolve(
          `ShipFlow Service is reachable at ${baseUrl}.` as unknown as TrackResponse
        );
      }

      if (command === "validate_tracking_source_config") {
        const config = args?.config;
        if (
          config?.trackingSource === "externalApi" &&
          config.externalApiBaseUrl.startsWith("http://") &&
          !config.allowInsecureExternalApiHttp
        ) {
          return Promise.reject(
            new Error(
              "External API base URL must use HTTPS unless insecure HTTP is explicitly allowed."
            )
          );
        }

        if (
          config?.trackingSource === "externalApi" &&
          !config.externalApiAuthToken.trim()
        ) {
          return Promise.reject(
            new Error("External API bearer token is required.")
          );
        }

        return Promise.resolve(undefined);
      }

      if (command === "resolve_pod_image") {
        return Promise.resolve(typeof args?.imageSource === "string" ? args.imageSource : "");
      }

      if (command === "log_frontend_runtime_event") {
        return Promise.resolve(undefined);
      }

      if (command === "set_current_window_title") {
        return Promise.resolve(undefined);
      }

      if (command === "set_current_window_document_state") {
        return Promise.resolve(undefined);
      }

      if (command === "resolve_window_close_request") {
        return Promise.resolve(undefined);
      }

      if (command === "get_current_window_label") {
        return Promise.resolve("main");
      }

      if (command === "take_pending_workspace_window_request") {
        return Promise.resolve(null);
      }

      if (command === "claim_current_workspace_document") {
        return Promise.resolve({
          status: "claimed",
          path: args?.path ?? null,
          ownerLabel: null,
        });
      }

      if (command === "create_workspace_window") {
        return Promise.resolve({
          status: "claimed",
          path: args?.documentPath ?? null,
          ownerLabel: "workspace-test-window",
        });
      }

      if (command === "pick_workspace_document_path") {
        if (args?.mode === "open") {
          return Promise.resolve("/tmp/picked-open.shipflow");
        }

        return Promise.resolve("/tmp/picked-save.shipflow");
      }

      if (command === "copy_to_clipboard") {
        return Promise.resolve(undefined);
      }

      if (command === "open_shipflow_service_app") {
        return Promise.resolve(undefined);
      }

      if (command === "write_workspace_document") {
        return Promise.resolve({
          path: args?.path ?? "/tmp/workspace.shipflow",
          savedAt: args?.document?.savedAt ?? "2026-04-18T00:00:00.000Z",
        });
      }

      if (command === "read_workspace_document") {
        return Promise.resolve({
          path: args?.path ?? "/tmp/workspace.shipflow",
          document: {
            version: 1,
            app: "shipflow-desktop",
            savedAt: "2026-04-18T00:00:00.000Z",
            workspace: {
              version: 1,
              activeSheetId: "sheet-opened",
              sheetOrder: ["sheet-opened"],
              sheetMetaById: {
                "sheet-opened": {
                  name: "Sheet 1",
                  color: "slate",
                  icon: "sheet",
                },
              },
              sheetsById: {
                "sheet-opened": {
                  rows: [
                    {
                      key: "row-opened",
                      trackingInput: "POPEN1",
                      shipment: null,
                      loading: false,
                      stale: false,
                      dirty: false,
                      error: "",
                    },
                  ],
                  filters: {},
                  valueFilters: {},
                  sortState: {
                    path: null,
                    direction: "asc",
                  },
                  selectedRowKeys: [],
                  selectionFollowsVisibleRows: false,
                  columnWidths: {},
                  hiddenColumnPaths: [],
                  pinnedColumnPaths: [],
                  openColumnMenuPath: null,
                  highlightedColumnPath: null,
                  deleteAllArmed: false,
                },
              },
            },
          },
        });
      }

      if (command === "track_bag" && args?.bagId) {
        const deferred = createDeferred<BagResponse>();
        pendingBagRequests.set(args.bagId, deferred);
        return deferred.promise;
      }

      if (command === "track_manifest" && args?.manifestId) {
        const deferred = createDeferred<ManifestResponse>();
        pendingManifestRequests.set(args.manifestId, deferred);
        return deferred.promise;
      }

      if (command !== "track_shipment" || !args?.shipmentId) {
        throw new Error(`Unexpected invoke: ${command}`);
      }

      if (args.shipmentId === "PBAD") {
        return Promise.resolve({} as TrackResponse);
      }

      const deferred = createDeferred<TrackResponse>();
      pendingRequests.set(args.shipmentId, deferred);
      return deferred.promise;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectInfoTelemetry(event: string, shipmentId: string) {
    expect(findTelemetryPayload(infoSpy, event, shipmentId)).toBeTruthy();
  }

  function expectErrorTelemetry(event: string, shipmentId: string) {
    expect(findTelemetryPayload(errorSpy, event, shipmentId)).toBeTruthy();
  }

  function findTelemetryPayload(
    spy: ReturnType<typeof vi.spyOn>,
    event: string,
    shipmentId: string
  ) {
    const matchedCall = spy.mock.calls.find(
      ([label, payload]) =>
        label === "[ShipFlowTelemetry]" &&
        payload &&
        typeof payload === "object" &&
        "event" in payload &&
        "shipmentId" in payload &&
        payload.event === event &&
        payload.shipmentId === shipmentId
    );

    return (matchedCall?.[1] as Record<string, unknown> | undefined) ?? null;
  }

  it("ignores late responses after deleting the active sheet during an in-flight request", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "P2" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    openSheetTabMenu("Sheet 2");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hapus" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Konfirmasi Hapus" })
    );

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Sheet 2" })).not.toBeInTheDocument();
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    resolveRequest("P2");

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });
  });

  it("creates a truly empty new sheet while another sheet still has in-flight tracking", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "P5" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("");
  });

  it(
    "keeps import source modals isolated per sheet when switching tabs",
    async () => {
      render(<App />);

      fireEvent.click(screen.getByRole("button", { name: "Bag" }));
      expect(
        screen.getByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("ID Bag"), {
        target: { value: "PID-SHEET-1" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

      await waitFor(() => {
        expectInvokeCount("track_bag", 1);
        expect(screen.getByRole("button", { name: "Memuat..." })).toBeDisabled();
      });
      expect(getInvokeCalls("track_bag")[0]?.[1]?.forceRefresh).toBe(true);

      resolveBagRequest("PID-SHEET-1");

      await waitFor(() => {
        expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
        expect(screen.getByText("P260000000001")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Ganti Semua" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
          "aria-selected",
          "true"
        );
      });

      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
      expect(
        screen.getByRole("dialog", { name: "Import ID Kiriman dari Manifest" })
      ).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("ID Manifest"), {
        target: { value: "MNF-SHEET-2" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

      await waitFor(() => {
        expectInvokeCount("track_manifest", 1);
        expect(screen.getByRole("button", { name: "Memuat..." })).toBeDisabled();
      });
      expect(getInvokeCalls("track_manifest")[0]?.[1]?.forceRefresh).toBe(true);

      resolveManifestRequest("MNF-SHEET-2");

      await waitFor(() => {
        expect(
          screen.getByText(
            "Nomor Kantung (1) - Proses ambil id kiriman dari 0/1 kantung"
          )
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Tambah Data" })).toBeDisabled();
      });

      await waitFor(() => {
        expectInvokeCount("track_bag", 2);
      });

      resolveBagRequest("PID123456-2");

      await waitFor(() => {
        expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
        expect(screen.getByText("PID123456-2 - 1 Kiriman")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Ganti Semua" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
      });

      fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));
      expect(
        screen.getByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).toBeInTheDocument();
      expect(screen.getByLabelText("ID Bag")).toHaveValue("PID-SHEET-1");
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Manifest" })
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));
      expect(
        screen.getByRole("dialog", { name: "Import ID Kiriman dari Manifest" })
      ).toBeInTheDocument();
      expect(screen.getByLabelText("ID Manifest")).toHaveValue("MNF-SHEET-2");
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByText("PID123456-2 - 1 Kiriman")).toBeInTheDocument();
    },
    15000
  );

  it("keeps concurrent manifest lookups isolated across sheets", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
    fireEvent.change(screen.getByLabelText("ID Manifest"), {
      target: { value: "MNF-PARALLEL-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_manifest", 1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
    fireEvent.change(screen.getByLabelText("ID Manifest"), {
      target: { value: "MNF-PARALLEL-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_manifest", 2);
    });

    resolveManifestRequest("MNF-PARALLEL-1");
    resolveManifestRequest("MNF-PARALLEL-2");

    await waitFor(() => {
      expectInvokeCount("track_bag", 2);
      expect(
        screen.getByText(
          "Nomor Kantung (1) - Proses ambil id kiriman dari 0/1 kantung"
        )
      ).toBeInTheDocument();
      expect(screen.getByText("PID123456-2")).toBeInTheDocument();
    });

    resolveBagRequest("PID123456");

    await waitFor(() => {
      expect(screen.queryByText("PID123456 - 1 Kiriman")).not.toBeInTheDocument();
      expect(screen.getByText("PID123456-2")).toBeInTheDocument();
    });

    resolveBagRequest("PID123456-2");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByText("PID123456-2 - 1 Kiriman")).toBeInTheDocument();
      expect(screen.queryByText("PID123456 - 1 Kiriman")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Import ID Kiriman dari Manifest" })
      ).toBeInTheDocument();
      expect(screen.getByLabelText("ID Manifest")).toHaveValue("MNF-PARALLEL-1");
      expect(screen.getByText("PID123456 - 1 Kiriman")).toBeInTheDocument();
      expect(screen.queryByText("PID123456-2 - 1 Kiriman")).not.toBeInTheDocument();
    });
  });

  it("replaces all sheet data from a bag lookup", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PEXIST1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PEXIST1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-REPLACE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
    });
    expect(getInvokeCalls("track_bag")[0]?.[1]?.forceRefresh).toBe(true);
    expect(getInvokeCalls("track_bag")[0]?.[1]?.forceRefresh).toBe(true);

    resolveBagRequest("PID-REPLACE");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Ganti Semua" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue(
        "P260000000001"
      );
      expect(screen.queryByDisplayValue("PEXIST1")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));

    await waitFor(() => {
      expect(screen.getByLabelText("ID Bag")).toHaveValue("PID-REPLACE");
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });
  });

  it("appends bag lookup shipment ids into the active sheet", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PEXIST2" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PEXIST2");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-APPEND" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
    });

    resolveBagRequest("PID-APPEND");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByDisplayValue("PEXIST2")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));

    await waitFor(() => {
      expect(screen.getByLabelText("ID Bag")).toHaveValue("PID-APPEND");
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });
  });

  it("appends manifest shipment ids into the active sheet after bag resolution completes", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PEXIST-MANIFEST" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PEXIST-MANIFEST");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
    fireEvent.change(screen.getByLabelText("ID Manifest"), {
      target: { value: "MNF-APPEND" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_manifest", 1);
    });
    expect(getInvokeCalls("track_manifest")[0]?.[1]?.forceRefresh).toBe(true);

    resolveManifestRequest("MNF-APPEND");

    await waitFor(() => {
      expect(
        screen.getByText(
          "Nomor Kantung (1) - Proses ambil id kiriman dari 0/1 kantung"
        )
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tambah Data" })).toBeDisabled();
    });

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
    });

    resolveBagRequest("PID123456");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByText("PID123456 - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Manifest" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByDisplayValue("PEXIST-MANIFEST")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));

    await waitFor(() => {
      expect(screen.getByLabelText("ID Manifest")).toHaveValue("MNF-APPEND");
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByText("PID123456 - 1 Kiriman")).toBeInTheDocument();
    });
  });

  it("replaces all sheet data from a manifest lookup and preserves cached manifest results", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PEXIST-MANIFEST-REPLACE" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PEXIST-MANIFEST-REPLACE");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
    fireEvent.change(screen.getByLabelText("ID Manifest"), {
      target: { value: "MNF-REPLACE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_manifest", 1);
    });

    resolveManifestRequest("MNF-REPLACE");

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
    });

    resolveBagRequest("PID123456");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ganti Semua" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Ganti Semua" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Manifest" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue(
        "P260000000001"
      );
      expect(screen.queryByDisplayValue("PEXIST-MANIFEST-REPLACE")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));

    await waitFor(() => {
      expect(screen.getByLabelText("ID Manifest")).toHaveValue("MNF-REPLACE");
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByText("PID123456 - 1 Kiriman")).toBeInTheDocument();
    });
  });

  it("ignores late bag results from an overwritten manifest lookup", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
    fireEvent.change(screen.getByLabelText("ID Manifest"), {
      target: { value: "MNF-OVERWRITE-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_manifest", 1);
    });

    resolveManifestRequest("MNF-OVERWRITE-1");

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
      expect(
        screen.getByText("Nomor Kantung (1) - Proses ambil id kiriman dari 0/1 kantung")
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("ID Manifest"), {
      target: { value: "MNF-OVERWRITE-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_manifest", 2);
    });

    resolveManifestRequest("MNF-OVERWRITE-2");

    await waitFor(() => {
      expectInvokeCount("track_bag", 2);
      expect(screen.getByText("PID123456-2")).toBeInTheDocument();
    });

    resolveBagRequest("PID123456");

    await waitFor(() => {
      expect(screen.queryByText("PID123456 - 1 Kiriman")).not.toBeInTheDocument();
      expect(screen.getByText("PID123456-2")).toBeInTheDocument();
    });

    resolveBagRequest("PID123456-2");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByText("PID123456-2 - 1 Kiriman")).toBeInTheDocument();
      expect(screen.queryByText("PID123456 - 1 Kiriman")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
    });
  });

  it("starts tracking again when bag data is appended repeatedly", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-APPEND-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
    });

    resolveBagRequest("PID-APPEND-1");

    await waitFor(() => {
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
    });

    resolveRequest("P260000000001");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-APPEND-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 2);
    });

    resolveBagRequest("PID-APPEND-2");

    await waitFor(() => {
      expect(screen.getByText("P260000000002")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000002")[0]).toBeInTheDocument();
    });
  });

  it("starts tracking again when cached bag data is appended without reloading the modal", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-CACHED-APPEND" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
    });

    resolveBagRequest("PID-CACHED-APPEND");

    await waitFor(() => {
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
    });

    resolveRequest("P260000000001");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));

    await waitFor(() => {
      expect(screen.getByLabelText("ID Bag")).toHaveValue("PID-CACHED-APPEND");
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000001")).toHaveLength(2);
    });
  });

  it("copies selected ids into a new sheet and starts tracking them immediately", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PSEL1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PSEL1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "ID Terselect ke Sheet Baru" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Salin" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Sheet 1 - 1" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expectInvokeCount("track_shipment", 2);
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("PSEL1");
      expect(screen.getByText("0/1 kiriman dimuat")).toBeInTheDocument();
    });

    resolveRequest("PSEL1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  });

  it("moves selected ids into a new sheet and removes them from the source sheet", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PMOVE1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PMOVE1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "ID Terselect ke Sheet Baru" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Pindahkan" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Sheet 1 - 1" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expectInvokeCount("track_shipment", 2);
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("PMOVE1");
    });

    resolveRequest("PMOVE1");

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("");
    });
  });

  it("copies selected ids into another existing sheet without replacing its current data", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PAPP1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PAPP1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const secondSheetInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(secondSheetInput, { target: { value: "PAPP2" } });
    fireEvent.blur(secondSheetInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    resolveRequest("PAPP2");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "ID Terselect ke Sheet Lain" })
    );
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Salin" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sheet 2" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 3);
      expect(screen.getByRole("tab", { name: "Sheet 1" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("PAPP2")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("PAPP1")[0]).toBeInTheDocument();
    });

    resolveRequest("PAPP1");

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
    });
  });

  it("moves selected ids into another existing sheet and clears them from the source sheet", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PMOVE2" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PMOVE2");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const secondSheetInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(secondSheetInput, { target: { value: "PTARGET2" } });
    fireEvent.blur(secondSheetInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    resolveRequest("PTARGET2");

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "ID Terselect ke Sheet Lain" })
    );
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Pindahkan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sheet 2" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 3);
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("PTARGET2")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("PMOVE2")[0]).toBeInTheDocument();
    });

    resolveRequest("PMOVE2");

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
    });
  });

  it("moves selected ids into another existing sheet via drag and drop", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PDRAG1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PDRAG1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const secondSheetInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(secondSheetInput, { target: { value: "PDRAG2" } });
    fireEvent.blur(secondSheetInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    resolveRequest("PDRAG2");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    const transferButton = screen.getByRole("button", { name: "ID Terselect ke Sheet Lain" });
    const targetWrapper = screen.getByRole("tab", { name: "Sheet 2" }).closest(".sheet-tab");
    if (!targetWrapper) {
      throw new Error("Target sheet wrapper not found.");
    }

    fireEvent.dragStart(transferButton, {
      dataTransfer: {
        effectAllowed: "copyMove",
        setData: vi.fn(),
      },
    });
    fireEvent.dragOver(targetWrapper, {
      dataTransfer: { dropEffect: "move" },
    });
    fireEvent.drop(targetWrapper, {
      dataTransfer: { dropEffect: "move" },
    });
    fireEvent.dragEnd(transferButton);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 3);
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("PDRAG2")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("PDRAG1")[0]).toBeInTheDocument();
    });

    resolveRequest("PDRAG1");

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
    });
  });

  it("moves focus to the next tracking row when Enter is pressed", () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID");
    firstInput.focus();

    fireEvent.keyDown(firstInput, { key: "Enter" });

    expect(document.activeElement).toBe(secondInput);
    expectInvokeCount("track_shipment", 0);
  });

  it("moves focus between tracking rows with ArrowDown and ArrowUp", () => {
    render(<App />);

    const [firstInput, secondInput, thirdInput] =
      screen.getAllByPlaceholderText("Masukkan ID");

    firstInput.focus();
    fireEvent.keyDown(firstInput, { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondInput);

    fireEvent.keyDown(secondInput, { key: "ArrowDown" });
    expect(document.activeElement).toBe(thirdInput);

    fireEvent.keyDown(thirdInput, { key: "ArrowUp" });
    expect(document.activeElement).toBe(secondInput);
  });

  it("does not intercept Delete inside the input or clear the whole tracking cell", () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "P2603310114291" } });
    firstInput.setSelectionRange(0, 5);

    fireEvent.keyDown(firstInput, { key: "Delete" });

    expect(firstInput).toHaveValue("P2603310114291");
    expectInvokeCount("track_shipment", 0);
  });

  it("does not clear the row when Delete is pressed on the row checkbox", () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P2603310114291" } });

    const firstRowCheckbox = screen.getAllByRole("checkbox")[1];
    firstRowCheckbox.focus();
    fireEvent.keyDown(firstRowCheckbox, { key: "Delete" });

    expect(firstInput).toHaveValue("P2603310114291");
    expectInvokeCount("track_shipment", 0);
  });

  it("can start a fresh tracking request in a new sheet while another sheet is still loading", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P6" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const newSheetInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(newSheetInput, { target: { value: "P7" } });
    fireEvent.blur(newSheetInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    resolveRequest("P7");

    await waitFor(() => {
      expect(screen.queryByText("1/1 kiriman dimuat")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(screen.getByText("0/1 kiriman dimuat")).toBeInTheDocument();
    });
  });

  it("starts bulk paste tracking in a new sheet while another sheet is still loading", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P8" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    const newSheetInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    const pasteEvent = createEvent.paste(newSheetInput);
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text" ? "P9\nP10" : ""),
      },
    });
    fireEvent(newSheetInput, pasteEvent);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 3);
    });
  });

  it("keeps multiple in-flight row requests attached to their original sheet while switching tabs", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));
    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID");
    fireEvent.change(firstInput, { target: { value: "P3" } });
    fireEvent.blur(firstInput);
    fireEvent.change(secondInput, { target: { value: "P4" } });
    fireEvent.blur(secondInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));
    resolveRequest("P3");
    resolveRequest("P4");

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
    });
  });

  it("keeps async completion toasts visible after switching sheets", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PTOAST" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PTOAST");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Lacak Ulang" }));

    expect(screen.getByText("Proses lacak ulang dimulai.")).toBeInTheDocument();

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    resolveRequest("PTOAST");

    await waitFor(() => {
      expect(
        screen.getByText("Lacak ulang berhasil.")
      ).toBeInTheDocument();
    });
  });

  it("emits telemetry for request start, success, fail, and abort", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];

    fireEvent.change(firstInput, { target: { value: "P100" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInfoTelemetry("start", "P100");
    });

    fireEvent.change(firstInput, { target: { value: "P101" } });

    await waitFor(() => {
      expectInfoTelemetry("abort", "P100");
    });

    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInfoTelemetry("start", "P101");
    });

    pendingRequests.get("P101")?.reject(new Error("boom"));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "[ShipFlowTelemetry]",
        expect.objectContaining({
          event: "fail",
          shipmentId: "P101",
          classification: "unknown",
        })
      );
    });

    fireEvent.change(firstInput, { target: { value: "P102" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInfoTelemetry("start", "P102");
    });

    resolveRequest("P102");

    await waitFor(() => {
      expect(infoSpy).toHaveBeenCalledWith(
        "[ShipFlowTelemetry]",
        expect.objectContaining({
          event: "success",
          shipmentId: "P102",
          durationMs: expect.any(Number),
        })
      );
    });
  });

  it("rejects overlong tracking ids without invoking backend", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, {
      target: { value: `P${"1".repeat(80)}` },
    });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 0);
    });

    expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
  });

  it("dedupes duplicate in-flight requests for the same row", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P300" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    fireEvent.keyDown(firstInput, { key: "Enter" });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });
  });

  it("ignores late responses after a row is cleared while request is still running", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P400" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    fireEvent.change(firstInput, { target: { value: "" } });

    resolveRequest("P400");

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });
  });

  it("does not re-fetch a stale tracking id when an emptied input immediately blurs", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P405" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    fireEvent.change(firstInput, { target: { value: "" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
      expect(firstInput).toHaveValue("");
    });

    resolveRequest("P405");

    await waitFor(() => {
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
      expect(firstInput).toHaveValue("");
    });
  });

  it("aborts overwritten row requests before bulk paste applies replacement values", async () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText(
      "Masukkan ID"
    ) as HTMLInputElement[];
    fireEvent.change(firstInput, { target: { value: "P406" } });
    fireEvent.blur(firstInput);
    fireEvent.change(secondInput, { target: { value: "P407" } });
    fireEvent.blur(secondInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    const overlongTrackingId = `P${"1".repeat(80)}`;
    const pasteEvent = createEvent.paste(firstInput);
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text" ? `${overlongTrackingId}\nP408` : "",
      },
    });
    fireEvent(firstInput, pasteEvent);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 3);
      expect(firstInput).toHaveValue(overlongTrackingId);
      expect(secondInput).toHaveValue("P408");
      expectInfoTelemetry("abort", "P406");
      expectInfoTelemetry("abort", "P407");
    });

    resolveRequest("P406");
    resolveRequest("P407");

    await waitFor(() => {
      expect(firstInput).toHaveValue(overlongTrackingId);
      expect(secondInput).toHaveValue("P408");
    });

    resolveRequest("P408");

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
      expect(firstInput).toHaveValue(overlongTrackingId);
      expect(secondInput).toHaveValue("P408");
    });
  });

  it("keeps a dirty row visible while filters are active", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P500" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("P500");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.change(screen.getAllByPlaceholderText("Filter")[1], {
      target: { value: "ZZZ" },
    });

    fireEvent.change(screen.getAllByPlaceholderText("Masukkan ID")[0], {
      target: { value: "P501" },
    });

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("P501")[0]).toBeInTheDocument();
    });
  });

  it("deletes only selected rows without aborting other in-flight rows", async () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID");
    fireEvent.change(firstInput, { target: { value: "P700" } });
    fireEvent.blur(firstInput);
    fireEvent.change(secondInput, { target: { value: "P701" } });
    fireEvent.blur(secondInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Hapus Terselect" }));
    fireEvent.click(screen.getByRole("button", { name: "Konfirmasi Hapus Terselect" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("P700")).not.toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P701")[0]).toBeInTheDocument();
      expectInfoTelemetry("abort", "P700");
      expect(findTelemetryPayload(infoSpy, "abort", "P701")).toBeNull();
    });

    resolveRequest("P701");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  });

  it("clears hidden selections after deleting visible selected rows", async () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID");
    fireEvent.change(firstInput, { target: { value: "P800" } });
    fireEvent.blur(firstInput);
    fireEvent.change(secondInput, { target: { value: "P801" } });
    fireEvent.blur(secondInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    resolveRequest("P800");
    resolveRequest("P801");

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);

    fireEvent.change(screen.getAllByPlaceholderText("Filter")[0], {
      target: { value: "P800" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Hapus Terselect" }));
    fireEvent.click(screen.getByRole("button", { name: "Konfirmasi Hapus Terselect" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear Filter" }));

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("P801")[0]).toBeInTheDocument();
      expect(screen.getByText("0 row dipilih")).toBeInTheDocument();
    });
  });

  it("drops hidden selections when filters hide selected rows", async () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID");
    fireEvent.change(firstInput, { target: { value: "P820" } });
    fireEvent.blur(firstInput);
    fireEvent.change(secondInput, { target: { value: "P821" } });
    fireEvent.blur(secondInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
    });

    resolveRequest("P820");
    resolveRequest("P821");

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();

    fireEvent.change(screen.getAllByPlaceholderText("Filter")[0], {
      target: { value: "P820" },
    });

    await waitFor(() => {
      expect(screen.getByText("1 row dipilih")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear Filter" }));

    await waitFor(() => {
      expect(screen.getByText("1 row dipilih")).toBeInTheDocument();
    });
  });

  it("rejects malformed tracking responses before marking a row as success", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "PBAD" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "[ShipFlowTelemetry]",
        expect.objectContaining({
          event: "fail",
          shipmentId: "PBAD",
          classification: "invalid_response",
        })
      );
    });

    expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
  });

  it("keeps three sheets isolated under concurrent tracking pressure", async () => {
    render(<App />);

    const sheet1Input = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(sheet1Input, { target: { value: "P201" } });
    fireEvent.blur(sheet1Input);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));
    const sheet2Input = screen.getAllByPlaceholderText("Masukkan ID")[0];
    const pasteEvent = createEvent.paste(sheet2Input);
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text" ? "p202\n p203 \nP 204" : "",
      },
    });
    fireEvent(sheet2Input, pasteEvent);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));
    const sheet3Input = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(sheet3Input, { target: { value: "P205" } });
    fireEvent.blur(sheet3Input);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 5);
    });

    resolveRequest("P203");
    resolveRequest("P205");
    resolveRequest("P201");

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 3" }));
    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));
    await waitFor(() => {
      expect(screen.getByText("1/3 kiriman dimuat")).toBeInTheDocument();
    });

    resolveRequest("P202");
    resolveRequest("P204");

    await waitFor(() => {
      expect(screen.getByText("Total 3 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));
    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  });

  it("does not show redundant success toasts for sheet rename or deletion", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    openSheetTabMenu("Sheet 2");
    fireEvent.click(screen.getByRole("menuitem", { name: "Ganti Nama" }));

    const renameInput = screen.getByDisplayValue("Sheet 2");
    fireEvent.change(renameInput, { target: { value: "Sheet Renamed" } });
    fireEvent.blur(renameInput);

    expect(screen.getByRole("tab", { name: "Sheet Renamed" })).toBeInTheDocument();
    expect(screen.queryByText("Nama sheet berhasil diperbarui.")).not.toBeInTheDocument();

    openSheetTabMenu("Sheet Renamed");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Konfirmasi Hapus" }));

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Sheet Renamed" })).not.toBeInTheDocument();
    });

    expect(screen.queryByText("Sheet berhasil dihapus.")).not.toBeInTheDocument();
  });

  it("does not show redundant success toasts for copying ids", async () => {
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    try {
      render(<App />);

      const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
      fireEvent.change(firstInput, { target: { value: "PCOPY" } });
      fireEvent.blur(firstInput);

      await waitFor(() => {
        expectInvokeCount("track_shipment", 1);
      });

      resolveRequest("PCOPY");

      await waitFor(() => {
        expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy ID Kiriman" }));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("PCOPY");
      });

      expect(screen.queryByText("1 ID kiriman berhasil disalin.")).not.toBeInTheDocument();
      expect(screen.queryByText("ID kiriman berhasil disalin.")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        configurable: true,
      });
    }
  });

  it("applies and persists the selected display scale", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getByRole("radio", { name: /Besar/i }));

    await waitFor(() => {
      expect(document.querySelector("main.shell")).toHaveClass("display-scale-large");
    });

    expect(window.localStorage.getItem("shipflow-display-scale")).toBe("small");

    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(window.localStorage.getItem("shipflow-display-scale")).toBe("large");
  });

  it("opens ShipFlow Service from desktop settings", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getByRole("button", { name: "Buka ShipFlow Service" }));

    await waitFor(() => {
      expect(getInvokeCalls("open_shipflow_service_app")).toHaveLength(1);
    });
  });

  it("does not restore an unsaved workspace after the app remounts", () => {
    const firstRender = render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText(
      "Masukkan ID"
    ) as HTMLInputElement[];
    fireEvent.change(firstInput, { target: { value: "P2603310114291" } });
    fireEvent.change(secondInput, { target: { value: "P2603310114292" } });

    firstRender.unmount();

    render(<App />);

    const restoredInputs = screen.getAllByPlaceholderText(
      "Masukkan ID"
    ) as HTMLInputElement[];
    expect(restoredInputs[0]).toHaveValue("");
    expect(restoredInputs[1]).toHaveValue("");
  });

  it("restores the last saved workspace snapshot after the app remounts", async () => {
    const firstRender = render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PSAVED1" } });

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Simpan Sebagai" }));

    await waitFor(() => {
      expect(getInvokeCalls("write_workspace_document")).toHaveLength(1);
    });

    firstRender.unmount();

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("PSAVED1");
    });
  });

  it("saves the current workspace to a document file via Save As", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PSAVE1" } });

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Simpan Sebagai" }));

    await waitFor(() => {
      expect(getInvokeCalls("pick_workspace_document_path")).toHaveLength(1);
      expect(getInvokeCalls("write_workspace_document")).toHaveLength(1);
    });

    openFileMenu();
    expect(screen.getByRole("menuitem", { name: "picked-save.shipflow" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Simpan Otomatis" })).not.toBeDisabled();
  });

  it("opens a workspace from a document file path", async () => {
    render(<App />);

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buka" }));

    await waitFor(() => {
      expect(getInvokeCalls("pick_workspace_document_path")).toHaveLength(1);
      expect(getInvokeCalls("read_workspace_document")).toHaveLength(1);
    });

    expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("POPEN1");
    openFileMenu();
    expect(screen.getByRole("menuitem", { name: "picked-open.shipflow" })).toBeInTheDocument();
  });

  it("asks for confirmation before opening another document over unsaved changes", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PCANCEL1" } });

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buka" }));

    await waitFor(() => {
      expect(getInvokeCalls("pick_workspace_document_path")).toHaveLength(1);
      expect(confirmSpy).toHaveBeenCalledWith(
        "Perubahan belum disimpan. Buka dokumen lain?"
      );
    });

    expect(getInvokeCalls("read_workspace_document")).toHaveLength(0);
    expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("PCANCEL1");
  });

  it("autosaves changes back to the active workspace file", async () => {
    render(<App />);

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Simpan Sebagai" }));

    await waitFor(() => {
      expect(getInvokeCalls("write_workspace_document")).toHaveLength(1);
    });

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PAUTO1" } });

    await waitFor(() => {
      expect(getInvokeCalls("write_workspace_document")).toHaveLength(2);
    }, { timeout: 2000 });
  });

  it("can create and open workspaces in a new window", async () => {
    render(<App />);

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Jendela Baru" }));
    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buka di Jendela Baru" }));

    await waitFor(() => {
      expect(getInvokeCalls("create_workspace_window")).toHaveLength(2);
    });

    expect(getInvokeCalls("pick_workspace_document_path")).toHaveLength(1);
    expect(getInvokeCalls("create_workspace_window")[0]?.[1]).toMatchObject({
      documentPath: null,
    });
    expect(getInvokeCalls("create_workspace_window")[1]?.[1]).toMatchObject({
      documentPath: "/tmp/picked-open.shipflow",
    });
  });

  it("shows recent workspace files after save and open", async () => {
    render(<App />);

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Simpan Sebagai" }));

    await waitFor(() => {
      expect(getInvokeCalls("write_workspace_document")).toHaveLength(1);
    });

    openFileMenu();
    expect(screen.getByRole("menuitem", { name: "picked-save.shipflow" })).toBeInTheDocument();

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buka" }));

    await waitFor(() => {
      expect(getInvokeCalls("read_workspace_document")).toHaveLength(1);
    });

    openFileMenu();
    expect(screen.getByRole("menuitem", { name: "picked-open.shipflow" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "picked-save.shipflow" })).toBeInTheDocument();
  });

  it("does not open the same workspace twice when another window already owns it", async () => {
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "get_current_window_label") {
        return Promise.resolve("main");
      }

      if (command === "take_pending_workspace_window_request") {
        return Promise.resolve(null);
      }

      if (command === "pick_workspace_document_path") {
        return Promise.resolve("/tmp/picked-open.shipflow");
      }

      if (command === "claim_current_workspace_document") {
        return Promise.resolve({
          status: "alreadyOpen",
          path: args?.path ?? null,
          ownerLabel: "workspace-other",
        });
      }

      if (command === "set_current_window_title" || command === "log_frontend_runtime_event") {
        return Promise.resolve(undefined);
      }

      if (command === "load_saved_api_service_config") {
        return Promise.resolve(null);
      }

      if (command === "get_api_service_status") {
        return Promise.resolve({
          status: "stopped",
          enabled: false,
          mode: "local",
          bindAddress: "127.0.0.1",
          port: 18422,
          errorMessage: null,
        });
      }

      if (command === "configure_api_service") {
        return Promise.resolve({
          status: "stopped",
          enabled: false,
          mode: "local",
          bindAddress: "127.0.0.1",
          port: 18422,
          errorMessage: null,
        });
      }

      if (command === "resolve_pod_image" || command === "copy_to_clipboard") {
        return Promise.resolve(undefined);
      }

      if (command === "validate_tracking_source_config") {
        return Promise.resolve(undefined);
      }

      if (command === "test_external_tracking_source") {
        return Promise.resolve("OK");
      }

      if (command === "test_api_service_connection") {
        return Promise.resolve("OK");
      }

      if (command === "create_workspace_window") {
        return Promise.resolve({
          status: "alreadyOpen",
          path: args?.documentPath ?? null,
          ownerLabel: "workspace-other",
        });
      }

      if (command === "read_workspace_document") {
        throw new Error("read_workspace_document should not run for duplicate file");
      }

      if (command === "track_shipment") {
        const deferred = createDeferred<TrackResponse>();
        pendingRequests.set(args?.shipmentId ?? "unknown", deferred);
        return deferred.promise;
      }

      return Promise.resolve(undefined);
    });

    render(<App />);

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buka" }));

    await waitFor(() => {
      expect(screen.getByText("Dokumen itu sudah terbuka di jendela lain.")).toBeInTheDocument();
    });

    expect(getInvokeCalls("read_workspace_document")).toHaveLength(0);
  });

  it("heals invalid persisted empty rows that still carry tracking state", async () => {
    const sheetId = "sheet-stale";
    const invalidPersistedWorkspace = {
      version: 1,
      activeSheetId: sheetId,
      sheetOrder: [sheetId],
      sheetMetaById: {
        [sheetId]: {
          name: "Sheet 1",
        },
      },
      sheetsById: {
        [sheetId]: {
          rows: [
            {
              key: "row-stale",
              trackingInput: "",
              shipment: createTrackingResponse("PSTALE"),
              loading: false,
              stale: true,
              dirty: true,
              error: "stale state",
            },
          ],
          filters: {},
          valueFilters: {},
          sortState: {
            path: null,
            direction: "asc",
          },
          selectedRowKeys: [],
          selectionFollowsVisibleRows: false,
          columnWidths: {},
          hiddenColumnPaths: [],
          pinnedColumnPaths: [],
          openColumnMenuPath: null,
          highlightedColumnPath: null,
          deleteAllArmed: false,
        },
      },
    };

    window.localStorage.setItem(
      "shipflow-workspace-state",
      JSON.stringify(invalidPersistedWorkspace)
    );
    window.localStorage.setItem(
      "shipflow-workspace-document-meta",
      JSON.stringify({
        path: "/tmp/healed.shipflow",
        lastSavedAt: "2026-04-18T00:00:00.000Z",
      })
    );

    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    expect(firstInput).toHaveValue("");
    expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();

    await waitFor(() => {
      expect(window.localStorage.getItem("shipflow-workspace-state")).not.toContain(
        "PSTALE"
      );
    });
  });

  it("falls back to an inputs-only workspace snapshot when full workspace persistence fails", async () => {
    const originalSetItem = Storage.prototype.setItem;
    let shouldFailWorkspacePersist = true;

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key === "shipflow-workspace-state" && shouldFailWorkspacePersist) {
        shouldFailWorkspacePersist = false;
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }

      return originalSetItem.call(this, key, value);
    });

    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "P2603310114291" } });

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Simpan Sebagai" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("shipflow-workspace-state")).toContain(
        "P2603310114291"
      );
    });

    expect(firstInput).toHaveValue("P2603310114291");
  });

  it("rolls back previewed display scale when settings are cancelled", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getByRole("radio", { name: /Besar/i }));

    await waitFor(() => {
      expect(document.querySelector("main.shell")).toHaveClass("display-scale-large");
    });

    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    await waitFor(() => {
      expect(document.querySelector("main.shell")).toHaveClass("display-scale-small");
    });

    expect(window.localStorage.getItem("shipflow-display-scale")).toBe("small");
  });

  it("persists previewed service config only after settings are confirmed in the service window", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();
    expect(getInvokeCalls("configure_api_service")).toHaveLength(0);

    fireEvent.click(await screen.findByRole("tab", { name: "API" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Buka Akses API Eksternal" }));
    fireEvent.click(screen.getByLabelText("LAN / Jaringan Lokal"));
    fireEvent.change(screen.getByLabelText("Port"), {
      target: { value: "19422" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();

    const tokenField = screen.getByLabelText("Token API") as HTMLInputElement;
    expect(tokenField.value).toMatch(/^sf_[a-f0-9]+$/);

    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(getInvokeCalls("configure_api_service")).toHaveLength(1);
      expect(persistedServiceConfig?.enabled).toBe(true);
      expect(persistedServiceConfig?.mode).toBe("lan");
      expect(persistedServiceConfig?.port).toBe(19422);
      expect(persistedServiceConfig?.authToken).toMatch(/^sf_[a-f0-9]+$/);
      expect(persistedServiceConfig?.lastUpdatedAt).toBeTruthy();
    });
  });

  it("rolls back previewed service config and token when the service window resets changes", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();

    fireEvent.click(await screen.findByRole("tab", { name: "API" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Buka Akses API Eksternal" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Perubahan" }));

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();
    expect(getInvokeCalls("configure_api_service")).toHaveLength(0);

    expect(screen.getByRole("checkbox", { name: "Buka Akses API Eksternal" })).not.toBeChecked();
    expect((screen.getByLabelText("Token API") as HTMLInputElement).value).toBe("");
  });

  it("hides the ShipFlow Service window without discarding draft changes", async () => {
    mockedHideWindow.mockResolvedValue(undefined);
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Runtime Internal" }));
    fireEvent.click(await screen.findByRole("radio", { name: "API ShipFlow Eksternal" }));
    fireEvent.change(screen.getByLabelText("External API Base URL"), {
      target: { value: "https://internal-shipflow.test" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Sembunyikan" }));

    await waitFor(() => {
      expect(mockedHideWindow).toHaveBeenCalledTimes(1);
    });

    expect(getInvokeCalls("configure_api_service")).toHaveLength(0);
    expect(screen.getByLabelText("External API Base URL")).toHaveValue(
      "https://internal-shipflow.test"
    );
  });

  it("persists external tracking source settings after confirmation in the service window", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Runtime Internal" }));
    fireEvent.click(await screen.findByRole("radio", { name: "API ShipFlow Eksternal" }));
    fireEvent.change(screen.getByLabelText("External API Base URL"), {
      target: { value: "https://scrappid3.jacobcalvyn.io" },
    });
    fireEvent.change(screen.getByLabelText("External API Bearer Token"), {
      target: {
        value: "sf_32c18e59ecca4f91e23070d33c74a230a0ccc73161b6ae79",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(getInvokeCalls("configure_api_service")).toHaveLength(1);
      expect(persistedServiceConfig?.trackingSource).toBe("externalApi");
      expect(persistedServiceConfig?.externalApiBaseUrl).toBe(
        "https://scrappid3.jacobcalvyn.io"
      );
      expect(persistedServiceConfig?.externalApiAuthToken).toBe(
        "sf_32c18e59ecca4f91e23070d33c74a230a0ccc73161b6ae79"
      );
      expect(persistedServiceConfig?.allowInsecureExternalApiHttp).toBe(false);
    });
  });

  it("restores external tracking source selection and base URL in the service window even when the bearer token is session-only", async () => {
    persistedServiceConfig = {
      version: 1,
      desktopConnectionMode: "managedLocal",
      desktopServiceUrl: "http://127.0.0.1:18422",
      desktopServiceAuthToken: "",
      enabled: false,
      mode: "local",
      port: 18422,
      authToken: "",
      trackingSource: "externalApi",
      externalApiBaseUrl: "https://scrappid3.jacobcalvyn.io",
      externalApiAuthToken: "",
      allowInsecureExternalApiHttp: false,
      keepRunningInTray: true,
      lastUpdatedAt: "2026-04-18T00:00:00.000Z",
    };

    setShipFlowWindowKind("service-settings");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Runtime Internal" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(screen.getByRole("radio", { name: "API ShipFlow Eksternal" })).toBeChecked();
      expect(screen.getByLabelText("External API Base URL")).toHaveValue(
        "https://scrappid3.jacobcalvyn.io"
      );
      expect(screen.getByLabelText("External API Bearer Token")).toHaveValue("");
    });
  });

  it("persists custom desktop service connection settings from the service window", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Runtime Internal" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Service custom" }));
    fireEvent.change(screen.getByLabelText("Desktop Service URL"), {
      target: { value: "http://127.0.0.1:18423" },
    });
    fireEvent.change(screen.getByLabelText("Desktop Service Bearer Token"), {
      target: { value: "sf_custom_service_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tes Service" }));

    await waitFor(() => {
      expect(getInvokeCalls("test_api_service_connection")).toHaveLength(1);
      expect(
        screen.getByText("ShipFlow Service is reachable at http://127.0.0.1:18423.")
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(getInvokeCalls("configure_api_service")).toHaveLength(1);
      expect(persistedServiceConfig?.desktopConnectionMode).toBe("custom");
      expect(persistedServiceConfig?.enabled).toBe(false);
      expect(persistedServiceConfig?.desktopServiceUrl).toBe("http://127.0.0.1:18423");
      expect(persistedServiceConfig?.desktopServiceAuthToken).toBe("sf_custom_service_token");
    });
  });

  it("tests external tracking source config from the service window", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Runtime Internal" }));
    fireEvent.click(await screen.findByRole("radio", { name: "API ShipFlow Eksternal" }));
    fireEvent.change(screen.getByLabelText("External API Base URL"), {
      target: { value: "https://scrappid3.jacobcalvyn.io" },
    });
    fireEvent.change(screen.getByLabelText("External API Bearer Token"), {
      target: {
        value: "sf_32c18e59ecca4f91e23070d33c74a230a0ccc73161b6ae79",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tes" }));

    await waitFor(() => {
      expect(getInvokeCalls("test_external_tracking_source")).toHaveLength(1);
      expect(
        screen.getByText("Koneksi berhasil. Akses API aktif via lan (0.0.0.0:18422).")
      ).toBeInTheDocument();
    });
  });

  it("falls back to native clipboard bridge for copying all and selected tracking IDs", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "PCOPY1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PCOPY1");

    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy ID Kiriman" }));

    await waitFor(() => {
      const copyCalls = getInvokeCalls("copy_to_clipboard");
      expect(copyCalls).toHaveLength(1);
      expect(copyCalls[0]?.[1]).toMatchObject({ text: "PCOPY1" });
    });

    fireEvent.click(screen.getByLabelText("Select row PCOPY1"));
    fireEvent.click(screen.getByRole("button", { name: "Copy ID Kiriman Terselect" }));

    await waitFor(() => {
      const copyCalls = getInvokeCalls("copy_to_clipboard");
      expect(copyCalls).toHaveLength(2);
      expect(copyCalls[1]?.[1]).toMatchObject({ text: "PCOPY1" });
    });
  });

  it("blocks invalid external HTTP tracking config in the service window until insecure HTTP is explicitly allowed", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Runtime Internal" }));
    fireEvent.click(await screen.findByRole("radio", { name: "API ShipFlow Eksternal" }));
    fireEvent.change(screen.getByLabelText("External API Base URL"), {
      target: { value: "http://internal-shipflow.test" },
    });
    fireEvent.change(screen.getByLabelText("External API Bearer Token"), {
      target: { value: "sf_http_only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "External API base URL must use HTTPS unless insecure HTTP is explicitly allowed."
        )
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Izinkan HTTP non-TLS",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(persistedServiceConfig?.allowInsecureExternalApiHttp).toBe(true);
    });
  });

  it("blocks global delete and copy shortcuts while settings dialog is open", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P900" } });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    expect(screen.getByText("1 row dipilih")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));

    const okButton = screen.getByRole("button", { name: "OK" });
    okButton.focus();

    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.getAllByDisplayValue("P900")[0]).toBeInTheDocument();

    const setData = vi.fn();
    const copyEvent = createEvent.copy(document);
    Object.defineProperty(copyEvent, "clipboardData", {
      value: {
        setData,
      },
    });
    fireEvent(document, copyEvent);

    expect(setData).not.toHaveBeenCalled();
  });

  it("does not delete selected rows while a text selection is active", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P910" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByText("1 row dipilih")).toBeInTheDocument();

    const selectedText = document.createElement("div");
    selectedText.textContent = "P910";
    document.body.appendChild(selectedText);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyDown(window, { key: "Delete" });

    expect(screen.getByRole("button", { name: "Hapus Terselect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Konfirmasi Hapus Terselect" })).not.toBeInTheDocument();
    expect(screen.getAllByDisplayValue("P910")[0]).toBeInTheDocument();

    selection?.removeAllRanges();
    selectedText.remove();
  });

  it("prevents global Backspace navigation when focus is outside editable fields", async () => {
    render(<App />);

    const event = createEvent.keyDown(window, { key: "Backspace" });
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not use a global Delete shortcut for selected-row deletion", async () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID") as HTMLInputElement[];
    fireEvent.change(firstInput, { target: { value: "P915" } });
    fireEvent.change(secondInput, { target: { value: "P916" } });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Delete" });

    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Konfirmasi Hapus Terselect" })).not.toBeInTheDocument();
  });

  it("does not trigger selected-row deletion when Delete is pressed inside a focused input", () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID") as HTMLInputElement[];
    fireEvent.change(firstInput, { target: { value: "P920" } });
    fireEvent.change(secondInput, { target: { value: "P921" } });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();

    firstInput.focus();
    firstInput.setSelectionRange(0, firstInput.value.length);
    fireEvent.keyDown(firstInput, { key: "Delete" });

    expect(firstInput).toHaveValue("P920");
    expect(screen.queryByRole("button", { name: "Konfirmasi Hapus Terselect" })).not.toBeInTheDocument();
  });

  it("does not trigger selected-row deletion from a window keydown while an input still owns the text selection", async () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID") as HTMLInputElement[];
    fireEvent.change(firstInput, { target: { value: "P922" } });
    fireEvent.change(secondInput, { target: { value: "P923" } });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();

    firstInput.focus();
    firstInput.setSelectionRange(0, firstInput.value.length);
    fireEvent.keyDown(window, { key: "Delete" });

    expect(document.activeElement).toBe(firstInput);
    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Konfirmasi Hapus Terselect" })).not.toBeInTheDocument();
  });

  it("does not affect multi-row selection state when Delete is pressed inside an input", () => {
    render(<App />);

    const [firstInput, secondInput, thirdInput] = screen.getAllByPlaceholderText(
      "Masukkan ID"
    ) as HTMLInputElement[];
    fireEvent.change(firstInput, { target: { value: "P940" } });
    fireEvent.change(secondInput, { target: { value: "P941" } });
    fireEvent.change(thirdInput, { target: { value: "P942" } });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    fireEvent.click(screen.getAllByRole("checkbox")[3]);
    expect(screen.getByText("3 row dipilih")).toBeInTheDocument();

    secondInput.focus();
    secondInput.setSelectionRange(0, secondInput.value.length);
    fireEvent.keyDown(secondInput, { key: "Delete" });

    expect(secondInput).toHaveValue("P941");
    expect(screen.getByText("3 row dipilih")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Konfirmasi Hapus Terselect" })).not.toBeInTheDocument();
  });

  it("does not trigger custom Enter behavior when text is selected inside a focused input", async () => {
    render(<App />);

    const [firstInput, secondInput] = screen.getAllByPlaceholderText("Masukkan ID") as HTMLInputElement[];
    fireEvent.change(firstInput, { target: { value: "P930" } });
    fireEvent.change(secondInput, { target: { value: "P931" } });

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();

    firstInput.focus();
    firstInput.setSelectionRange(0, firstInput.value.length);
    fireEvent.keyDown(firstInput, { key: "Enter" });

    expect(document.activeElement).toBe(firstInput);
    expect(screen.getByText("2 row dipilih")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Konfirmasi Hapus Terselect" })).not.toBeInTheDocument();
    expectInvokeCount("track_shipment", 0);
  });
});
