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
        onActivateSheet={onActivateSheet}
        onCreateSheet={onCreateSheet}
        onDuplicateActiveSheet={onDuplicateActiveSheet}
        onRenameSheet={onRenameSheet}
        onDeleteSheet={onDeleteSheet}
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
        onActivateSheet={vi.fn()}
        onCreateSheet={vi.fn()}
        onDuplicateActiveSheet={vi.fn()}
        onRenameSheet={vi.fn()}
        onDeleteSheet={vi.fn()}
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
});
