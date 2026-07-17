import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installTestBridge } from "../../../test/bridge";
import { SheetFileMenu } from "./SheetFileMenu";

describe("SheetFileMenu", () => {
  it("opens the persistent application log from the File menu", async () => {
    const invoke = vi.fn(async () => undefined);
    installTestBridge({ invoke });

    render(
      <SheetFileMenu
        isOpen
        style={{ top: 0, left: 0 }}
        recentDocuments={[]}
        canUseAutosave={false}
        isAutosaveEnabled={false}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onAction={(action) => action()}
        onCreateDocument={vi.fn()}
        onOpenDocument={vi.fn()}
        onSaveDocument={vi.fn()}
        onSaveDocumentAs={vi.fn()}
        onCreateDocumentWindow={vi.fn()}
        onOpenDocumentInNewWindow={vi.fn()}
        onOpenRecentDocument={vi.fn()}
        onToggleAutosave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Buka File Log" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_app_log", undefined);
    });
  });
});
