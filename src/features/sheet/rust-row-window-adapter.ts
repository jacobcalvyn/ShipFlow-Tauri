import type { TrackResponse } from "../../types";
import type { SheetRowProjection } from "../workspace-engine/client";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseObjectValue(value: unknown): Record<string, unknown> | null {
  if (isObject(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const detailJson = parseObjectValue(row.detailJson);
  const statusJson = parseObjectValue(row.statusJson);
  const historyJson = parseObjectValue(row.historyJson);

  if (!detailJson && !statusJson && !historyJson) {
    return null;
  }

  const fallback = createDefaultTrackResponse(row.displayTrackingId);
  const normalizedDetailJson = detailJson ?? {};
  const shipmentHeader = isObject(normalizedDetailJson.shipment_header)
    ? normalizedDetailJson.shipment_header
    : {};
  const normalizedHistoryJson = historyJson ?? {};
  const history = Array.isArray(normalizedHistoryJson.history)
    ? normalizedHistoryJson.history
    : fallback.history;
  const historySummary = isObject(normalizedHistoryJson.history_summary)
    ? normalizedHistoryJson.history_summary
    : fallback.history_summary;

  return {
    url: "",
    detail: {
      ...fallback.detail,
      ...normalizedDetailJson,
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
      ...(statusJson ?? {}),
    },
    pod: {
      ...fallback.pod,
      ...(isObject(normalizedHistoryJson.pod) ? normalizedHistoryJson.pod : {}),
    },
    history: history as TrackResponse["history"],
    history_summary: historySummary as TrackResponse["history_summary"],
  };
}
