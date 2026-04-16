import { fireEvent, render, screen } from "@testing-library/react";
import { SheetTabs } from "./SheetTabs";
import { ApiServiceStatus, ServiceConfig } from "../../../types";

function createServiceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    version: 1,
    enabled: false,
    mode: "local",
    port: 18422,
    authToken: "",
    lastUpdatedAt: "",
    ...overrides,
  };
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
  it("switches, renames, duplicates, creates, and deletes sheets", () => {
    const onActivateSheet = vi.fn();
    const onCreateSheet = vi.fn();
    const onDuplicateActiveSheet = vi.fn();
    const onRenameSheet = vi.fn();
    const onDeleteSheet = vi.fn();

    render(
      <SheetTabs
        tabs={[
          { id: "sheet-1", name: "Sheet 1", isActive: true },
          { id: "sheet-2", name: "Sheet 2", isActive: false },
        ]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={onActivateSheet}
        onCreateSheet={onCreateSheet}
        onDuplicateActiveSheet={onDuplicateActiveSheet}
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

    fireEvent.click(screen.getByRole("button", { name: "Duplikat Sheet Aktif" }));
    expect(onDuplicateActiveSheet).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Ganti Nama" }));
    const renameInput = screen.getByDisplayValue("Sheet 1");
    fireEvent.change(renameInput, { target: { value: "Case COD" } });
    fireEvent.blur(renameInput);
    expect(onRenameSheet).toHaveBeenCalledWith("sheet-1", "Case COD");

    fireEvent.click(screen.getByRole("button", { name: "Hapus Sheet Aktif" }));
    fireEvent.click(screen.getByRole("button", { name: "Konfirmasi Hapus Sheet Aktif" }));
    expect(onDeleteSheet).toHaveBeenCalledWith("sheet-1");
  });

  it("disables mass sheet actions while renaming is active", () => {
    render(
      <SheetTabs
        tabs={[
          { id: "sheet-1", name: "Sheet 1", isActive: true },
          { id: "sheet-2", name: "Sheet 2", isActive: false },
        ]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
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

    fireEvent.click(screen.getByRole("button", { name: "Ganti Nama" }));

    expect(screen.getByRole("button", { name: "Sheet Baru" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Duplikat Sheet Aktif" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Hapus Sheet Aktif" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Simpan Nama" })).toBeEnabled();
  });

  it("changes display scale from the settings menu", () => {
    const onPreviewDisplayScale = vi.fn();
    const onPreviewServiceEnabled = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onPreviewServiceEnabled={onPreviewServiceEnabled}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={vi.fn()}
        onConfirmSettings={vi.fn()}
        onCancelSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Setting"));
    fireEvent.click(screen.getByRole("radio", { name: "Besar" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable API Service" }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("large");
    expect(onPreviewServiceEnabled).toHaveBeenCalledWith(true);
  });

  it("rolls back previewed display scale when settings are cancelled", () => {
    const onPreviewDisplayScale = vi.fn();
    const onCancelSettings = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig()}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
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

    fireEvent.click(screen.getByText("Setting"));
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("medium");
    expect(onCancelSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps previewed display scale when settings are confirmed", () => {
    const onPreviewDisplayScale = vi.fn();
    const onConfirmSettings = vi.fn();
    const onRegenerateServiceToken = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig({ authToken: "sf_existing" })}
        serviceStatus={createServiceStatus()}
        hasPendingServiceConfigChanges={false}
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onPreviewServiceEnabled={vi.fn()}
        onPreviewServiceMode={vi.fn()}
        onPreviewServicePort={vi.fn()}
        onGenerateServiceToken={vi.fn()}
        onRegenerateServiceToken={onRegenerateServiceToken}
        onConfirmSettings={onConfirmSettings}
        onCancelSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Setting"));
    fireEvent.click(screen.getAllByRole("radio")[2]);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate Token" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("large");
    expect(onRegenerateServiceToken).toHaveBeenCalledTimes(1);
    expect(onConfirmSettings).toHaveBeenCalledTimes(1);
  });

  it("shows runtime service status and pending preview warning in settings", () => {
    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        serviceConfig={createServiceConfig({ enabled: true, mode: "lan", port: 19422 })}
        serviceStatus={createServiceStatus({
          status: "running",
          enabled: true,
          mode: "local",
          bindAddress: "127.0.0.1",
          port: 18422,
        })}
        hasPendingServiceConfigChanges
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
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

    fireEvent.click(screen.getByText("Setting"));

    expect(screen.getByText("Runtime Status")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:18422")).toBeInTheDocument();
    expect(
      screen.getByText("Perubahan API service belum diterapkan. Klik OK untuk menyimpan.")
    ).toBeInTheDocument();
  });
});
