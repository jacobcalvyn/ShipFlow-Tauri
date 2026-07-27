import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { COLUMNS } from "../columns";
import { ColumnHeaderCell } from "./ColumnHeaderCell";

function renderColumnHeader(optionCount: number) {
  const onSetValueFilterSelection = vi.fn();
  const column = COLUMNS[0];

  const view = render(
    <table>
      <thead>
        <tr>
          <ColumnHeaderCell
            column={column}
            columnIndex={0}
            width={column.defaultWidth}
            isPinned={false}
            hoveredColumn={null}
            sortDirection={null}
            hiddenColumns={[]}
            selectedValueFilters={[]}
            availableValueOptions={Array.from({ length: optionCount }, (_, index) => ({
              value: `P${index}`,
              count: 1,
            }))}
            isMenuOpen
            isHighlighted={false}
            onHoverColumn={vi.fn()}
            onToggleMenu={vi.fn()}
            onResizeStart={vi.fn()}
            onSetSort={vi.fn()}
            onTogglePinned={vi.fn()}
            onToggleVisibility={vi.fn()}
            onToggleValueFilter={vi.fn()}
            onSetValueFilterSelection={onSetValueFilterSelection}
            onClearValueFilter={vi.fn()}
            onCloseMenu={vi.fn()}
            onMenuRef={vi.fn()}
          />
        </tr>
      </thead>
    </table>
  );

  return { ...view, onSetValueFilterSelection };
}

describe("ColumnHeaderCell", () => {
  it("disables exclusion when value options may be truncated", () => {
    const { container, onSetValueFilterSelection } = renderColumnHeader(1_000);
    const status = container.querySelector<HTMLElement>('[role="status"]');
    const excludeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter except P0"]'
    );

    expect(status).toHaveTextContent("Daftar nilai mencapai batas 1.000 opsi");
    expect(excludeButton).toBeDisabled();

    fireEvent.click(excludeButton as HTMLButtonElement);
    expect(onSetValueFilterSelection).not.toHaveBeenCalled();
  });

  it("keeps exclusion available for a complete value option list", () => {
    const { onSetValueFilterSelection } = renderColumnHeader(2);
    const excludeButton = screen.getByRole("button", {
      name: "Filter except P0",
    });

    expect(excludeButton).not.toBeDisabled();
    fireEvent.click(excludeButton);
    expect(onSetValueFilterSelection).toHaveBeenCalledWith(COLUMNS[0].path, ["P1"]);
  });
});
