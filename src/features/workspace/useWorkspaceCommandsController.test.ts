import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LATEST_BAG_STATUS_COLUMN_PATH,
  LATEST_DELIVERY_COLUMN_PATH,
  LATEST_MANIFEST_COLUMN_PATH,
  TRACKING_COLUMN_PATH,
  COLUMNS,
} from "../sheet/columns";
import { SheetRow } from "../sheet/types";
import { useWorkspaceCommandsController } from "./useWorkspaceCommandsController";

const createObjectUrlMock = vi.fn((_: Blob) => "blob:shipflow");
const revokeObjectUrlMock = vi.fn();
const linkClickMock = vi.fn();
const originalCreateElement = document.createElement.bind(document);
class TestBlob {
  private readonly content: string;

  constructor(parts: unknown[]) {
    this.content = parts.map((part) => String(part)).join("");
  }

  text() {
    return Promise.resolve(this.content);
  }
}

function createRow(): SheetRow {
  return {
    key: "row-1",
    trackingInput: "P2603310114291",
    shipment: {
      url: "https://example.test/track",
      detail: {
        shipment_header: {
          nomor_kiriman: "P2603310114291",
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
          pengirim: {},
          penerima: {},
        },
        performance_detail: {},
      },
      status_akhir: {
        status: "DELIVERED",
      },
      pod: {
        photo1_url: "https://example.test/photo-1.jpg",
        photo2_url: "https://example.test/photo-2.jpg",
      },
      history: [],
      history_summary: {
        irregularity: [
          {
            status: "FAILED",
            lokasi: "DC JAYAPURA 9910A",
            tanggal: "2026-04-15",
            waktu: "16:17:07",
          },
        ],
        bagging_unbagging: [
          {
            nomor_kantung: "PID95084242",
            bagging: {
              lokasi: "DC JAYAPURA 9910A",
              tanggal: "2026-04-15",
              waktu: "16:33:20",
            },
          },
        ],
        manifest_r7: [
          {
            nomor_r7: "P20260310064942110",
            tujuan: "DC JAYAPURA 9910A",
            tanggal: "2026-03-10",
            waktu: "08:46:26",
          },
        ],
        delivery_runsheet: [
          {
            petugas_kurir: "Gabriel Erick Taurui (560000529)",
            lokasi: "DC JAYAPURA 9910A",
            tanggal: "2026-04-15",
            waktu: "11:40:47",
            updates: [
              {
                petugas: "Gabriel Erick Taurui (560000529)",
                status: "FAILEDTODELIVERED",
                keterangan_status: "RUMAH/ALAMAT TIDAK DITEMUKAN",
                tanggal: "2026-04-15",
                waktu: "14:50:02",
              },
            ],
          },
        ],
      },
    },
    loading: false,
    stale: false,
    dirty: false,
    error: "",
  };
}

function buildOptions() {
  const row = createRow();
  const visibleColumns = COLUMNS.filter((column) =>
    [
      TRACKING_COLUMN_PATH,
      LATEST_BAG_STATUS_COLUMN_PATH,
      LATEST_MANIFEST_COLUMN_PATH,
      LATEST_DELIVERY_COLUMN_PATH,
      "status_akhir.status",
      "pod.photo1_url",
      "pod.photo2_url",
      "history_summary.irregularity",
      "history_summary.bagging_unbagging",
      "history_summary.manifest_r7",
      "history_summary.delivery_runsheet",
    ].includes(column.path)
  );

  return {
    activeSheetId: "sheet-1",
    activeSheetDeleteAllArmed: false,
    allTrackingIds: ["P2603310114291"],
    exportableRows: [row],
    retrackableRows: [] as Array<{ key: string; value: string }>,
    retryFailedEntries: [] as Array<{ key: string; value: string }>,
    selectedTrackingIds: [],
    selectedVisibleRowKeys: [],
    deleteSelectedArmedSheetId: null,
    visibleColumns,
    visibleColumnPathSet: new Set(visibleColumns.map((column) => column.path)),
    workspaceRef: {
      current: {
        sheetsById: {
          "sheet-1": {
            rows: [row],
          },
        },
      },
    },
    sheetScrollPositionsRef: { current: new Map() },
    highlightedColumnTimeoutRef: { current: null },
    highlightedColumnSheetIdRef: { current: null },
    deleteAllTimeoutRef: { current: null },
    deleteAllArmedSheetIdRef: { current: null },
    deleteSelectedTimeoutRef: { current: null },
    deleteSelectedArmedSheetIdRef: { current: null },
    setDeleteSelectedArmedSheetId: vi.fn(),
    setWorkspaceState: vi.fn(),
    setHoveredColumn: vi.fn(),
    updateActiveSheet: vi.fn(),
    copyText: vi.fn().mockResolvedValue(undefined),
    showNotice: vi.fn(),
    armDeleteAll: vi.fn(),
    disarmDeleteAll: vi.fn(),
    armDeleteSelected: vi.fn(),
    disarmDeleteSelected: vi.fn(),
    focusFirstTrackingInput: vi.fn(),
    abortRowTrackingWork: vi.fn(),
    invalidateSheetTrackingWork: vi.fn(),
    forgetSheetTrackingRuntime: vi.fn(),
    runBulkPasteFetches: vi.fn().mockResolvedValue(undefined),
  };
}

describe("useWorkspaceCommandsController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createObjectUrlMock.mockReset();
    createObjectUrlMock.mockReturnValue("blob:shipflow");
    revokeObjectUrlMock.mockReset();
    linkClickMock.mockReset();

    vi.stubGlobal("URL", {
      createObjectURL: createObjectUrlMock,
      revokeObjectURL: revokeObjectUrlMock,
    });
    vi.stubGlobal("Blob", TestBlob as unknown as typeof Blob);

    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName === "a") {
        const link = originalCreateElement("a");
        link.click = linkClickMock;
        return link;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);
  });

  it("excludes POD and raw history summary columns from exported CSV", async () => {
    const options = buildOptions();
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.exportCsv();
    });

    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    const blob = createObjectUrlMock.mock.calls[0]?.[0] as unknown as TestBlob;
    const csvContent = await blob.text();

    expect(csvContent).toContain("Nomor Kiriman");
    expect(csvContent).toContain("PID/Kantong Terakhir");
    expect(csvContent).toContain("Manifest Terakhir");
    expect(csvContent).toContain("Delivery Terakhir");
    expect(csvContent).toContain("Status Akhir");

    expect(csvContent).not.toContain("POD Photo 1");
    expect(csvContent).not.toContain("POD Photo 2");
    expect(csvContent).not.toContain("History Summary Irregularity");
    expect(csvContent).not.toContain("History Summary Bagging Unbagging");
    expect(csvContent).not.toContain("History Summary Manifest R7");
    expect(csvContent).not.toContain("History Summary Delivery Runsheet");
  });

  it("forces refresh when retrying failed rows", async () => {
    const options = buildOptions();
    options.retryFailedEntries = [
      { key: "row-1", value: "P2603310114291" },
    ];
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retryFailedRows();
    });

    expect(options.runBulkPasteFetches).toHaveBeenCalledWith(
      "sheet-1",
      options.retryFailedEntries,
      { forceRefresh: true }
    );
  });

  it("forces refresh when retracking all rows", async () => {
    const options = buildOptions();
    options.retrackableRows = [
      { key: "row-1", value: "P2603310114291" },
    ];
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retrackAllRows();
      await Promise.resolve();
    });

    expect(options.runBulkPasteFetches).toHaveBeenCalledWith(
      "sheet-1",
      options.retrackableRows,
      { forceRefresh: true }
    );
  });
});
