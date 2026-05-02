import { ChangeEvent } from "react";
import { ImportSourceLookupStates, ImportSourceModalKind } from "../types";

function parseManifestBagIds(rawResponse: string) {
  if (!rawResponse) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(rawResponse) as {
      items?: Array<{ nomor_kantung?: string }>;
    };

    if (!Array.isArray(parsed.items)) {
      return [] as string[];
    }

    const seen = new Set<string>();
    const bagIds: string[] = [];

    parsed.items.forEach((item) => {
      const bagId = item.nomor_kantung?.trim() ?? "";
      if (!bagId || seen.has(bagId)) {
        return;
      }

      seen.add(bagId);
      bagIds.push(bagId);
    });

    return bagIds;
  } catch {
    return [] as string[];
  }
}

function getManifestBagStatusClass(loading: boolean, error: string) {
  if (loading) {
    return "status-loading";
  }

  if (error.trim() !== "") {
    return "status-error";
  }

  return "status-ready";
}

function getManifestCompletedBagCount(
  manifestBagStates: NonNullable<
    ImportSourceLookupStates["manifest"]["manifestBagStates"]
  >
) {
  return manifestBagStates.filter((state) => !state.loading).length;
}

function getManifestTrackingIds(
  manifestBagStates: NonNullable<
    ImportSourceLookupStates["manifest"]["manifestBagStates"]
  >
) {
  const trackingIds = new Set<string>();

  manifestBagStates.forEach((state) => {
    state.trackingIds.forEach((trackingId) => {
      const normalizedTrackingId = trackingId.trim();
      if (normalizedTrackingId !== "") {
        trackingIds.add(normalizedTrackingId);
      }
    });
  });

  return Array.from(trackingIds);
}

function getManifestTrackingIdTotal(
  manifestBagStates: NonNullable<
    ImportSourceLookupStates["manifest"]["manifestBagStates"]
  >
) {
  return getManifestTrackingIds(manifestBagStates).length;
}

function getManifestResultLabel(
  manifestBagStates: NonNullable<
    ImportSourceLookupStates["manifest"]["manifestBagStates"]
  >
) {
  const totalBagCount = manifestBagStates.length;
  const completedBagCount = getManifestCompletedBagCount(manifestBagStates);

  if (manifestBagStates.some((state) => state.loading)) {
    return `Nomor Kantung (${totalBagCount}) - Proses ambil id kiriman dari ${completedBagCount}/${totalBagCount} kantung`;
  }

  return `Nomor Kantung (${totalBagCount}) - ${getManifestTrackingIdTotal(
    manifestBagStates
  )} Kiriman`;
}

function getManifestBagItemLabel(
  state: NonNullable<ImportSourceLookupStates["manifest"]["manifestBagStates"]>[number]
) {
  if (state.loading) {
    return state.bagId;
  }

  if (state.error.trim() !== "") {
    return `${state.bagId} - Gagal ambil data`;
  }

  return `${state.bagId} - ${state.trackingIds.length} Kiriman`;
}

