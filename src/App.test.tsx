import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "./App";
import {
  BagResponse,
  ManifestResponse,
  ServiceConfig,
  TrackResponse,
} from "./types";
import { WorkspaceDocumentFile } from "./features/workspace/document";

vi.setConfig({ testTimeout: 20_000 });

const { MockChannel, mockedInvoke } = vi.hoisted(() => ({
  MockChannel: vi.fn().mockImplementation(function Channel(
    this: { onmessage: unknown },
    onmessage: unknown
  ) {
    this.onmessage = onmessage;
  }),
  mockedInvoke: vi.fn<
    (
      command: string,
      args?: {
        command?: {
          command: string;
          payload?: unknown;
        };
        request?: {
          jobId?: string;
        };
        onEvent?: {
          onmessage?: (event: unknown) => void;
        };
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
  Channel: MockChannel,
  invoke: mockedInvoke,
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
  const trackingId = bagId.endsWith("-DOTTED")
    ? "P2606020189412.30"
    : bagId.endsWith("-3")
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
  const bagId = manifestId.endsWith("-DOTTED")
    ? "PID123456-DOTTED"
    : manifestId.endsWith("-3")
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

type WorkspaceEngineImportJobFixture = {
  jobId: string;
  sheetId: string;
  kind: "bag" | "manifest";
  mode: "replace" | "append";
  ids: string[];
};

function extractBagFixtureTrackingIds(bagId: string) {
  return createBagResponse(bagId).items
    .map((item) => item.no_resi?.trim() ?? "")
    .filter((trackingId) => trackingId !== "");
}

function extractManifestFixtureBagIds(manifestId: string) {
  return createManifestResponse(manifestId).items
    .map((item) => item.nomor_kantung?.trim() ?? "")
    .filter((bagId) => bagId !== "");
}

function resolveWorkspaceEngineImportTrackingIds(job: WorkspaceEngineImportJobFixture) {
  if (job.kind === "bag") {
    return Array.from(
      new Set(job.ids.flatMap((bagId) => extractBagFixtureTrackingIds(bagId)))
    );
  }

  return Array.from(
    new Set(
      job.ids
        .flatMap((manifestId) => extractManifestFixtureBagIds(manifestId))
        .flatMap((bagId) => extractBagFixtureTrackingIds(bagId))
    )
  );
}

function getLookupTrackingId(trackingId: string) {
  return trackingId.replace(/\.\d+$/, "");
}

type WorkspaceEngineSheetRowFixture = {
  rowId: string;
  position: number;
  displayTrackingId: string;
  lookupTrackingId: string;
  rowStatus: "empty" | "loading" | "loaded" | "failed" | "stale";
  errorMessage: string | null;
  statusJson: TrackResponse["status_akhir"] | null;
  detailJson: TrackResponse["detail"] | null;
  historyJson: {
    pod: TrackResponse["pod"];
    history: TrackResponse["history"];
    history_summary: TrackResponse["history_summary"];
  } | null;
};

function createWorkspaceEngineSheetRow(
  sheetId: string,
  trackingId: string,
  position: number,
  includeTrackingDetail = false
): WorkspaceEngineSheetRowFixture {
  const response = includeTrackingDetail
    ? createTrackingResponse(trackingId)
    : null;

  return {
    rowId: `${sheetId}:row:${position}`,
    position,
    displayTrackingId: trackingId,
    lookupTrackingId: getLookupTrackingId(trackingId),
    rowStatus: "loaded",
    errorMessage: null,
    statusJson: response?.status_akhir ?? null,
    detailJson: response?.detail ?? null,
    historyJson: response
      ? {
          pod: response.pod,
          history: response.history,
          history_summary: response.history_summary,
        }
      : null,
  };
}

function createWorkspaceEngineSheetRows(
  sheetId: string,
  trackingIds: string[],
  existingRows: WorkspaceEngineSheetRowFixture[] = []
) {
  const existingRowByTrackingId = new Map(
    existingRows.map((row) => [row.displayTrackingId, row])
  );

  return trackingIds.map((trackingId, position) => {
    const existingRow = existingRowByTrackingId.get(trackingId);
    if (existingRow) {
      return {
        ...existingRow,
        rowId: `${sheetId}:row:${position}`,
        position,
      };
    }

    return createWorkspaceEngineSheetRow(sheetId, trackingId, position);
  });
}

function upsertWorkspaceEngineSheetRows(
  sheetId: string,
  rows: Array<{
    rowId: string;
    position: number;
    displayTrackingId: string;
  }>,
  existingRows: WorkspaceEngineSheetRowFixture[] = []
) {
  const existingRowById = new Map(existingRows.map((row) => [row.rowId, row]));
  const nextRows = [...existingRows];

  rows.forEach((row) => {
    const existingRow = existingRowById.get(row.rowId);
    nextRows[row.position] = {
      ...(existingRow ??
        createWorkspaceEngineSheetRow(
          sheetId,
          row.displayTrackingId,
          row.position
        )),
      rowId: row.rowId,
      position: row.position,
      displayTrackingId: row.displayTrackingId,
      lookupTrackingId: getLookupTrackingId(row.displayTrackingId),
      rowStatus: existingRow?.rowStatus ?? "empty",
      errorMessage: existingRow?.errorMessage ?? null,
      statusJson: existingRow?.statusJson ?? null,
      detailJson: existingRow?.detailJson ?? null,
      historyJson: existingRow?.historyJson ?? null,
    };
  });

  return nextRows
    .filter((row): row is WorkspaceEngineSheetRowFixture => row !== undefined)
    .sort((left, right) => left.position - right.position);
}

function getNestedFixtureValue(source: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return null;
    }

    return (current as Record<string, unknown>)[segment] ?? null;
  }, source);
}

function getWorkspaceEngineSheetRowFieldText(
  row: WorkspaceEngineSheetRowFixture,
  field: string
) {
  if (field === "detail.shipment_header.nomor_kiriman") {
    return String(
      getNestedFixtureValue(row.detailJson, "shipment_header.nomor_kiriman") ??
        row.displayTrackingId
    );
  }

  if (field.startsWith("detail.")) {
    return String(getNestedFixtureValue(row.detailJson, field.slice(7)) ?? "");
  }

  if (field.startsWith("status_akhir.")) {
    return String(getNestedFixtureValue(row.statusJson, field.slice(13)) ?? "");
  }

  return "";
}

function createWorkspaceEnginePreviewItem(
  sourceItemId: string,
  sourceItemKind: "bag" | "manifest" | "manifest_bag",
  trackingIds: string[],
  errorMessage: string | null = null
) {
  return {
    sourceItemId,
    sourceItemKind,
    status: errorMessage ? "failed" : "succeeded",
    trackingIds,
    errorMessage,
  };
}

function getWorkspaceEngineSheetRowIdsForTrackingIds(
  rows: WorkspaceEngineSheetRowFixture[],
  trackingIds: string[]
) {
  const rowIdByTrackingId = new Map(
    rows.map((row) => [row.displayTrackingId, row.rowId])
  );
  const rowIds: string[] = [];

  trackingIds.forEach((trackingId) => {
    const rowId = rowIdByTrackingId.get(trackingId);
    if (rowId && !rowIds.includes(rowId)) {
      rowIds.push(rowId);
    }
  });

  return rowIds;
}

function createWorkspaceEngineImportJobDetail(
  job: WorkspaceEngineImportJobFixture,
  status: "running" | "completed" = "running",
  trackingIds: string[] = [],
  rows: WorkspaceEngineSheetRowFixture[] = []
) {
  const sourceItems = job.ids.map((id, index) => {
    const itemTrackingIds =
      job.kind === "bag"
        ? extractBagFixtureTrackingIds(id)
        : extractManifestFixtureBagIds(id);

    return {
      itemId: `${job.jobId}:source:${index}`,
      sourceItemId: id,
      sourceItemKind: job.kind,
      position: index,
      status: status === "completed" ? "succeeded" : "pending",
      trackingIds: itemTrackingIds,
      sheetRowIds:
        status === "completed" && job.kind === "bag"
          ? getWorkspaceEngineSheetRowIdsForTrackingIds(rows, itemTrackingIds)
          : [],
      errorMessage: null,
      attemptCount: status === "completed" ? 1 : 0,
    };
  });
  const manifestBagItems =
    job.kind === "manifest" && status === "completed"
      ? job.ids
          .flatMap((id) => extractManifestFixtureBagIds(id))
          .map((bagId, index) => {
            const itemTrackingIds = extractBagFixtureTrackingIds(bagId);

            return {
              itemId: `${job.jobId}:manifest-bag:${job.ids.length + index}`,
              sourceItemId: bagId,
              sourceItemKind: "manifest_bag",
              position: job.ids.length + index,
              status: "succeeded",
              trackingIds: itemTrackingIds,
              sheetRowIds: getWorkspaceEngineSheetRowIdsForTrackingIds(
                rows,
                itemTrackingIds
              ),
              errorMessage: null,
              attemptCount: 1,
            };
          })
      : [];

  return {
    summary: {
      jobId: job.jobId,
      sheetId: job.sheetId,
      kind: job.kind,
      mode: job.mode,
      status,
      totalCount: job.ids.length,
      successCount: status === "completed" ? job.ids.length : 0,
      failedCount: 0,
      pendingCount: status === "completed" ? 0 : job.ids.length,
    },
    items:
      job.kind === "manifest" && trackingIds.length > 0
        ? [...sourceItems, ...manifestBagItems]
        : sourceItems,
  };
}

function getInvokeCalls(command: string) {
  return mockedInvoke.mock.calls.filter(([name]) => name === command);
}

let trackedShipmentIds: string[] = [];

function expectInvokeCount(command: string, count: number) {
  if (command === "track_shipment") {
    expect(trackedShipmentIds).toHaveLength(count);
    return;
  }

  expect(getInvokeCalls(command)).toHaveLength(count);
}

function expectLegacyTrackShipmentInvokeCount(count: number) {
  expect(getInvokeCalls("track_shipment")).toHaveLength(count);
}

function getWorkspaceEngineCommandCalls(command: string) {
  return getInvokeCalls("workspace_engine_command").filter(
    ([, args]) => args?.command?.command === command
  );
}

function expectWorkspaceEngineCommandCount(command: string, count: number) {
  expect(getWorkspaceEngineCommandCalls(command)).toHaveLength(count);
}

function expectWorkspaceEngineRefreshCount(count: number) {
  expectWorkspaceEngineCommandCount("refresh_sheet_rows_tracking", count);
}

function createDragDataTransfer(): DataTransfer {
  const values = new Map<string, string>();

  return {
    dropEffect: "none",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [] as unknown as readonly string[],
    clearData: vi.fn((format?: string) => {
      if (format) {
        values.delete(format);
      } else {
        values.clear();
      }
    }),
    getData: vi.fn((format: string) => values.get(format) ?? ""),
    setData: vi.fn((format: string, data: string) => {
      values.set(format, data);
    }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function dragElementToList(source: HTMLElement, target: HTMLElement) {
  const dataTransfer = createDragDataTransfer();
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
  fireEvent.dragEnd(source, { dataTransfer });
  return dataTransfer;
}

function startDragElementOverList(source: HTMLElement, target: HTMLElement) {
  const dataTransfer = createDragDataTransfer();
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  return dataTransfer;
}

function getTrackedShipmentIds() {
  return trackedShipmentIds;
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
  const persistedWorkspaceDocuments = new Map<string, WorkspaceDocumentFile>();
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let persistedServiceConfig: ServiceConfig | null;
  let workspaceEngineUpsertFailureMessage: string | null;

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

  function rejectBagRequest(bagId: string, message = "Bag lookup failed") {
    const request = pendingBagRequests.get(bagId);
    if (!request) {
      throw new Error(`No pending bag request for ${bagId}`);
    }

    request.reject(new Error(message));
  }

  function resolveManifestRequest(manifestId: string) {
    const request = pendingManifestRequests.get(manifestId);
    if (!request) {
      throw new Error(`No pending manifest request for ${manifestId}`);
    }

    request.resolve(createManifestResponse(manifestId));
  }

  beforeEach(() => {
    mockedInvoke.mockReset();
    trackedShipmentIds = [];
    pendingRequests.clear();
    pendingBagRequests.clear();
    pendingManifestRequests.clear();
    persistedWorkspaceDocuments.clear();
    persistedServiceConfig = null;
    workspaceEngineUpsertFailureMessage = null;
    const workspaceEngineJobs = new Map<string, WorkspaceEngineImportJobFixture>();
    const workspaceEngineRowsBySheet = new Map<
      string,
      WorkspaceEngineSheetRowFixture[]
    >();
    let workspaceEngineJobSequence = 0;
    window.localStorage.clear();
    setShipFlowWindowKind("workspace");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      if (
        args.some(
          (arg) =>
            typeof arg === "string" && arg.includes("Maximum update depth exceeded")
        )
      ) {
        throw new Error("React maximum update depth exceeded");
      }
    });
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
            new Error("External API token is required.")
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

      if (command === "read_from_clipboard") {
        return Promise.resolve("sf_clipboard_token");
      }

      if (command === "open_shipflow_service_app") {
        return Promise.resolve(undefined);
      }

      if (command === "workspace_engine_command") {
        const workspaceCommand = args?.command;

        if (workspaceCommand?.command === "list_sheets") {
          return Promise.resolve({
            type: "sheets",
            payload: [],
          });
        }

        if (workspaceCommand?.command === "preview_import_source") {
          const payload = workspaceCommand.payload as {
            kind: "bag" | "manifest";
            ids: string[];
          };
          const requestBagPreview = async (bagId: string) => {
            mockedInvoke.mock.calls.push([
              "track_bag",
              {
                bagId,
                forceRefresh: true,
              },
            ]);
            const deferred = createDeferred<BagResponse>();
            pendingBagRequests.set(bagId, deferred);

            try {
              const response = await deferred.promise;
              return {
                response,
                item: createWorkspaceEnginePreviewItem(
                  bagId,
                  payload.kind === "manifest" ? "manifest_bag" : "bag",
                  response.items
                    .map((item) => item.no_resi?.trim() ?? "")
                    .filter((trackingId) => trackingId !== "")
                ),
              };
            } catch (error) {
              return {
                response: null,
                item: createWorkspaceEnginePreviewItem(
                  bagId,
                  payload.kind === "manifest" ? "manifest_bag" : "bag",
                  [],
                  error instanceof Error ? error.message : "Bag lookup failed"
                ),
              };
            }
          };

          if (payload.kind === "bag") {
            return Promise.all(payload.ids.map(requestBagPreview)).then(
              (results) => ({
                type: "import_source_preview",
                payload: {
                  kind: "bag",
                  sourceItems: results.map((result) => result.item),
                  manifestBags: [],
                  trackingIds: Array.from(
                    new Set(
                      results.flatMap((result) => result.item.trackingIds)
                    )
                  ),
                  rawResponse: JSON.stringify(
                    results
                      .map((result) => result.response)
                      .filter((response): response is BagResponse => response !== null)
                  ),
                },
              })
            );
          }

          return Promise.all(
            payload.ids.map(async (manifestId) => {
              mockedInvoke.mock.calls.push([
                "track_manifest",
                {
                  manifestId,
                  forceRefresh: true,
                },
              ]);
              const deferred = createDeferred<ManifestResponse>();
              pendingManifestRequests.set(manifestId, deferred);

              try {
                const response = await deferred.promise;
                return {
                  response,
                  item: createWorkspaceEnginePreviewItem(
                    manifestId,
                    "manifest",
                    response.items
                      .map((item) => item.nomor_kantung?.trim() ?? "")
                      .filter((bagId) => bagId !== "")
                  ),
                };
              } catch (error) {
                return {
                  response: null,
                  item: createWorkspaceEnginePreviewItem(
                    manifestId,
                    "manifest",
                    [],
                    error instanceof Error
                      ? error.message
                      : "Manifest lookup failed"
                  ),
                };
              }
            })
          ).then(async (manifestResults) => {
            const bagIds = Array.from(
              new Set(manifestResults.flatMap((result) => result.item.trackingIds))
            );
            const bagResults = await Promise.all(bagIds.map(requestBagPreview));

            return {
              type: "import_source_preview",
              payload: {
                kind: "manifest",
                sourceItems: manifestResults.map((result) => result.item),
                manifestBags: bagResults.map((result) => result.item),
                trackingIds: Array.from(
                  new Set(bagResults.flatMap((result) => result.item.trackingIds))
                ),
                rawResponse: JSON.stringify(
                  manifestResults
                    .map((result) => result.response)
                    .filter(
                      (response): response is ManifestResponse => response !== null
                    )
                ),
              },
            };
          });
        }

        if (workspaceCommand?.command === "create_import_job") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
            kind: "bag" | "manifest";
            ids: string[];
            mode: "replace" | "append";
          };
          workspaceEngineJobSequence += 1;
          const job: WorkspaceEngineImportJobFixture = {
            jobId: `workspace-engine-job-${workspaceEngineJobSequence}`,
            sheetId: payload.sheetId,
            kind: payload.kind,
            mode: payload.mode,
            ids: payload.ids,
          };
          workspaceEngineJobs.set(job.jobId, job);

          return Promise.resolve({
            type: "import_job_detail",
            payload: createWorkspaceEngineImportJobDetail(job),
          });
        }

        if (workspaceCommand?.command === "get_import_job") {
          const payload = workspaceCommand.payload as {
            jobId: string;
          };
          const job = workspaceEngineJobs.get(payload.jobId);
          if (!job) {
            return Promise.reject(
              new Error(`Missing workspace engine job: ${payload.jobId}`)
            );
          }
          const isCommitted = workspaceEngineRowsBySheet.has(job.sheetId);
          const committedRows = workspaceEngineRowsBySheet.get(job.sheetId) ?? [];

          return Promise.resolve({
            type: "import_job_detail",
            payload: createWorkspaceEngineImportJobDetail(
              job,
              isCommitted ? "completed" : "running",
              isCommitted ? resolveWorkspaceEngineImportTrackingIds(job) : [],
              isCommitted ? committedRows : []
            ),
          });
        }

        if (workspaceCommand?.command === "create_sheet") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
            name: string;
            position: number;
          };
          workspaceEngineRowsBySheet.set(
            payload.sheetId,
            workspaceEngineRowsBySheet.get(payload.sheetId) ?? []
          );

          return Promise.resolve({
            type: "sheet",
            payload: {
              sheetId: payload.sheetId,
              workspaceId: "workspace-1",
              name: payload.name,
              position: payload.position,
              viewMode: "workspace",
            },
          });
        }

        if (workspaceCommand?.command === "rename_sheet") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
            name: string;
          };

          return Promise.resolve({
            type: "sheet",
            payload: {
              sheetId: payload.sheetId,
              workspaceId: "workspace-1",
              name: payload.name,
              position: 0,
              viewMode: "workspace",
            },
          });
        }

        if (workspaceCommand?.command === "query_sheet_rows") {
          const payload = workspaceCommand.payload as {
            query: {
              sheetId: string;
              offset: number;
              limit: number;
              filters?: Array<{
                field: string;
                value: string;
              }>;
              valueFilters?: Array<{
                field: string;
                values: string[];
              }>;
            };
          };
          const allRows = workspaceEngineRowsBySheet.get(payload.query.sheetId) ?? [];
          const filteredRows = allRows.filter((row) => {
            const matchesTextFilters = (payload.query.filters ?? []).every((filter) =>
              getWorkspaceEngineSheetRowFieldText(row, filter.field)
                .toLocaleLowerCase()
                .includes(filter.value.toLocaleLowerCase())
            );
            const matchesValueFilters = (payload.query.valueFilters ?? []).every(
              (filter) =>
                filter.values.includes(
                  getWorkspaceEngineSheetRowFieldText(row, filter.field)
                )
            );

            return matchesTextFilters && matchesValueFilters;
          });
          const rows = filteredRows
            .slice(payload.query.offset, payload.query.offset + payload.query.limit);

          return Promise.resolve({
            type: "sheet_rows",
            payload: {
              sheetId: payload.query.sheetId,
              offset: payload.query.offset,
              limit: payload.query.limit,
              totalCount: filteredRows.length,
              hasMore: payload.query.offset + rows.length < filteredRows.length,
              nextOffset:
                payload.query.offset + rows.length < filteredRows.length
                  ? payload.query.offset + rows.length
                  : null,
              rows,
            },
          });
        }

        if (workspaceCommand?.command === "clear_sheet_rows") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
          };
          workspaceEngineRowsBySheet.set(payload.sheetId, []);

          return Promise.resolve({
            type: "sheet_rows",
            payload: {
              sheetId: payload.sheetId,
              offset: 0,
              limit: 0,
              totalCount: 0,
              hasMore: false,
              nextOffset: null,
              rows: [],
            },
          });
        }

        if (workspaceCommand?.command === "delete_sheet") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
          };
          workspaceEngineRowsBySheet.delete(payload.sheetId);

          return Promise.resolve({
            type: "sheet_deleted",
            payload: {
              sheetId: payload.sheetId,
            },
          });
        }

        if (workspaceCommand?.command === "delete_sheet_rows") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
            rowIds: string[];
          };
          const deletedRowIds = new Set(payload.rowIds);
          const nextRows = (workspaceEngineRowsBySheet.get(payload.sheetId) ?? [])
            .filter((row) => !deletedRowIds.has(row.rowId))
            .map((row, position) => ({
              ...row,
              position,
            }));
          workspaceEngineRowsBySheet.set(payload.sheetId, nextRows);

          return Promise.resolve({
            type: "sheet_rows",
            payload: {
              sheetId: payload.sheetId,
              offset: 0,
              limit: nextRows.length,
              totalCount: nextRows.length,
              hasMore: false,
              nextOffset: null,
              rows: nextRows,
            },
          });
        }

        if (workspaceCommand?.command === "transfer_sheet_rows") {
          const payload = workspaceCommand.payload as {
            sourceSheetId: string;
            targetSheetId: string;
            rowIds: string[];
            mode: "copy" | "move";
          };
          const sourceRows = workspaceEngineRowsBySheet.get(payload.sourceSheetId) ?? [];
          const targetRows = workspaceEngineRowsBySheet.get(payload.targetSheetId) ?? [];
          const sourceRowIds = new Set(payload.rowIds);
          const copiedRows = payload.rowIds
            .map((rowId) => sourceRows.find((row) => row.rowId === rowId))
            .filter((row): row is WorkspaceEngineSheetRowFixture => row !== undefined)
            .map((row, index) => ({
              ...row,
              rowId: `${payload.targetSheetId}:row:${targetRows.length + index}`,
              position: targetRows.length + index,
            }));
          const nextTargetRows = [...targetRows, ...copiedRows];
          workspaceEngineRowsBySheet.set(payload.targetSheetId, nextTargetRows);

          if (payload.mode === "move") {
            workspaceEngineRowsBySheet.set(
              payload.sourceSheetId,
              sourceRows
                .filter((row) => !sourceRowIds.has(row.rowId))
                .map((row, position) => ({
                  ...row,
                  position,
                }))
            );
          }

          return Promise.resolve({
            type: "sheet_rows",
            payload: {
              sheetId: payload.targetSheetId,
              offset: 0,
              limit: nextTargetRows.length,
              totalCount: nextTargetRows.length,
              hasMore: false,
              nextOffset: null,
              rows: nextTargetRows,
            },
          });
        }

        if (workspaceCommand?.command === "copy_sheet_rows") {
          const payload = workspaceCommand.payload as {
            sourceSheetId: string;
            targetSheetId: string;
          };
          const sourceRows = workspaceEngineRowsBySheet.get(payload.sourceSheetId) ?? [];
          const targetRows = workspaceEngineRowsBySheet.get(payload.targetSheetId) ?? [];
          const copiedRows = sourceRows.map((row, index) => ({
            ...row,
            rowId: `${payload.targetSheetId}:row:${targetRows.length + index}`,
            position: targetRows.length + index,
          }));
          const nextTargetRows = [...targetRows, ...copiedRows];
          workspaceEngineRowsBySheet.set(payload.targetSheetId, nextTargetRows);

          return Promise.resolve({
            type: "sheet_rows",
            payload: {
              sheetId: payload.targetSheetId,
              offset: 0,
              limit: nextTargetRows.length,
              totalCount: nextTargetRows.length,
              hasMore: false,
              nextOffset: null,
              rows: nextTargetRows,
            },
          });
        }

        if (workspaceCommand?.command === "upsert_sheet_rows") {
          if (workspaceEngineUpsertFailureMessage) {
            return Promise.reject(new Error(workspaceEngineUpsertFailureMessage));
          }

          const payload = workspaceCommand.payload as {
            sheetId: string;
            rows: Array<{
              rowId: string;
              position: number;
              displayTrackingId: string;
            }>;
          };
          const allRows = workspaceEngineRowsBySheet.get(payload.sheetId) ?? [];
          const nextRows = upsertWorkspaceEngineSheetRows(
            payload.sheetId,
            payload.rows,
            allRows
          );
          workspaceEngineRowsBySheet.set(payload.sheetId, nextRows);

          return Promise.resolve({
            type: "sheet_rows",
            payload: {
              sheetId: payload.sheetId,
              offset: 0,
              limit: nextRows.length,
              totalCount: nextRows.length,
              hasMore: false,
              nextOffset: null,
              rows: nextRows,
            },
          });
        }

        if (workspaceCommand?.command === "refresh_sheet_row_tracking") {
          const payload = workspaceCommand.payload as {
            rowId: string;
            forceRefresh: boolean;
          };
          let sheetId = "";
          const allRows = Array.from(workspaceEngineRowsBySheet.entries()).find(
            ([, rows]) => rows.some((row) => row.rowId === payload.rowId)
          );
          if (!allRows) {
            return Promise.reject(
              new Error(`Missing workspace engine row: ${payload.rowId}`)
            );
          }

          sheetId = allRows[0];
          const rows = [...allRows[1]];
          const rowIndex = rows.findIndex((row) => row.rowId === payload.rowId);
          const row = rows[rowIndex];
          if (!row) {
            return Promise.reject(
              new Error(`Missing workspace engine row: ${payload.rowId}`)
            );
          }

          const setRefreshedRow = (
            refreshedRow: WorkspaceEngineSheetRowFixture
          ) => {
            const latestRows = workspaceEngineRowsBySheet.get(sheetId) ?? [];
            const latestRowIndex = latestRows.findIndex(
              (candidate) => candidate.rowId === payload.rowId
            );
            const nextRows = [...latestRows];
            nextRows[latestRowIndex >= 0 ? latestRowIndex : rowIndex] =
              refreshedRow;
            workspaceEngineRowsBySheet.set(sheetId, nextRows);
            return refreshedRow;
          };
          const createFailedRow = (message: string) =>
            setRefreshedRow({
              ...row,
              rowStatus: "failed",
              errorMessage: message,
            });

          trackedShipmentIds.push(row.lookupTrackingId);

          if (row.lookupTrackingId === "PBAD") {
            return Promise.resolve({
              type: "sheet_row",
              payload: createFailedRow("invalid tracking response shape"),
            });
          }

          const deferred = createDeferred<TrackResponse>();
          pendingRequests.set(row.lookupTrackingId, deferred);

          return deferred.promise
            .then((response): WorkspaceEngineSheetRowFixture => ({
              ...row,
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: response.status_akhir,
              detailJson: response.detail,
              historyJson: {
                pod: response.pod,
                history: response.history,
                history_summary: response.history_summary,
              },
            }))
            .catch((error): WorkspaceEngineSheetRowFixture => ({
              ...row,
              rowStatus: "failed",
              errorMessage:
                error instanceof Error ? error.message : "Tracking request failed.",
            }))
            .then((refreshedRow) => ({
              type: "sheet_row",
              payload: setRefreshedRow(refreshedRow),
            }));
        }

        if (workspaceCommand?.command === "refresh_sheet_rows_tracking") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
            rowIds: string[];
            forceRefresh: boolean;
          };
          const allRows = workspaceEngineRowsBySheet.get(payload.sheetId) ?? [];
          const shouldReturnRows = payload.rowIds.length > 0;
          const rowIds =
            payload.rowIds.length > 0
              ? payload.rowIds
              : allRows.map((row) => row.rowId);
          const nextRows = [...allRows];
          const rows = rowIds
            .map((rowId) => {
              const prefix = `${payload.sheetId}:row:`;
              const position = rowId.startsWith(prefix)
                ? Number(rowId.slice(prefix.length))
                : allRows.findIndex((row) => row.rowId === rowId);
              if (position < 0) {
                return null;
              }
              const row = allRows[position];
              if (!row) {
                return null;
              }
              trackedShipmentIds.push(row.lookupTrackingId);
              const refreshedRow = createWorkspaceEngineSheetRow(
                payload.sheetId,
                row.displayTrackingId,
                position,
                true
              );
              nextRows[position] = refreshedRow;
              return refreshedRow;
            })
            .filter(
              (row): row is ReturnType<typeof createWorkspaceEngineSheetRow> =>
                row !== null
            );
          workspaceEngineRowsBySheet.set(payload.sheetId, nextRows);

          return Promise.resolve({
            type: "sheet_rows_tracking_refresh",
            payload: {
              sheetId: payload.sheetId,
              successCount: rows.length,
              failedCount: 0,
              rows: shouldReturnRows ? rows : [],
            },
          });
        }

        if (workspaceCommand?.command === "query_pivot") {
          const payload = workspaceCommand.payload as {
            sheetId: string;
          };
          const allRows = workspaceEngineRowsBySheet.get(payload.sheetId) ?? [];

          return Promise.resolve({
            type: "pivot",
            payload: {
              sheetId: payload.sheetId,
              sourceRowCount: allRows.length,
              rows: [],
            },
          });
        }

        if (workspaceCommand?.command === "query_chart") {
          const payload = workspaceCommand.payload as {
            pivotQuery: {
              sheetId: string;
            };
            chartType: "bar" | "donut";
          };
          const allRows =
            workspaceEngineRowsBySheet.get(payload.pivotQuery.sheetId) ?? [];

          return Promise.resolve({
            type: "chart",
            payload: {
              sheetId: payload.pivotQuery.sheetId,
              chartType: payload.chartType,
              sourceRowCount: allRows.length,
              series: [],
            },
          });
        }
      }

      if (command === "workspace_engine_run_import_job_with_progress") {
        const jobId = args?.request?.jobId ?? "";
        const job = workspaceEngineJobs.get(jobId);
        if (!job) {
          return Promise.reject(new Error(`Missing workspace engine job: ${jobId}`));
        }

        const trackingIds = resolveWorkspaceEngineImportTrackingIds(job);
        const currentRows = workspaceEngineRowsBySheet.get(job.sheetId) ?? [];
        const currentTrackingIds = currentRows.map((row) => row.displayTrackingId);
        const nextTrackingIds =
          job.mode === "replace"
            ? trackingIds
            : Array.from(new Set([...currentTrackingIds, ...trackingIds]));
        const committedRows = createWorkspaceEngineSheetRows(
          job.sheetId,
          nextTrackingIds,
          currentRows
        );
        workspaceEngineRowsBySheet.set(job.sheetId, committedRows);

        const itemDeltas =
          job.kind === "bag"
            ? job.ids.map((id, index) => {
                const itemTrackingIds = extractBagFixtureTrackingIds(id);

                return {
                  itemId: `${job.jobId}:source:${index}`,
                  sourceItemId: id,
                  sourceItemKind: job.kind,
                  status: "succeeded",
                  trackingIds: itemTrackingIds,
                  sheetRowIds: getWorkspaceEngineSheetRowIdsForTrackingIds(
                    committedRows,
                    itemTrackingIds
                  ),
                  errorMessage: null,
                };
              })
            : [
                ...job.ids.map((id, index) => ({
                  itemId: `${job.jobId}:source:${index}`,
                  sourceItemId: id,
                  sourceItemKind: "manifest",
                  status: "succeeded",
                  trackingIds: extractManifestFixtureBagIds(id),
                  sheetRowIds: [],
                  errorMessage: null,
                })),
                ...job.ids
                  .flatMap((id) => extractManifestFixtureBagIds(id))
                  .map((bagId, index) => {
                    const itemTrackingIds = extractBagFixtureTrackingIds(bagId);

                    return {
                      itemId: `${job.jobId}:manifest-bag:${job.ids.length + index}`,
                      sourceItemId: bagId,
                      sourceItemKind: "manifest_bag",
                      status: "succeeded",
                      trackingIds: itemTrackingIds,
                      sheetRowIds: getWorkspaceEngineSheetRowIdsForTrackingIds(
                        committedRows,
                        itemTrackingIds
                      ),
                      errorMessage: null,
                    };
                  }),
              ];

        args?.onEvent?.onmessage?.({
          type: "import_job_progress",
          payload: {
            jobId: job.jobId,
            sheetId: job.sheetId,
            kind: job.kind,
            mode: job.mode,
            status: "completed",
            totalCount: job.ids.length,
            successCount: job.ids.length,
            failedCount: 0,
            pendingCount: 0,
            itemDeltas,
          },
        });

        return Promise.resolve({
          type: "import_job_detail",
          payload: createWorkspaceEngineImportJobDetail(
            job,
            "completed",
            trackingIds,
            committedRows
          ),
        });
      }

      if (command === "write_workspace_document") {
        if (args?.path && args.document) {
          persistedWorkspaceDocuments.set(args.path, args.document);
        }

        return Promise.resolve({
          path: args?.path ?? "/tmp/workspace.shipflow",
          savedAt: args?.document?.savedAt ?? "2026-04-18T00:00:00.000Z",
        });
      }

      if (command === "read_workspace_document") {
        const storedDocument =
          args?.path && persistedWorkspaceDocuments.get(args.path);
        if (storedDocument) {
          return Promise.resolve({
            path: args?.path,
            document: storedDocument,
          });
        }

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
      ([label, payload]: [unknown, unknown]) =>
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

  it("keeps workspace and pivot modes scoped to each sheet", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Pivot/Grafik" }));
    expect(screen.getByLabelText("Sumber Data Pivot")).toBeInTheDocument();

    dragElementToList(
      screen.getByRole("listitem", { name: "Field Jenis Layanan" }),
      screen.getByRole("list", { name: "Row aktif" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });
    expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.queryByLabelText("Sumber Data Pivot")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Pivot/Grafik" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });
    expect(
      within(screen.getByRole("list", { name: "Row aktif" })).getByText(
        "Jenis Layanan"
      )
    ).toBeInTheDocument();
  });

  it("supports dragging fields into active pivot rows", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Pivot/Grafik" }));

    const getSelectedLabels = (list: HTMLElement) =>
      Array.from(list.querySelectorAll(".analytics-selected-label")).map(
        (item) => item.textContent
      );
    const getSelectedChip = (list: HTMLElement, label: string) => {
      const chip = within(list).getByText(label).closest(".analytics-selected-row");
      expect(chip).not.toBeNull();
      return chip as HTMLElement;
    };
    const fieldList = screen.getByRole("list", { name: "Field tersedia" });
    const getField = (label: string) =>
      within(fieldList).getByRole("listitem", { name: `Field ${label}` });
    const groupList = screen.getByRole("list", { name: "Row aktif" });
    const columnList = screen.getByRole("list", { name: "Column aktif" });
    fireEvent.change(screen.getByLabelText("Cari Field"), {
      target: { value: "layanan" },
    });
    expect(getField("Jenis Layanan")).toBeInTheDocument();
    expect(
      within(fieldList).queryByRole("listitem", { name: "Field Status Akhir" })
    ).not.toBeInTheDocument();
    dragElementToList(getField("Jenis Layanan"), groupList);

    expect(within(groupList).getByText("Jenis Layanan")).toBeInTheDocument();

    dragElementToList(getSelectedChip(groupList, "Status Akhir"), groupList);

    expect(getSelectedLabels(groupList)).toEqual(["Jenis Layanan", "Status Akhir"]);
    expect(screen.queryByRole("button", { name: /Naikkan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turunkan/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Cari Field"), {
      target: { value: "lokasi" },
    });
    dragElementToList(getField("Lokasi Akhir"), columnList);

    expect(within(columnList).getByText("Lokasi Akhir")).toBeInTheDocument();
    const locationChip = getSelectedChip(columnList, "Lokasi Akhir");
    const locationDrag = startDragElementOverList(
      locationChip,
      groupList
    );
    await waitFor(() => expect(locationChip).toHaveClass("is-dragging"));
    fireEvent.drop(groupList, { dataTransfer: locationDrag });
    fireEvent.dragEnd(locationChip, { dataTransfer: locationDrag });
    await waitFor(() => {
      expect(getSelectedLabels(groupList)).toEqual([
        "Jenis Layanan",
        "Status Akhir",
        "Lokasi Akhir",
      ]);
      expect(columnList.querySelectorAll(".analytics-selected-row")).toHaveLength(0);
    });

    const metricList = screen.getByRole("list", { name: "Value aktif" });
    fireEvent.change(screen.getByLabelText("Cari Field"), {
      target: { value: "cod" },
    });
    expect(getField("Total COD")).toBeInTheDocument();
    expect(
      within(fieldList).queryByRole("listitem", { name: "Field Jumlah Kiriman" })
    ).not.toBeInTheDocument();
    dragElementToList(getField("Total COD"), metricList);

    expect(within(metricList).getByText("Total COD")).toBeInTheDocument();
    expect(screen.getByLabelText("Mode Value Total COD")).toHaveValue("sum");

    fireEvent.change(screen.getByLabelText("Mode Value Total COD"), {
      target: { value: "average" },
    });

    expect(screen.getByLabelText("Mode Value Total COD")).toHaveValue("average");

    dragElementToList(getSelectedChip(groupList, "Status Akhir"), metricList);

    expect(getSelectedLabels(groupList)).toEqual(["Jenis Layanan", "Lokasi Akhir"]);
    expect(getSelectedLabels(metricList)).toEqual(["Total COD", "Status Akhir"]);
    expect(screen.getByLabelText("Mode Value Status Akhir")).toHaveValue("unique_list");

    fireEvent.click(screen.getByRole("button", { name: "Hapus Value Total COD" }));
    fireEvent.click(screen.getByRole("button", { name: "Hapus Value Status Akhir" }));

    expect(metricList.querySelectorAll(".analytics-selected-row")).toHaveLength(0);
    expect(within(metricList).getByText("Belum ada field dipilih")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hapus Row Jenis Layanan" }));
    fireEvent.click(screen.getByRole("button", { name: "Hapus Row Lokasi Akhir" }));

    expect(groupList.querySelectorAll(".analytics-selected-row")).toHaveLength(0);
    expect(within(groupList).getByText("Belum ada field dipilih")).toBeInTheDocument();
  });

  it("switches between chart and pivot display modes", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Pivot/Grafik" }));

    const modeSelect = screen.getByLabelText("Mode Pivot Grafik") as HTMLSelectElement;
    expect(modeSelect).toHaveValue("pivot");
    expect(Array.from(modeSelect.options).map((option) => option.value)).toEqual([
      "pivot",
      "bar",
      "donut",
    ]);
    expect(screen.getByRole("region", { name: "Tabel Pivot" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Grafik Pivot" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Cari Field"), {
      target: { value: "cod" },
    });
    dragElementToList(
      screen.getByRole("listitem", { name: "Field Total COD" }),
      screen.getByRole("list", { name: "Value aktif" })
    );

    const shareHeader = screen.getByRole("columnheader", { name: /Share/ });
    expect(shareHeader).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(within(shareHeader).getByRole("button", { name: /Share/ }));
    expect(shareHeader).toHaveAttribute("aria-sort", "ascending");

    const groupHeader = screen.getByRole("columnheader", { name: /Status Akhir/ });
    fireEvent.click(within(groupHeader).getByRole("button", { name: /Status Akhir/ }));
    expect(groupHeader).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(screen.getByRole("button", { name: "Hapus Value Total COD" }));
    expect(screen.queryByRole("columnheader", { name: /Share/ })).not.toBeInTheDocument();
    expect(groupHeader).toHaveAttribute("aria-sort", "ascending");

    fireEvent.change(modeSelect, {
      target: { value: "bar" },
    });

    expect(screen.getByRole("region", { name: "Grafik Pivot" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Tabel Pivot" })).not.toBeInTheDocument();

    fireEvent.change(modeSelect, {
      target: { value: "donut" },
    });

    expect(screen.getByRole("region", { name: "Grafik Pivot" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Tabel Pivot" })).not.toBeInTheDocument();

    fireEvent.change(modeSelect, {
      target: { value: "pivot" },
    });

    expect(screen.getByRole("region", { name: "Tabel Pivot" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Grafik Pivot" })).not.toBeInTheDocument();
  });

  it("falls back to a visible pivot sort column when metrics are empty", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Pivot/Grafik" }));

    expect(screen.queryByRole("columnheader", { name: /Share/ })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Status Akhir/ })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
  });

  it("seeds manual tracking input into Rust sheet rows before detail fetch", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P2606020189412.30" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    expectLegacyTrackShipmentInvokeCount(0);
    expect(getTrackedShipmentIds()).toEqual(["P2606020189412"]);

    const upsertPayload = getWorkspaceEngineCommandCalls("upsert_sheet_rows")[0]?.[1]
      ?.command?.payload as
      | {
          sheetId: string;
          rows: Array<{
            rowId: string;
            position: number;
            displayTrackingId: string;
          }>;
        }
      | undefined;
    expect(upsertPayload).toMatchObject({
      sheetId: expect.any(String),
      rows: [
        {
          position: 0,
          displayTrackingId: "P2606020189412.30",
        },
      ],
    });
  });

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
        expectWorkspaceEngineCommandCount("preview_import_source", 1);
        expectInvokeCount("track_bag", 1);
        expect(screen.getByRole("button", { name: "Memuat..." })).toBeDisabled();
      });
      expect(
        getWorkspaceEngineCommandCalls("preview_import_source")[0]?.[1]?.command?.payload
      ).toEqual({
        kind: "bag",
        ids: ["PID-SHEET-1"],
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
        expectWorkspaceEngineCommandCount("preview_import_source", 2);
        expectInvokeCount("track_manifest", 1);
        expect(screen.getByRole("button", { name: "Memuat..." })).toBeDisabled();
      });
      expect(
        getWorkspaceEngineCommandCalls("preview_import_source")[1]?.[1]?.command?.payload
      ).toEqual({
        kind: "manifest",
        ids: ["MNF-SHEET-2"],
      });
      expect(getInvokeCalls("track_manifest")[0]?.[1]?.forceRefresh).toBe(true);

      resolveManifestRequest("MNF-SHEET-2");

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
    20_000
  );

  it(
    "keeps concurrent manifest lookups isolated across sheets",
    async () => {
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
      });

      resolveBagRequest("PID123456");

      await waitFor(() => {
        expect(screen.queryByText("PID123456 - 1 Kiriman")).not.toBeInTheDocument();
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
    },
    20_000
  );

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

    resolveBagRequest("PID-REPLACE");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Ganti Semua" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expectWorkspaceEngineRefreshCount(1);
      expect(
        screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
      ).not.toBeInTheDocument();
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue(
        "P260000000001"
      );
      expect(screen.queryByDisplayValue("PEXIST1")).not.toBeInTheDocument();
    });
    const replaceRefreshPayload = getWorkspaceEngineCommandCalls(
      "refresh_sheet_rows_tracking"
    )[0]?.[1]?.command?.payload as
      | { rowIds?: string[]; forceRefresh?: boolean }
      | undefined;
    expect(replaceRefreshPayload).toMatchObject({
      forceRefresh: true,
    });
    expect(replaceRefreshPayload?.rowIds).toHaveLength(1);
    expect(
      getWorkspaceEngineCommandCalls("query_sheet_rows").some(
        ([, args]) =>
          typeof args?.command?.payload === "object" &&
          args.command.payload !== null &&
          "query" in args.command.payload &&
          (args.command.payload.query as { limit?: number }).limit === 100_000
      )
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));

    await waitFor(() => {
      expectWorkspaceEngineCommandCount("get_import_job", 1);
      expect(screen.getByLabelText("ID Bag")).toHaveValue("PID-REPLACE");
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
    });
    expect(
      getWorkspaceEngineCommandCalls("get_import_job")[0]?.[1]?.command?.payload
    ).toEqual({
      jobId: "workspace-engine-job-1",
    });
  }, 20_000);

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
      expectWorkspaceEngineRefreshCount(1);
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
  }, 20_000);

  it("imports shipment ids from multiple bag lookups", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-MULTI-1\nPID-MULTI-2, PID-MULTI-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 2);
    });
    expect(getInvokeCalls("track_bag").map(([, args]) => args?.bagId)).toEqual([
      "PID-MULTI-1",
      "PID-MULTI-2",
    ]);

    resolveBagRequest("PID-MULTI-1");
    resolveBagRequest("PID-MULTI-2");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kiriman (2)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
      expect(screen.getByText("P260000000002")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 2);
      expectWorkspaceEngineRefreshCount(1);
      expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("P260000000002")[0]).toBeInTheDocument();
    });
  }, 20_000);

  it("retries only failed bag import lookups", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-RETRY-1\nPID-RETRY-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 2);
    });

    resolveBagRequest("PID-RETRY-1");
    rejectBagRequest("PID-RETRY-2");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("PID-RETRY-2 - Gagal ambil data")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ambil Ulang Gagal" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Ambil ulang" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 3);
    });
    expect(getInvokeCalls("track_bag").map(([, args]) => args?.bagId)).toEqual([
      "PID-RETRY-1",
      "PID-RETRY-2",
      "PID-RETRY-2",
    ]);

    resolveBagRequest("PID-RETRY-2");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kiriman (2)")).toBeInTheDocument();
      expect(screen.getByText("P260000000001")).toBeInTheDocument();
      expect(screen.getByText("P260000000002")).toBeInTheDocument();
      expect(screen.queryByText("PID-RETRY-2 - Gagal ambil data")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
    });
  }, 20_000);

  it("preserves dotted shipment ids imported from a bag lookup", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID-DOTTED" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    await waitFor(() => {
      expectInvokeCount("track_bag", 1);
    });

    resolveBagRequest("PID-DOTTED");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kiriman (1)")).toBeInTheDocument();
      expect(screen.getByText("P2606020189412.30")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
      expectWorkspaceEngineRefreshCount(1);
      expect(screen.getAllByDisplayValue("P2606020189412.30")[0]).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("P2606020189412.30")[0]).toBeInTheDocument();
      expect(screen.queryByDisplayValue("P260602018941230")).not.toBeInTheDocument();
    });
  });

  it(
    "appends manifest shipment ids into the active sheet after bag resolution completes",
    async () => {
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
        expectInvokeCount("track_bag", 1);
        expect(screen.getByRole("button", { name: "Tambah Data" })).toBeDisabled();
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
        expectWorkspaceEngineRefreshCount(1);
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
    },
    20_000
  );

  it(
    "imports shipment ids from multiple manifest lookups",
    async () => {
      render(<App />);

      fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
      fireEvent.change(screen.getByLabelText("ID Manifest"), {
        target: { value: "MNF-MULTI-1\nMNF-MULTI-2" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

      await waitFor(() => {
        expectInvokeCount("track_manifest", 2);
      });
      expect(getInvokeCalls("track_manifest").map(([, args]) => args?.manifestId)).toEqual([
        "MNF-MULTI-1",
        "MNF-MULTI-2",
      ]);

      resolveManifestRequest("MNF-MULTI-1");
      resolveManifestRequest("MNF-MULTI-2");

      await waitFor(() => {
        expectInvokeCount("track_bag", 2);
      });
      expect(getInvokeCalls("track_bag").map(([, args]) => args?.bagId)).toEqual([
        "PID123456",
        "PID123456-2",
      ]);

      resolveBagRequest("PID123456");
      resolveBagRequest("PID123456-2");

      await waitFor(() => {
        expect(screen.getByText("Nomor Kantung (2) - 2 Kiriman")).toBeInTheDocument();
        expect(screen.getByText("PID123456 - 1 Kiriman")).toBeInTheDocument();
        expect(screen.getByText("PID123456-2 - 1 Kiriman")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

      await waitFor(() => {
        expectInvokeCount("track_shipment", 2);
        expectWorkspaceEngineRefreshCount(1);
        expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
        expect(screen.getAllByDisplayValue("P260000000002")[0]).toBeInTheDocument();
      });
    },
    20_000
  );

  it(
    "retries only failed manifest bag lookups",
    async () => {
      render(<App />);

      fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
      fireEvent.change(screen.getByLabelText("ID Manifest"), {
        target: { value: "MNF-RETRY-BAG" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

      await waitFor(() => {
        expectInvokeCount("track_manifest", 1);
      });

      resolveManifestRequest("MNF-RETRY-BAG");

      await waitFor(() => {
        expectInvokeCount("track_bag", 1);
      });

      rejectBagRequest("PID123456");

      await waitFor(() => {
        expect(screen.getByText("PID123456 - Gagal ambil data")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Ambil Ulang Gagal" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Tambah Data" })).toBeDisabled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Ambil ulang" }));

      await waitFor(() => {
        expectInvokeCount("track_bag", 2);
      });
      expect(getInvokeCalls("track_bag").map(([, args]) => args?.bagId)).toEqual([
        "PID123456",
        "PID123456",
      ]);

      resolveBagRequest("PID123456");

      await waitFor(() => {
        expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
        expect(screen.getByText("PID123456 - 1 Kiriman")).toBeInTheDocument();
        expect(screen.queryByText("PID123456 - Gagal ambil data")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
      });
    },
    20_000
  );

  it(
    "preserves dotted shipment ids imported from a manifest lookup",
    async () => {
      render(<App />);

      fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
      fireEvent.change(screen.getByLabelText("ID Manifest"), {
        target: { value: "MNF-DOTTED" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

      await waitFor(() => {
        expectInvokeCount("track_manifest", 1);
      });

      resolveManifestRequest("MNF-DOTTED");

      await waitFor(() => {
        expectInvokeCount("track_bag", 1);
      });

      resolveBagRequest("PID123456-DOTTED");

      await waitFor(() => {
        expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
        expect(screen.getByText("PID123456-DOTTED - 1 Kiriman")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Tambah Data" }));

      await waitFor(() => {
        expectInvokeCount("track_shipment", 1);
        expectWorkspaceEngineRefreshCount(1);
        expect(screen.getAllByDisplayValue("P2606020189412.30")[0]).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getAllByDisplayValue("P2606020189412.30")[0]).toBeInTheDocument();
        expect(screen.queryByDisplayValue("P260602018941230")).not.toBeInTheDocument();
      });
    },
    20_000
  );

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
      expectWorkspaceEngineRefreshCount(1);
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
  }, 20_000);

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
    });

    resolveBagRequest("PID123456");

    await waitFor(() => {
      expect(screen.queryByText("PID123456 - 1 Kiriman")).not.toBeInTheDocument();
    });

    resolveBagRequest("PID123456-2");

    await waitFor(() => {
      expect(screen.getByText("Nomor Kantung (1) - 1 Kiriman")).toBeInTheDocument();
      expect(screen.getByText("PID123456-2 - 1 Kiriman")).toBeInTheDocument();
      expect(screen.queryByText("PID123456 - 1 Kiriman")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
    });
  }, 20_000);

  it(
    "starts tracking again when bag data is appended repeatedly",
    async () => {
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
        expectWorkspaceEngineRefreshCount(1);
        expect(
          screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
        ).not.toBeInTheDocument();
        expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
      });

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
        expectWorkspaceEngineRefreshCount(2);
        expect(
          screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
        ).not.toBeInTheDocument();
        expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
        expect(screen.getAllByDisplayValue("P260000000002")[0]).toBeInTheDocument();
      });
    },
    20_000
  );

  it(
    "starts tracking again when cached bag data is appended without reloading the modal",
    async () => {
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
        expectWorkspaceEngineRefreshCount(1);
        expect(
          screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
        ).not.toBeInTheDocument();
        expect(screen.getAllByDisplayValue("P260000000001")[0]).toBeInTheDocument();
      });

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
        expectWorkspaceEngineRefreshCount(2);
        expect(
          screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
        ).not.toBeInTheDocument();
        expect(screen.getAllByDisplayValue("P260000000001")).toHaveLength(1);
      });

      await waitFor(() => {
        expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
      });
    },
    20_000
  );

  it("copies selected ids into a new sheet through the workspace engine", async () => {
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
      expectInvokeCount("track_shipment", 1);
      expectWorkspaceEngineCommandCount("transfer_sheet_rows", 1);
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("PSEL1");
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  }, 20_000);

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
      expectInvokeCount("track_shipment", 1);
      expectWorkspaceEngineCommandCount("transfer_sheet_rows", 1);
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("PMOVE1");
    });

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
      expectInvokeCount("track_shipment", 2);
      expectWorkspaceEngineCommandCount("transfer_sheet_rows", 1);
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
  }, 20_000);

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
      expectInvokeCount("track_shipment", 2);
      expectWorkspaceEngineCommandCount("transfer_sheet_rows", 1);
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("PTARGET2")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("PMOVE2")[0]).toBeInTheDocument();
    });
  }, 20_000);

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
      expectInvokeCount("track_shipment", 2);
      expectWorkspaceEngineCommandCount("transfer_sheet_rows", 1);
      expect(screen.getByText("Total 0 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("PDRAG2")[0]).toBeInTheDocument();
      expect(screen.getAllByDisplayValue("PDRAG1")[0]).toBeInTheDocument();
    });
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

    const batchUpsert = getWorkspaceEngineCommandCalls("upsert_sheet_rows")
      .map(([, args]) => args?.command?.payload)
      .find(
        (
          payload
        ): payload is {
          sheetId: string;
          rows: Array<{
            position: number;
            displayTrackingId: string;
          }>;
        } => {
          if (!payload || typeof payload !== "object" || !("rows" in payload)) {
            return false;
          }

          const rows = (payload as { rows?: unknown }).rows;
          return (
            Array.isArray(rows) &&
            rows.length === 2 &&
            rows[0]?.displayTrackingId === "P9" &&
            rows[1]?.displayTrackingId === "P10"
          );
        }
      );
    expect(batchUpsert).toBeTruthy();
  });

  it("appends bulk paste rows through separate Rust batch refreshes", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    const firstBatch = Array.from({ length: 12 }, (_, index) =>
      `P${String(index + 1).padStart(3, "0")}`
    ).join("\n");
    const firstPasteEvent = createEvent.paste(firstInput);
    Object.defineProperty(firstPasteEvent, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text" ? firstBatch : ""),
      },
    });
    fireEvent(firstInput, firstPasteEvent);

    await waitFor(() => {
      expectWorkspaceEngineRefreshCount(1);
    });
    expect(getTrackedShipmentIds()).toEqual([
      "P001",
      "P002",
      "P003",
      "P004",
      "P005",
      "P006",
      "P007",
      "P008",
      "P009",
      "P010",
      "P011",
      "P012",
    ]);

    const appendInput = screen
      .getAllByPlaceholderText("Masukkan ID")
      .find((input) => (input as HTMLInputElement).value === "");
    if (!appendInput) {
      throw new Error("Missing empty input for appending bulk paste rows.");
    }
    const appendPasteEvent = createEvent.paste(appendInput);
    Object.defineProperty(appendPasteEvent, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text" ? "P013\nP014" : ""),
      },
    });
    fireEvent(appendInput, appendPasteEvent);

    await waitFor(() => {
      expectWorkspaceEngineRefreshCount(2);
    });
    expect(getTrackedShipmentIds()).toEqual([
      "P001",
      "P002",
      "P003",
      "P004",
      "P005",
      "P006",
      "P007",
      "P008",
      "P009",
      "P010",
      "P011",
      "P012",
      "P013",
      "P014",
    ]);
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
      expectWorkspaceEngineRefreshCount(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));

    expect(screen.getByRole("tab", { name: "Sheet 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

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

    const nextInput = await screen.findByDisplayValue("P101");
    fireEvent.change(nextInput, { target: { value: "P102" } });
    fireEvent.blur(nextInput);

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

    expectLegacyTrackShipmentInvokeCount(0);
    expectWorkspaceEngineCommandCount("refresh_sheet_row_tracking", 0);
    expectWorkspaceEngineRefreshCount(0);
    expect(getTrackedShipmentIds()).toEqual([]);
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

    const replacementTrackingIds = ["P408", "P409"];
    const pasteTarget = screen.getAllByPlaceholderText("Masukkan ID")[0];
    const pasteEvent = createEvent.paste(pasteTarget);
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text" ? replacementTrackingIds.join("\n") : "",
      },
    });
    fireEvent(pasteTarget, pasteEvent);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 4);
      const [currentFirstInput, currentSecondInput] =
        screen.getAllByPlaceholderText("Masukkan ID") as HTMLInputElement[];
      expect(currentFirstInput).toHaveValue("P408");
      expect(currentSecondInput).toHaveValue("P409");
      expectInfoTelemetry("abort", "P406");
      expectInfoTelemetry("abort", "P407");
    });

    resolveRequest("P406");
    resolveRequest("P407");

    await waitFor(() => {
      const [currentFirstInput, currentSecondInput] =
        screen.getAllByPlaceholderText("Masukkan ID") as HTMLInputElement[];
      expect(currentFirstInput).toHaveValue("P408");
      expect(currentSecondInput).toHaveValue("P409");
    });

    await waitFor(() => {
      expect(screen.getByText("Total 2 kiriman")).toBeInTheDocument();
      const [currentFirstInput, currentSecondInput] =
        screen.getAllByPlaceholderText("Masukkan ID") as HTMLInputElement[];
      expect(currentFirstInput).toHaveValue("P408");
      expect(currentSecondInput).toHaveValue("P409");
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

    resolveRequest("P205");
    resolveRequest("P201");

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 3" }));
    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));
    await waitFor(() => {
      expect(screen.getByText("Total 3 kiriman")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 1" }));
    await waitFor(() => {
      expect(screen.getByText("Total 1 kiriman")).toBeInTheDocument();
    });
  }, 20_000);

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

    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    expect(window.localStorage.getItem("shipflow-display-scale")).toBe("large");
  });

  it("shows service connection settings inside desktop settings", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getByRole("tab", { name: "Koneksi Service" }));

    expect(screen.getByLabelText("ShipFlow Service Port")).toBeInTheDocument();
    expect(screen.getByLabelText("ShipFlow Service Bearer Token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tes Service" })).toBeInTheDocument();
    expect(getInvokeCalls("open_shipflow_service_app")).toHaveLength(0);
  });

  it("pastes the desktop service token from the clipboard", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getByRole("tab", { name: "Koneksi Service" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitFor(() => {
      expect(screen.getByLabelText("ShipFlow Service Bearer Token")).toHaveValue(
        "sf_clipboard_token"
      );
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

  it("does not treat the workspace as dirty immediately after an engine-backed save", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");

    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PSAVECLEAN1" } });

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Simpan Sebagai" }));

    await waitFor(() => {
      expect(getInvokeCalls("write_workspace_document")).toHaveLength(1);
    });

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buka" }));

    await waitFor(() => {
      expect(getInvokeCalls("read_workspace_document")).toHaveLength(1);
    });

    expect(confirmSpy).not.toHaveBeenCalledWith(
      "Perubahan belum disimpan. Buka dokumen lain?"
    );
  });

  it("keeps tracked shipment data in saved workspace documents across reloads", async () => {
    const firstRender = render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0] as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "PSAVEFULL1" } });
    fireEvent.blur(firstInput);

    await waitFor(() => {
      expectInvokeCount("track_shipment", 1);
    });

    resolveRequest("PSAVEFULL1");

    await waitFor(() => {
      expect(screen.getByText("INVEHICLE")).toBeInTheDocument();
    });

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Simpan Sebagai" }));

    await waitFor(() => {
      expect(getInvokeCalls("write_workspace_document")).toHaveLength(1);
    });

    const savedDocument = getInvokeCalls("write_workspace_document")[0]?.[1]
      ?.document;
    expect(savedDocument).toBeDefined();
    const savedSheet =
      savedDocument?.workspace.sheetsById[savedDocument.workspace.activeSheetId];
    expect(savedSheet?.rows[0].shipment?.status_akhir.status).toBe("INVEHICLE");
    expect(savedSheet?.rows[0].shipment?.detail.shipment_header.nomor_kiriman).toBe(
      "PSAVEFULL1"
    );

    firstRender.unmount();

    const inputsOnlyWorkspace = JSON.parse(
      JSON.stringify(savedDocument?.workspace)
    ) as WorkspaceDocumentFile["workspace"];
    const inputsOnlySheet =
      inputsOnlyWorkspace.sheetsById[inputsOnlyWorkspace.activeSheetId];
    inputsOnlySheet.rows = inputsOnlySheet.rows.map((row) => ({
      ...row,
      shipment: null,
      stale: false,
      dirty: false,
    }));
    window.localStorage.setItem(
      "shipflow-workspace-state",
      JSON.stringify(inputsOnlyWorkspace)
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("INVEHICLE")).toBeInTheDocument();
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue(
        "PSAVEFULL1"
      );
    });
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
    expect(
      getWorkspaceEngineCommandCalls("clear_sheet_rows").some(
        ([, args]) =>
          (args?.command?.payload as { sheetId?: string } | undefined)?.sheetId ===
          "sheet-opened"
      )
    ).toBe(true);
    expect(
      getWorkspaceEngineCommandCalls("upsert_sheet_rows").some(([, args]) => {
        const payload = args?.command?.payload as
          | {
              sheetId?: string;
              rows?: Array<{
                rowId?: string;
                position?: number;
                displayTrackingId?: string;
              }>;
            }
          | undefined;
        return (
          payload?.sheetId === "sheet-opened" &&
          payload.rows?.some(
            (row) =>
              row.rowId === "row-opened" &&
              row.position === 0 &&
              row.displayTrackingId === "POPEN1"
          )
        );
      })
    ).toBe(true);
    openFileMenu();
    expect(screen.getByRole("menuitem", { name: "picked-open.shipflow" })).toBeInTheDocument();
  });

  it("shows a recoverable error when opened workspace rows cannot seed the Rust engine", async () => {
    workspaceEngineUpsertFailureMessage = "Workspace engine document migration failed.";

    render(<App />);

    openFileMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buka" }));

    await waitFor(() => {
      expect(
        screen.getByText("Workspace engine document migration failed.")
      ).toBeInTheDocument();
      expect(getInvokeCalls("read_workspace_document")).toHaveLength(1);
      expectWorkspaceEngineCommandCount("upsert_sheet_rows", 1);
    });

    expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).toHaveValue("");
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

  it("persists clean workspace snapshots as inputs-only data", async () => {
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
    expect(window.localStorage.getItem("shipflow-workspace-state")).toContain(
      '"shipment":null'
    );

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

  it("persists service runtime API settings only after settings are confirmed in the service window", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();
    expect(getInvokeCalls("configure_api_service")).toHaveLength(0);

    fireEvent.click(await screen.findByRole("tab", { name: "API" }));
    expect(
      screen.getByText(
        "API Service selalu aktif untuk Desktop. Token wajib dipakai untuk lacak, baik sumbernya internal scrap maupun external API."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Localhost selalu aktif untuk Desktop")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("LAN / Jaringan Lokal"));
    fireEvent.change(screen.getByLabelText("Port"), {
      target: { value: "19422" },
    });

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();

    const tokenField = screen.getByLabelText("Token API Service") as HTMLInputElement;
    expect(tokenField.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(tokenField.value).toMatch(/^sf_[a-f0-9]+$/);

    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(getInvokeCalls("configure_api_service")).toHaveLength(1);
      expect(persistedServiceConfig?.desktopConnectionMode).toBe("managedLocal");
      expect(persistedServiceConfig?.enabled).toBe(true);
      expect(persistedServiceConfig?.mode).toBe("lan");
      expect(persistedServiceConfig?.port).toBe(19422);
      expect(persistedServiceConfig?.authToken).toMatch(/^sf_[a-f0-9]+$/);
      expect(persistedServiceConfig?.lastUpdatedAt).toBeTruthy();
    });
  });

  it("rolls back previewed service runtime config and generated token when the service window resets changes", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();

    fireEvent.click(await screen.findByRole("tab", { name: "API" }));
    const originalToken = (screen.getByLabelText("Token API Service") as HTMLInputElement).value;
    expect(originalToken).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Perubahan" }));

    expect(window.localStorage.getItem("shipflow-service-config")).toBeNull();
    expect(getInvokeCalls("configure_api_service")).toHaveLength(0);

    expect(screen.getByLabelText("Token API Service")).toHaveValue(originalToken);
  });

  it("uses the window close button for hiding ShipFlow Service", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "API" }));
    fireEvent.change(screen.getByLabelText("Port"), {
      target: { value: "19422" },
    });

    expect(screen.queryByRole("button", { name: "Sembunyikan" })).not.toBeInTheDocument();

    expect(getInvokeCalls("configure_api_service")).toHaveLength(0);
    expect(screen.getByLabelText("Port")).toHaveValue(19422);
  });

  it("exposes service-owned internal and external tracking source settings", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Sumber Lacak" }));

    expect(screen.getByRole("radio", { name: "Internal ShipFlow" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "API ShipFlow Eksternal" })).toBeInTheDocument();
  });

  it("restores external tracking source selection and base URL in the service window even when the API token is session-only", async () => {
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
      expect(screen.getByRole("tab", { name: "Sumber Lacak" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(screen.getByRole("radio", { name: "API ShipFlow Eksternal" })).toBeChecked();
      expect(screen.getByLabelText("External API Base URL")).toHaveValue(
        "https://scrappid3.jacobcalvyn.io"
      );
      expect(screen.getByLabelText("External API Token")).toHaveValue("");
    });
  });

  it("persists external tracking source settings after confirmation in the service window", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Sumber Lacak" }));
    fireEvent.click(await screen.findByRole("radio", { name: "API ShipFlow Eksternal" }));
    fireEvent.change(screen.getByLabelText("External API Base URL"), {
      target: { value: "https://scrappid3.jacobcalvyn.io" },
    });
    fireEvent.change(screen.getByLabelText("External API Token"), {
      target: {
        value: "sf_32c18e59ecca4f91e23070d33c74a230a0ccc73161b6ae79",
      },
    });
    fireEvent.click(screen.getByRole("tab", { name: "API" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(getInvokeCalls("configure_api_service")).toHaveLength(1);
      expect(persistedServiceConfig?.desktopConnectionMode).toBe("managedLocal");
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

  it("shows service API port and token controls in the API tab", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "API" }));

    expect(screen.getByText("Localhost selalu aktif untuk Desktop")).toBeInTheDocument();
    expect(screen.getByLabelText("Port")).toHaveValue(18422);
    const tokenField = screen.getByLabelText("Token API Service");
    expect(tokenField).toBeInTheDocument();

    const initialToken = (tokenField as HTMLInputElement).value;
    expect(initialToken).toBe("");
    const loadCallCount = getInvokeCalls("load_saved_api_service_config").length;
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(getInvokeCalls("load_saved_api_service_config").length).toBeGreaterThan(loadCallCount);
    });
    expect(screen.getByLabelText("Token API Service")).toHaveValue(initialToken);
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

  it("tests external tracking source config from the service window", async () => {
    setShipFlowWindowKind("service-settings");
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Sumber Lacak" }));
    fireEvent.click(await screen.findByRole("radio", { name: "API ShipFlow Eksternal" }));
    fireEvent.change(screen.getByLabelText("External API Base URL"), {
      target: { value: "https://scrappid3.jacobcalvyn.io" },
    });
    fireEvent.change(screen.getByLabelText("External API Token"), {
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

  it("blocks global delete and copy shortcuts while settings dialog is open", async () => {
    render(<App />);

    const firstInput = screen.getAllByPlaceholderText("Masukkan ID")[0];
    fireEvent.change(firstInput, { target: { value: "P900" } });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    expect(screen.getByText("1 row dipilih")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));

    const saveButton = screen.getByRole("button", { name: "Simpan" });
    saveButton.focus();

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
