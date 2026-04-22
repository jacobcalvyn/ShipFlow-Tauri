import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SheetActionBar } from "./SheetActionBar";

describe("SheetActionBar", () => {
  it("renders selection actions and wires callbacks", () => {
    const onRetrackAll = vi.fn();
    const onExportCsv = vi.fn();
    const onCopyAllIds = vi.fn();
    const onDeleteAllRows = vi.fn();
    const onClearSelection = vi.fn();
    const onTransferSelectedIdsToNewSheet = vi.fn();
    const onTransferSelectedIdsToSheet = vi.fn();
    const onClearFilter = vi.fn();
    const onCopySelectedIds = vi.fn();
    const onDeleteSelectedRows = vi.fn();
    const onClearHiddenFilters = vi.fn();
    const onScrollToColumn = vi.fn();

    render(
      <SheetActionBar
        loadedCount={12}
        totalShipmentCount={16}
        loadingCount={4}
        retrackableRowsCount={12}
        retryFailedRowsCount={2}
        deleteAllArmed={false}
        exportableRowsCount={12}
        activeFilterCount={2}
        selectedRowCount={3}
        deleteSelectedArmed={false}
        ignoredHiddenFilterCount={1}
        columnShortcuts={[
          {
            path: "status_akhir.status",
            label: "Status Akhir",
            disabled: false,
            toneClass: "tone-status",
          },
        ]}
        onRetrackAll={onRetrackAll}
        onRetryFailedRows={vi.fn()}
        onExportCsv={onExportCsv}
        onCopyAllIds={onCopyAllIds}
        onDeleteAllRows={onDeleteAllRows}
        onClearSelection={onClearSelection}
        onTransferSelectedIdsToNewSheet={onTransferSelectedIdsToNewSheet}
        targetSheetOptions={[
          { id: "sheet-2", name: "Sheet 2" },
          { id: "sheet-3", name: "Sheet 3" },
        ]}
        onTransferSelectedIdsToSheet={onTransferSelectedIdsToSheet}
        onClearFilter={onClearFilter}
        onCopySelectedIds={onCopySelectedIds}
        onDeleteSelectedRows={onDeleteSelectedRows}
        onClearHiddenFilters={onClearHiddenFilters}
        onScrollToColumn={onScrollToColumn}
        importSourceModalKind={null}
        importSourceDrafts={{ bag: "", manifest: "" }}
        importSourceLookupStates={{
          bag: { loading: false, rawResponse: "", error: "", trackingIds: [] },
          manifest: { loading: false, rawResponse: "", error: "", trackingIds: [] },
        }}
        onOpenImportSourceModal={vi.fn()}
        onCloseImportSourceModal={vi.fn()}
        onSetImportSourceDraft={vi.fn()}
        onImportBagTrackingIds={vi.fn()}
        onImportManifestTrackingIds={vi.fn()}
        onRunImportSourceLookup={vi.fn()}
      />
    );

    expect(screen.getByText("12/16 kiriman dimuat")).toBeInTheDocument();
    expect(screen.getByText("3 row dipilih")).toBeInTheDocument();
    expect(screen.getByText("Import From")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bag" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manifest" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Lacak Ulang" }));
    expect(onRetrackAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(onExportCsv).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy ID Kiriman" }));
    expect(onCopyAllIds).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus Semua"));
    expect(onDeleteAllRows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Status Akhir"));
    expect(onScrollToColumn).toHaveBeenCalledWith("status_akhir.status");

    fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ID Terselect ke Sheet Baru" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Salin" }));
    expect(onTransferSelectedIdsToNewSheet).toHaveBeenCalledWith("copy");

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ID Terselect ke Sheet Lain" }));
    expect(screen.queryByRole("menuitem", { name: "Sheet 2" })).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Pindahkan" }));
    expect(screen.getByRole("menuitem", { name: "Sheet 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sheet 2" }));
    expect(onTransferSelectedIdsToSheet).toHaveBeenCalledWith("move", "sheet-2");

    fireEvent.click(screen.getByText("Clear Filter"));
    expect(onClearFilter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Copy ID Kiriman Terselect"));
    expect(onCopySelectedIds).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus Terselect"));
    expect(onDeleteSelectedRows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Filter tersembunyi diabaikan: 1"));
    expect(onClearHiddenFilters).toHaveBeenCalledTimes(1);
  });

  it("keeps selection row visible and disabled when nothing is selected", () => {
    render(
      <SheetActionBar
        loadedCount={0}
        totalShipmentCount={0}
        loadingCount={0}
        retrackableRowsCount={0}
        retryFailedRowsCount={0}
        deleteAllArmed={false}
        exportableRowsCount={0}
        activeFilterCount={0}
        selectedRowCount={0}
        deleteSelectedArmed={false}
        ignoredHiddenFilterCount={0}
        columnShortcuts={[]}
        onRetrackAll={vi.fn()}
        onRetryFailedRows={vi.fn()}
        onExportCsv={vi.fn()}
        onCopyAllIds={vi.fn()}
        onDeleteAllRows={vi.fn()}
        onClearSelection={vi.fn()}
        onTransferSelectedIdsToNewSheet={vi.fn()}
        targetSheetOptions={[]}
        onTransferSelectedIdsToSheet={vi.fn()}
        onClearFilter={vi.fn()}
        onCopySelectedIds={vi.fn()}
        onDeleteSelectedRows={vi.fn()}
        onClearHiddenFilters={vi.fn()}
        onScrollToColumn={vi.fn()}
        importSourceModalKind={null}
        importSourceDrafts={{ bag: "", manifest: "" }}
        importSourceLookupStates={{
          bag: { loading: false, rawResponse: "", error: "", trackingIds: [] },
          manifest: { loading: false, rawResponse: "", error: "", trackingIds: [] },
        }}
        onOpenImportSourceModal={vi.fn()}
        onCloseImportSourceModal={vi.fn()}
        onSetImportSourceDraft={vi.fn()}
        onImportBagTrackingIds={vi.fn()}
        onImportManifestTrackingIds={vi.fn()}
        onRunImportSourceLookup={vi.fn()}
      />
    );

    expect(screen.getByText("0 row dipilih")).toBeInTheDocument();
    expect(screen.getByText("Import From")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bag" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manifest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Selection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ID Terselect ke Sheet Baru" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ID Terselect ke Sheet Lain" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy ID Kiriman Terselect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hapus Terselect" })).toBeDisabled();
  });

  it("opens import modals and only closes them through the close button", () => {
    function TestHarness() {
      const [importSourceModalKind, setImportSourceModalKind] = useState<
        "bag" | "manifest" | null
      >(null);
      const [importSourceDrafts, setImportSourceDrafts] = useState({
        bag: "",
        manifest: "",
      });
      const [importSourceLookupStates, setImportSourceLookupStates] = useState({
        bag: { loading: false, rawResponse: "", error: "", trackingIds: [] as string[] },
        manifest: { loading: false, rawResponse: "", error: "", trackingIds: [] as string[] },
      });

      return (
        <SheetActionBar
          loadedCount={0}
          totalShipmentCount={0}
          loadingCount={0}
          retrackableRowsCount={0}
          retryFailedRowsCount={0}
          deleteAllArmed={false}
          exportableRowsCount={0}
          activeFilterCount={0}
          selectedRowCount={0}
          deleteSelectedArmed={false}
          ignoredHiddenFilterCount={0}
          columnShortcuts={[]}
          onRetrackAll={vi.fn()}
          onRetryFailedRows={vi.fn()}
          onExportCsv={vi.fn()}
          onCopyAllIds={vi.fn()}
          onDeleteAllRows={vi.fn()}
          onClearSelection={vi.fn()}
          onTransferSelectedIdsToNewSheet={vi.fn()}
          targetSheetOptions={[]}
          onTransferSelectedIdsToSheet={vi.fn()}
          onClearFilter={vi.fn()}
          onCopySelectedIds={vi.fn()}
          onDeleteSelectedRows={vi.fn()}
          onClearHiddenFilters={vi.fn()}
          onScrollToColumn={vi.fn()}
          importSourceModalKind={importSourceModalKind}
          importSourceDrafts={importSourceDrafts}
          importSourceLookupStates={importSourceLookupStates}
          onOpenImportSourceModal={setImportSourceModalKind}
          onCloseImportSourceModal={() => setImportSourceModalKind(null)}
          onSetImportSourceDraft={(kind, value) =>
            setImportSourceDrafts((current) => ({
              ...current,
              [kind]: value,
            }))
          }
          onImportBagTrackingIds={vi.fn()}
          onImportManifestTrackingIds={vi.fn()}
          onRunImportSourceLookup={(kind) =>
            setImportSourceLookupStates((current) => ({
              ...current,
              [kind]: {
                loading: false,
                rawResponse:
                  kind === "bag"
                    ? JSON.stringify(
                        {
                          url: `https://example.test/bag/${importSourceDrafts.bag}`,
                          nomor_kantung: importSourceDrafts.bag,
                          items: [
                            {
                              no: "1",
                              no_resi: "P260000000001",
                              status: "UNBAGGING",
                              posisi_akhir: "DC JAYAPURA 9910A",
                              tanggal_update: "2026-04-22 08:00:00",
                            },
                            {
                              no: "2",
                              no_resi: "P260000000002",
                              status: "UNBAGGING",
                              posisi_akhir: "DC JAYAPURA 9910A",
                              tanggal_update: "2026-04-22 08:00:00",
                            },
                          ],
                        },
                        null,
                        2
                      )
                    : JSON.stringify(
                        {
                          url: `https://example.test/manifest/${importSourceDrafts.manifest}`,
                          total_berat: "12.5",
                          items: [
                            {
                              no: "1",
                              nomor_kantung: "PID111111",
                              status: "ARRIVED",
                            },
                            {
                              no: "2",
                              nomor_kantung: "PID222222",
                              status: "ARRIVED",
                            },
                          ],
                        },
                        null,
                        2
                      ),
                error: "",
                trackingIds:
                  kind === "bag" && importSourceDrafts.bag.trim() !== ""
                    ? ["P260000000001", "P260000000002"]
                    : [],
                manifestBagStates:
                  kind === "manifest" && importSourceDrafts.manifest.trim() !== ""
                    ? [
                        {
                          bagId: "PID111111",
                          loading: true,
                          error: "",
                          trackingIds: [],
                        },
                        {
                          bagId: "PID222222",
                          loading: true,
                          error: "",
                          trackingIds: [],
                        },
                      ]
                    : [],
              },
            }))
          }
        />
      );
    }

    render(<TestHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    const bagDialog = screen.getByRole("dialog", {
      name: "Import ID Kiriman dari Bag",
    });
    expect(bagDialog).toBeInTheDocument();
    const bagInput = screen.getByLabelText("ID Bag");
    fireEvent.change(bagInput, { target: { value: "PID123" } });
    expect(screen.getByDisplayValue("PID123")).toBeInTheDocument();

    fireEvent.click(bagDialog.parentElement as HTMLElement);
    expect(
      screen.getByRole("dialog", { name: "Import ID Kiriman dari Bag" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
    expect(
      screen.queryByRole("dialog", { name: "Import ID Kiriman dari Bag" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Manifest" }));
    const manifestDialog = screen.getByRole("dialog", {
      name: "Import ID Kiriman dari Manifest",
    });
    expect(
      screen.getByRole("dialog", { name: "Import ID Kiriman dari Manifest" })
    ).toBeInTheDocument();
    const manifestInput = screen.getByLabelText("ID Manifest");
    fireEvent.change(manifestInput, { target: { value: "MNF456" } });
    expect(screen.getByDisplayValue("MNF456")).toBeInTheDocument();
    expect(manifestDialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));
    expect(
      screen.getByText("Nomor Kantung (2) - Proses ambil id kiriman dari 0/2 kantung")
    ).toBeInTheDocument();
    expect(screen.getByText("PID111111")).toBeInTheDocument();
    expect(screen.getByText("PID222222")).toBeInTheDocument();
    expect(
      manifestDialog.querySelectorAll(".row-status-dot.status-loading")
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Ganti Semua" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tambah Data" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
    fireEvent.click(screen.getByRole("button", { name: "Bag" }));
    fireEvent.change(screen.getByLabelText("ID Bag"), {
      target: { value: "PID123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ambil Data" }));

    expect(screen.getByText("Nomor Kiriman (2)")).toBeInTheDocument();
    expect(screen.getByText("P260000000001")).toBeInTheDocument();
    expect(screen.getByText("P260000000002")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti Semua" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tambah Data" })).toBeEnabled();
    expect(screen.queryByText("Nomor Kantung (2)")).not.toBeInTheDocument();
  });
});
