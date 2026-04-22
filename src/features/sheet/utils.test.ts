import { COLUMNS, MIN_EMPTY_TRAILING_ROWS } from "./columns";
import { SheetRow } from "./types";
import {
  assertValidSheetState,
  compareRows,
  ensureTrailingEmptyRows,
  formatColumnValue,
  getLatestBagPrintUrl,
  getRowStatus,
  sanitizeTrackingInput,
  sanitizeTrackingPasteValues,
} from "./utils";
import { createDefaultSheetState } from "./default-state";

function createRow(partial: Partial<SheetRow> = {}): SheetRow {
  return {
    key: partial.key ?? "row-1",
    trackingInput: partial.trackingInput ?? "",
    shipment: partial.shipment ?? null,
    loading: partial.loading ?? false,
    stale: partial.stale ?? false,
    dirty: partial.dirty ?? false,
    error: partial.error ?? "",
  };
}

describe("sheet utils", () => {
  it("ensures a minimum number of trailing empty rows", () => {
    const rows = [
      createRow({ key: "filled", trackingInput: "P2601" }),
      createRow({ key: "empty-1" }),
    ];

    const result = ensureTrailingEmptyRows(rows);

    expect(result).toHaveLength(1 + MIN_EMPTY_TRAILING_ROWS);
    expect(result[0].trackingInput).toBe("P2601");
    expect(result.slice(1).every((row) => row.trackingInput === "")).toBe(true);
  });

  it("formats shipment values based on column definition", () => {
    const row = createRow({
      trackingInput: "P2601",
      shipment: {
        url: "https://example.test",
        detail: {
          shipment_header: {
            nomor_kiriman: "P2601",
            booking_code: "BKG-01",
            id_pelanggan_korporat: "KORP-1",
          },
          origin_detail: {},
          package_detail: {
            berat_actual: 1.25,
            berat_volumetric: 2,
            jenis_layanan: "PKH",
            isi_kiriman: "Dokumen",
            kriteria_kiriman: "Express",
          },
          billing_detail: {
            bea_dasar: 12000,
            nilai_barang: 50000,
            htnb: 0,
            type_pembayaran: "Cash",
            cod_info: {
              is_cod: true,
              total_cod: 32000,
              status: "Done",
              tanggal: "2026-04-14",
              virtual_account: "123",
            },
          },
          actors: {
            pengirim: {},
            penerima: {},
          },
          performance_detail: {},
        },
        status_akhir: {},
        pod: {
          photo1_url: "https://example.test/photo-1.jpg",
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
              petugas_mandor: "Akbar",
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
    });

    const beratColumn = COLUMNS.find(
      (column) => column.path === "detail.package_detail.berat_actual"
    )!;
    const codColumn = COLUMNS.find(
      (column) => column.path === "detail.billing_detail.cod_info.is_cod"
    )!;
    const podColumn = COLUMNS.find((column) => column.path === "pod.photo1_url")!;
    const irregularityColumn = COLUMNS.find(
      (column) => column.path === "history_summary.irregularity"
    )!;
    const latestBagStatusColumn = COLUMNS.find(
      (column) => column.path === "history_summary.latest_bagging_status"
    )!;
    const latestManifestColumn = COLUMNS.find(
      (column) => column.path === "history_summary.latest_manifest_r7"
    )!;
    const baggingColumn = COLUMNS.find(
      (column) => column.path === "history_summary.bagging_unbagging"
    )!;
    const manifestColumn = COLUMNS.find(
      (column) => column.path === "history_summary.manifest_r7"
    )!;
    const deliveryColumn = COLUMNS.find(
      (column) => column.path === "history_summary.delivery_runsheet"
    )!;

    expect(formatColumnValue(row, beratColumn)).toBe("1,25 Kg");
    expect(formatColumnValue(row, codColumn)).toBe("Ya");
    expect(formatColumnValue(row, podColumn)).toBe("https://example.test/photo-1.jpg");
    expect(formatColumnValue(row, irregularityColumn)).toBe(
      "FAILED | DC JAYAPURA 9910A | 2026-04-15 16:17:07"
    );
    expect(formatColumnValue(row, latestBagStatusColumn)).toBe(
      "PID95084242 - Bagging"
    );
    expect(formatColumnValue(row, latestManifestColumn)).toBe(
      "P20260310064942110"
    );
    expect(formatColumnValue(row, baggingColumn)).toBe(
      "Bagging PID95084242 | DC JAYAPURA 9910A | 2026-04-15 16:33:20"
    );
    expect(formatColumnValue(row, manifestColumn)).toBe(
      "P20260310064942110 | DC JAYAPURA 9910A | 2026-03-10 08:46:26"
    );
    expect(formatColumnValue(row, deliveryColumn)).toBe(
      "FAILEDTODELIVERED (RUMAH/ALAMAT TIDAK DITEMUKAN) | Gabriel Erick Taurui (560000529) | 2026-04-15 14:50:02"
    );
  });

  it("returns row status in the expected priority order", () => {
    expect(getRowStatus(createRow({ loading: true, error: "x" }))).toBe("Loading");
    expect(getRowStatus(createRow({ dirty: true, stale: true, error: "x" }))).toBe("Dirty");
    expect(getRowStatus(createRow({ stale: true, error: "x" }))).toBe("Stale");
    expect(getRowStatus(createRow({ error: "x" }))).toBe("Error");
    expect(
      getRowStatus(
        createRow({
          shipment: {
            url: "x",
            detail: {
              shipment_header: {},
              origin_detail: {},
              package_detail: { berat_actual: 0, berat_volumetric: 0 },
              billing_detail: {
                bea_dasar: 0,
                nilai_barang: 0,
                htnb: 0,
                cod_info: { is_cod: false, total_cod: 0 },
              },
              actors: { pengirim: {}, penerima: {} },
              performance_detail: {},
            },
            status_akhir: {},
            pod: {},
            history: [],
            history_summary: {
              irregularity: [],
              bagging_unbagging: [],
              manifest_r7: [],
              delivery_runsheet: [],
            },
          },
        })
      )
    ).toBe("Ready");
    expect(getRowStatus(createRow({ trackingInput: "P2601" }))).toBe("Pending");
    expect(getRowStatus(createRow())).toBe("Draft");
  });

  it("prefers the latest unbagging status for the dedicated PID column", () => {
    const latestBagStatusColumn = COLUMNS.find(
      (column) => column.path === "history_summary.latest_bagging_status"
    )!;
    const row = createRow({
      shipment: {
        url: "https://example.test",
        detail: {
          shipment_header: {},
          origin_detail: {},
          package_detail: { berat_actual: 0, berat_volumetric: 0 },
          billing_detail: {
            bea_dasar: 0,
            nilai_barang: 0,
            htnb: 0,
            cod_info: { is_cod: false, total_cod: 0 },
          },
          actors: { pengirim: {}, penerima: {} },
          performance_detail: {},
        },
        status_akhir: {},
        pod: {},
        history: [],
        history_summary: {
          irregularity: [],
          bagging_unbagging: [
            {
              nomor_kantung: "PID95180533",
              bagging: {
                lokasi: "DC JAYAPURA 9910A",
                tanggal: "2026-04-21",
                waktu: "09:00:00",
              },
              unbagging: {
                lokasi: "SPP JAYAPURA",
                tanggal: "2026-04-21",
                waktu: "10:00:00",
              },
            },
          ],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      },
    });

    expect(formatColumnValue(row, latestBagStatusColumn)).toBe(
      "PID95180533 - Unbagging"
    );
    expect(getLatestBagPrintUrl(row.shipment?.history_summary)).toBe(
      "https://apiexpos.mile.app/api/v1/print-bag?bag_id=PID95180533_5f9fae9b5fbe9d6e401ad0c5&oid=NWY5ZmFlOWI1ZmJlOWQ2ZTQwMWFkMGM1"
    );
  });

  it("sorts rows using comparable values from the column", () => {
    const column = COLUMNS.find(
      (item) => item.path === "detail.shipment_header.booking_code"
    )!;
    const left = createRow({
      key: "a",
      shipment: {
        url: "",
        detail: {
          shipment_header: { booking_code: "BKG-02" },
          origin_detail: {},
          package_detail: { berat_actual: 0, berat_volumetric: 0 },
          billing_detail: {
            bea_dasar: 0,
            nilai_barang: 0,
            htnb: 0,
            cod_info: { is_cod: false, total_cod: 0 },
          },
          actors: { pengirim: {}, penerima: {} },
          performance_detail: {},
        },
        status_akhir: {},
        pod: {},
        history: [],
        history_summary: {
          irregularity: [],
          bagging_unbagging: [],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      },
    });
    const right = createRow({
      key: "b",
      shipment: {
        url: "",
        detail: {
          shipment_header: { booking_code: "BKG-10" },
          origin_detail: {},
          package_detail: { berat_actual: 0, berat_volumetric: 0 },
          billing_detail: {
            bea_dasar: 0,
            nilai_barang: 0,
            htnb: 0,
            cod_info: { is_cod: false, total_cod: 0 },
          },
          actors: { pengirim: {}, penerima: {} },
          performance_detail: {},
        },
        status_akhir: {},
        pod: {},
        history: [],
        history_summary: {
          irregularity: [],
          bagging_unbagging: [],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      },
    });

    expect(compareRows(left, right, column, "asc")).toBeLessThan(0);
    expect(compareRows(left, right, column, "desc")).toBeGreaterThan(0);
  });

  it("sanitizes tracking input and bulk paste values aggressively", () => {
    expect(sanitizeTrackingInput(" p2603 3101-14291 \u200B")).toBe("P26033101-14291");
    expect(sanitizeTrackingPasteValues(" p2601 \nP 2602\n@@@\n")).toEqual([
      "P2601",
      "P2602",
    ]);
  });

  it("asserts illegal row-state combinations", () => {
    const sheetState = createDefaultSheetState();
    sheetState.rows[0] = {
      ...sheetState.rows[0],
      trackingInput: "P2601",
      shipment: null,
      stale: true,
    };

    expect(() => assertValidSheetState(sheetState)).toThrow(
      "cannot be stale without a last-known-good shipment"
    );
  });
});
