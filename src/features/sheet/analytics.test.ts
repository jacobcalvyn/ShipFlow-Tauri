import {
  ANALYTICS_EXCLUDED_COLUMN_PATHS,
  getDefaultSheetAnalyticsMetricAggregation,
  getSheetAnalyticsGroupByOptions,
  getSheetAnalyticsMetricAggregationLabel,
  getSheetAnalyticsMetricAggregationOptions,
  getSheetAnalyticsMetricOptions,
  isValidSheetAnalyticsMetricAggregation,
} from "./analytics";
import { COLUMNS } from "./columns";

describe("sheet analytics options", () => {
  it("exposes only approved sheet columns for row, column, and value fields", () => {
    const groupOptions = getSheetAnalyticsGroupByOptions();
    const groupPaths = groupOptions.map((option) => option.path);
    const groupLabels = groupOptions.map((option) => option.label);
    const metricOptions = getSheetAnalyticsMetricOptions();
    const metricKeys = metricOptions.map((option) => option.key);
    const allowedColumnPaths = COLUMNS.filter(
      (column) => !ANALYTICS_EXCLUDED_COLUMN_PATHS.has(column.path)
    ).map((column) => column.path);

    expect(groupPaths).toEqual(allowedColumnPaths);
    expect(metricKeys).toEqual(allowedColumnPaths);
    expect(groupLabels).toEqual([
      "Nomor Kiriman",
      "TRX - TODAY",
      "TRX - UNBAG",
      "PID/Kantong Terakhir",
      "Manifest Terakhir",
      "Status Akhir",
      "Lokasi Akhir",
      "Petugas Akhir",
      "ID Petugas Akhir",
      "Waktu Status Akhir",
      "Nama Pengirim",
      "Telepon Pengirim",
      "Alamat Pengirim",
      "Nama Penerima",
      "Telepon Penerima",
      "Alamat Penerima",
      "Kode Pos Penerima",
      "ID Pelanggan Korporat",
      "Nama Kantor",
      "ID Kantor",
      "Nama Petugas",
      "ID Petugas",
      "Tanggal Input",
      "Jenis Layanan",
      "Is COD",
      "Total COD",
      "Status COD",
      "SLA Target",
      "SLA Category",
      "SLA Days Diff",
      "Jumlah Delivery Runsheet",
    ]);
  });

  it("limits text fields to text-safe aggregations", () => {
    const metricOptions = getSheetAnalyticsMetricOptions();
    const statusMetric = metricOptions.find(
      (option) => option.key === "status_akhir.status"
    );

    expect(statusMetric).toEqual(
      expect.objectContaining({
        format: "text",
        label: "Status Akhir",
      })
    );
    expect(getDefaultSheetAnalyticsMetricAggregation(statusMetric!)).toBe("unique_list");
    expect(
      getSheetAnalyticsMetricAggregationOptions(statusMetric!).map((option) => option.key)
    ).toEqual([
      "unique_list",
      "count",
      "count_unique",
      "most_frequent",
      "first",
      "last",
    ]);
    expect(getSheetAnalyticsMetricAggregationLabel(statusMetric!, "count_unique")).toBe(
      "Banyaknya Nilai Berbeda"
    );
    expect(isValidSheetAnalyticsMetricAggregation(statusMetric!, "sum")).toBe(false);
    expect(isValidSheetAnalyticsMetricAggregation(statusMetric!, "count")).toBe(true);
  });

  it("allows numeric aggregations only for numeric value fields", () => {
    const metricOptions = getSheetAnalyticsMetricOptions();
    const codTotalMetric = metricOptions.find(
      (option) => option.key === "detail.billing_detail.cod_info.total_cod"
    );

    expect(codTotalMetric).toEqual(
      expect.objectContaining({
        format: "currency",
        label: "Total COD",
      })
    );
    expect(getDefaultSheetAnalyticsMetricAggregation(codTotalMetric!)).toBe("sum");
    expect(
      getSheetAnalyticsMetricAggregationOptions(codTotalMetric!).map((option) => option.key)
    ).toEqual(["sum", "average", "max", "min", "count", "count_unique"]);
    expect(getSheetAnalyticsMetricAggregationLabel(codTotalMetric!, "average")).toBe(
      "Rata-rata"
    );
    expect(isValidSheetAnalyticsMetricAggregation(codTotalMetric!, "unique_list")).toBe(
      false
    );
    expect(isValidSheetAnalyticsMetricAggregation(codTotalMetric!, "sum")).toBe(true);
  });
});
