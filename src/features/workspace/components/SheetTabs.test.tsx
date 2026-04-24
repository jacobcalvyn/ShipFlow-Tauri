import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SheetTabs } from "./SheetTabs";
import { ApiServiceStatus, ServiceConfig } from "../../../types";

function createServiceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    version: 1,
    desktopConnectionMode: "managedLocal",
    desktopServiceUrl: "http://127.0.0.1:18422",
    desktopServiceAuthToken: "",
    enabled: false,
    mode: "local",
    port: 18422,
    authToken: "",
    trackingSource: "default",
    externalApiBaseUrl: "",
    externalApiAuthToken: "",
    allowInsecureExternalApiHttp: false,
    keepRunningInTray: true,
    lastUpdatedAt: "",
    ...overrides,
  };
}

function openSheetTabMenu(name: string) {
  const tabTrigger = screen.getByRole("tab", { name });
  fireEvent.contextMenu(tabTrigger);
  return tabTrigger;
}

function createServiceStatus(
  overrides: Partial<ApiServiceStatus> = {}
): ApiServiceStatus {
  return {
    status: "stopped",
    enabled: false,
    mode: null,
    bindAddress: null,
    port: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("SheetTabs", () => {
  it("switches, duplicates, renames, creates, and deletes sheets", () => {
    const onActivateSheet = vi.fn();
    const onCreateSheet = vi.fn();
    const onDuplicateSheet = vi.fn();
    const onRenameSheet = vi.fn();
    const onDeleteSheet = vi.fn();

    render(
      <SheetTabs
        tabs={[
          { id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true },
          { id: "sheet-2", name: "Sheet 2", color: "blue", icon: "pin", isActive: false },
        ]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={onActivateSheet}
        onCreateSheet={onCreateSheet}
        onDuplicateSheet={onDuplicateSheet}
        onRenameSheet={onRenameSheet}
        onDeleteSheet={onDeleteSheet}
        onPreviewDisplayScale={vi.fn()}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Sheet 2" }));
    expect(onActivateSheet).toHaveBeenCalledWith("sheet-2");

    fireEvent.click(screen.getByRole("button", { name: "Sheet Baru" }));
    expect(onCreateSheet).toHaveBeenCalled();

    openSheetTabMenu("Sheet 1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplikat" }));
    expect(onDuplicateSheet).toHaveBeenCalledWith("sheet-1");
    expect(screen.queryByLabelText("Sheet style presets")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Gabungkan ke Sheet Lain" })
    ).not.toBeInTheDocument();

    openSheetTabMenu("Sheet 1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Ganti Nama" }));
    const renameInput = screen.getByDisplayValue("Sheet 1");
    fireEvent.change(renameInput, { target: { value: "Case COD" } });
    fireEvent.blur(renameInput);
    expect(onRenameSheet).toHaveBeenCalledWith("sheet-1", "Case COD");

    openSheetTabMenu("Sheet 1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Konfirmasi Hapus" }));
    expect(onDeleteSheet).toHaveBeenCalledWith("sheet-1");
  });

  it("disables mass sheet actions while renaming is active", () => {
    render(
      <SheetTabs
        tabs={[
          { id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true },
          { id: "sheet-2", name: "Sheet 2", color: "blue", icon: "pin", isActive: false },
        ]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={vi.fn()}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={vi.fn()}
      />
    );

    openSheetTabMenu("Sheet 1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Ganti Nama" }));

    expect(screen.getByRole("button", { name: "Sheet Baru" })).toBeDisabled();
    expect(screen.queryByRole("menuitem", { name: "Duplikat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Hapus" })).not.toBeInTheDocument();
  });

  it("renames an inactive sheet from its action menu without activating it first", () => {
    const onActivateSheet = vi.fn();
    const onRenameSheet = vi.fn();

    render(
      <SheetTabs
        tabs={[
          { id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true },
          { id: "sheet-2", name: "Sheet 2", color: "blue", icon: "pin", isActive: false },
        ]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={onActivateSheet}
        onCreateSheet={vi.fn()}
        onDuplicateSheet={vi.fn()}
        onRenameSheet={onRenameSheet}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={vi.fn()}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={vi.fn()}
      />
    );

    openSheetTabMenu("Sheet 2");
    fireEvent.click(screen.getByRole("menuitem", { name: "Ganti Nama" }));

    const renameInput = screen.getByDisplayValue("Sheet 2");
    fireEvent.change(renameInput, { target: { value: "Sheet Follow Up" } });
    fireEvent.blur(renameInput);

    expect(onActivateSheet).not.toHaveBeenCalled();
    expect(onRenameSheet).toHaveBeenCalledWith("sheet-2", "Sheet Follow Up");
  });

  it("changes display scale from the settings menu", () => {
    const onPreviewDisplayScale = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getByRole("radio", { name: /Besar/i }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("large");
  });

  it("rolls back previewed display scale when settings are cancelled", () => {
    const onPreviewDisplayScale = vi.fn();
    const onCancelSettings = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={onCancelSettings}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("medium");
    expect(onCancelSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps previewed display scale when settings are confirmed", async () => {
    const onPreviewDisplayScale = vi.fn();
    const onConfirmSettings = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig({ authToken: "sf_existing" })}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={onConfirmSettings}
        onCancelSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    fireEvent.click(screen.getAllByRole("radio")[2]);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => {
      expect(onPreviewDisplayScale).toHaveBeenCalledWith("large");
      expect(onConfirmSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("opens ShipFlow Service from the desktop settings modal", () => {
    const onOpenServiceSettings = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus({ status: "running" })}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={vi.fn()}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={vi.fn()}
        onOpenServiceSettings={onOpenServiceSettings}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Setting" }));
    expect(screen.getByText("ShipFlow Service")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Buka ShipFlow Service" }));

    expect(onOpenServiceSettings).toHaveBeenCalledTimes(1);
  });

  it("drops dragged selections onto another sheet with copy mode", () => {
    const onDropSelectionToSheet = vi.fn();

    render(
      <SheetTabs
        tabs={[
          { id: "sheet-1", name: "Sheet 1", color: "slate", icon: "sheet", isActive: true },
          { id: "sheet-2", name: "Sheet 2", color: "blue", icon: "pin", isActive: false },
        ]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={vi.fn()}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onPreviewServiceKeepRunningInTray={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onCopyServiceEndpoint={vi.fn()}
        onCopyServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={vi.fn()}
        isSelectionDragActive
        selectionDragSourceSheetId="sheet-1"
        onDropSelectionToSheet={onDropSelectionToSheet}
      />
    );

    const targetWrapper = screen.getByRole("tab", { name: "Sheet 2" }).closest(".sheet-tab");
    if (!targetWrapper) {
      throw new Error("Target sheet wrapper not found.");
    }

    fireEvent.dragOver(targetWrapper, {
      altKey: true,
      dataTransfer: { dropEffect: "move" },
    });
    fireEvent.drop(targetWrapper, {
      altKey: true,
      dataTransfer: { dropEffect: "copy" },
    });

    expect(onDropSelectionToSheet).toHaveBeenCalledWith("sheet-2", "copy");
  });

});
