import { fireEvent, render, screen } from "@testing-library/react";
import { SheetTabs } from "./SheetTabs";

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
        onActivateSheet={onActivateSheet}
        onCreateSheet={onCreateSheet}
        onDuplicateActiveSheet={onDuplicateActiveSheet}
        onRenameSheet={onRenameSheet}
        onDeleteSheet={onDeleteSheet}
        onPreviewDisplayScale={vi.fn()}
        onConfirmDisplayScale={vi.fn()}
        onCancelDisplayScale={vi.fn()}
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
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={vi.fn()}
        onConfirmDisplayScale={vi.fn()}
        onCancelDisplayScale={vi.fn()}
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

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onConfirmDisplayScale={vi.fn()}
        onCancelDisplayScale={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Setting"));
    fireEvent.click(screen.getByRole("radio", { name: "Besar" }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("large");
  });

  it("rolls back previewed display scale when settings are cancelled", () => {
    const onPreviewDisplayScale = vi.fn();
    const onCancelDisplayScale = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onConfirmDisplayScale={vi.fn()}
        onCancelDisplayScale={onCancelDisplayScale}
      />
    );

    fireEvent.click(screen.getByText("Setting"));
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("medium");
    expect(onCancelDisplayScale).toHaveBeenCalledTimes(1);
  });

  it("keeps previewed display scale when settings are confirmed", () => {
    const onPreviewDisplayScale = vi.fn();
    const onConfirmDisplayScale = vi.fn();

    render(
      <SheetTabs
        tabs={[{ id: "sheet-1", name: "Sheet 1", isActive: true }]}
        activeSheetId="sheet-1"
        displayScale="small"
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
        onPreviewDisplayScale={onPreviewDisplayScale}
        onConfirmDisplayScale={onConfirmDisplayScale}
        onCancelDisplayScale={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Setting"));
    fireEvent.click(screen.getAllByRole("radio")[2]);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(onPreviewDisplayScale).toHaveBeenCalledWith("large");
    expect(onConfirmDisplayScale).toHaveBeenCalledTimes(1);
  });
});
