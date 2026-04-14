import { COLUMNS, MIN_EMPTY_TRAILING_ROWS } from "./columns";
import { SheetRow } from "./types";
import {
  compareRows,
  ensureTrailingEmptyRows,
  formatColumnValue,
  getRowStatus,
} from "./utils";

function createRow(partial: Partial<SheetRow> = {}): SheetRow {
  return {
    key: partial.key ?? "row-1",
    trackingInput: partial.trackingInput ?? "",
    shipment: partial.shipment ?? null,
    loading: partial.loading ?? false,
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

    const beratColumn = COLUMNS.find(
      (column) => column.path === "detail.package_detail.berat_actual"
    )!;
    const codColumn = COLUMNS.find(
      (column) => column.path === "detail.billing_detail.cod_info.is_cod"
    )!;

    expect(formatColumnValue(row, beratColumn)).toBe("1,25 Kg");
    expect(formatColumnValue(row, codColumn)).toBe("Ya");
  });

  it("returns row status in the expected priority order", () => {
    expect(getRowStatus(createRow({ loading: true, error: "x" }))).toBe("Loading");
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
});
