import type { TrackResponse } from "../../types";
import type { SheetRowProjection } from "../workspace-engine/client";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createDefaultTrackResponse(trackingId: string): TrackResponse {
  return {
    url: "",
    detail: {
      shipment_header: {
        nomor_kiriman: trackingId,
      },
      origin_detail: {},
      package_detail: {},
      billing_detail: {
        cod_info: {
          is_cod: false,
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
  };
}

export function createTrackResponseFromProjection(
  row: SheetRowProjection
): TrackResponse | null {
  if (!isObject(row.detailJson) && !isObject(row.statusJson) && !isObject(row.historyJson)) {
    return null;
  }

  const fallback = createDefaultTrackResponse(row.displayTrackingId);
  const detailJson = isObject(row.detailJson) ? row.detailJson : {};
  const shipmentHeader = isObject(detailJson.shipment_header)
    ? detailJson.shipment_header
    : {};
  const historyJson = isObject(row.historyJson) ? row.historyJson : {};
  const history = Array.isArray(historyJson.history) ? historyJson.history : fallback.history;
  const historySummary = isObject(historyJson.history_summary)
    ? historyJson.history_summary
    : fallback.history_summary;

  return {
    url: "",
    detail: {
      ...fallback.detail,
      ...detailJson,
      shipment_header: {
        ...fallback.detail.shipment_header,
        ...shipmentHeader,
        nomor_kiriman:
          typeof shipmentHeader.nomor_kiriman === "string"
            ? shipmentHeader.nomor_kiriman
            : row.displayTrackingId,
      },
    } as TrackResponse["detail"],
    status_akhir: {
      ...fallback.status_akhir,
      ...(isObject(row.statusJson) ? row.statusJson : {}),
    },
    pod: {
      ...fallback.pod,
      ...(isObject(historyJson.pod) ? historyJson.pod : {}),
    },
    history: history as TrackResponse["history"],
    history_summary: historySummary as TrackResponse["history_summary"],
  };
}
