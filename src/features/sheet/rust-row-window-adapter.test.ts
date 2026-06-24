import { describe, expect, it } from "vitest";
import { createTrackResponseFromProjection } from "./rust-row-window-adapter";

describe("Rust row window adapter", () => {
  it("returns null when a projection has no tracking detail payload", () => {
    expect(
      createTrackResponseFromProjection({
        rowId: "row-1",
        position: 0,
        displayTrackingId: "P1",
        lookupTrackingId: "P1",
        rowStatus: "empty",
        errorMessage: null,
        statusJson: null,
        detailJson: null,
        historyJson: null,
      })
    ).toBeNull();
  });

  it("maps Rust tracking detail projections into frontend track responses", () => {
    const response = createTrackResponseFromProjection({
      rowId: "row-1",
      position: 0,
      displayTrackingId: "P2606020189412.30",
      lookupTrackingId: "P2606020189412",
      rowStatus: "loaded",
      errorMessage: null,
      statusJson: {
        status: "INLOCATION",
        location: "DC JAYAPURA 9910A",
      },
      detailJson: {
        shipment_header: {
          nomor_kiriman: "P2606020189412.30",
        },
        package_detail: {
          jenis_layanan: "PKH",
        },
        billing_detail: {
          cod_info: {
            is_cod: true,
            total_cod: 125000,
          },
        },
      },
      historyJson: {
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

    expect(response?.status_akhir.status).toBe("INLOCATION");
    expect(response?.status_akhir.location).toBe("DC JAYAPURA 9910A");
    expect(response?.detail.shipment_header.nomor_kiriman).toBe(
      "P2606020189412.30"
    );
    expect(response?.detail.package_detail.jenis_layanan).toBe("PKH");
    expect(response?.detail.billing_detail.cod_info.total_cod).toBe(125000);
  });
});