type ImportSourceModalProps = {
  kind: ImportSourceModalKind;
  value: string;
  lookupState: ImportSourceLookupStates[ImportSourceModalKind];
  onValueChange: (value: string) => void;
  onImportBagTrackingIds: (mode: "replace" | "append") => void;
  onImportManifestTrackingIds: (mode: "replace" | "append") => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function ImportSourceModal({
  kind,
  value,
  lookupState,
  onValueChange,
  onImportBagTrackingIds,
  onImportManifestTrackingIds,
  onSubmit,
  onClose,
}: ImportSourceModalProps) {
  const title =
    kind === "bag"
      ? "Import ID Kiriman dari Bag"
      : "Import ID Kiriman dari Manifest";
  const inputLabel = kind === "bag" ? "ID Bag" : "ID Manifest";
  const inputPlaceholder =
    kind === "bag" ? "Masukkan ID Bag" : "Masukkan ID Manifest";
  const inputId = `import-source-input-${kind}`;
  const isBagModal = kind === "bag";
  const manifestBagStates = !isBagModal
    ? lookupState.manifestBagStates?.length
      ? lookupState.manifestBagStates
      : parseManifestBagIds(lookupState.rawResponse).map((bagId) => ({
          bagId,
          loading: false,
          error: "",
          trackingIds: [],
        }))
    : [];
  const manifestTrackingIds = !isBagModal
    ? getManifestTrackingIds(manifestBagStates)
    : [];
  const manifestHasPendingBagLookups = manifestBagStates.some((state) => state.loading);

  return (
    <div className="import-source-modal-backdrop">
      <div
        className="import-source-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-source-modal-title"
      >
        <div className="import-source-modal-header">
          <div>
            <h3 id="import-source-modal-title">{title}</h3>
          </div>
        </div>
        <div className="import-source-modal-body">
          <div className="import-source-modal-field">
            <label htmlFor={inputId} className="import-source-modal-label">
              {inputLabel}
            </label>
            <input
              id={inputId}
              type="text"
              className="import-source-modal-input"
              value={value}
              placeholder={inputPlaceholder}
              autoFocus
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onValueChange(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !lookupState.loading) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
          </div>
          {lookupState.error ? (
            <p className="import-source-modal-error" role="alert">
              {lookupState.error}
            </p>
          ) : null}
          {isBagModal && lookupState.trackingIds.length > 0 ? (
            <div className="import-source-modal-result">
              <span className="import-source-modal-result-label">
                Nomor Kiriman ({lookupState.trackingIds.length})
              </span>
              <div className="import-source-modal-id-list">
                {lookupState.trackingIds.map((trackingId) => (
                  <div key={trackingId} className="import-source-modal-id-item">
                    {trackingId}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {isBagModal && lookupState.rawResponse && lookupState.trackingIds.length === 0 ? (
            <p className="import-source-modal-empty">
              Tidak ada nomor kiriman yang ditemukan pada hasil Bag.
            </p>
          ) : null}
          {!isBagModal && manifestBagStates.length > 0 ? (
            <div className="import-source-modal-result">
              <span className="import-source-modal-result-label">
                {getManifestResultLabel(manifestBagStates)}
              </span>
              <div className="import-source-modal-id-list">
                {manifestBagStates.map((state) => (
                  <div
                    key={state.bagId}
                    className="import-source-modal-id-item import-source-modal-id-item-with-status"
                    title={
                      state.error
                        ? `${state.bagId}: ${state.error}`
                        : state.loading
                          ? `${state.bagId}: sedang dilacak`
                          : `${state.bagId}: ${state.trackingIds.length} nomor kiriman`
                    }
                  >
                    <span
                      className={`row-status-dot ${getManifestBagStatusClass(
                        state.loading,
                        state.error
                      )}`}
                      aria-hidden="true"
                    />
                    <span>{getManifestBagItemLabel(state)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {!isBagModal && lookupState.rawResponse && manifestBagStates.length === 0 ? (
            <p className="import-source-modal-empty">
              Tidak ada nomor kantung yang ditemukan pada hasil Manifest.
            </p>
          ) : null}
        </div>
        <div className="import-source-modal-footer">
          {isBagModal ? (
            <>
              <button
                type="button"
                className="action-button"
                onClick={() => onImportBagTrackingIds("replace")}
                disabled={lookupState.loading || lookupState.trackingIds.length === 0}
              >
                Ganti Semua
              </button>
              <button
                type="button"
                className="action-button"
                onClick={() => onImportBagTrackingIds("append")}
                disabled={lookupState.loading || lookupState.trackingIds.length === 0}
              >
                Tambah Data
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="action-button"
                onClick={() => onImportManifestTrackingIds("replace")}
                disabled={
                  lookupState.loading ||
                  manifestHasPendingBagLookups ||
                  manifestTrackingIds.length === 0
                }
              >
                Ganti Semua
              </button>
              <button
                type="button"
                className="action-button"
                onClick={() => onImportManifestTrackingIds("append")}
                disabled={
                  lookupState.loading ||
                  manifestHasPendingBagLookups ||
                  manifestTrackingIds.length === 0
                }
              >
                Tambah Data
              </button>
            </>
          )}
          <button
            type="button"
            className="action-button action-button-accent"
            onClick={onSubmit}
            disabled={lookupState.loading || value.trim() === ""}
          >
            {lookupState.loading ? "Memuat..." : "Ambil Data"}
          </button>
          <button type="button" className="action-button" onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
