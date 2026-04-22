import { invoke } from "@tauri-apps/api/core";
import { KeyboardEvent, MouseEvent as ReactMouseEvent, MutableRefObject, useCallback } from "react";
import { COLUMNS } from "../sheet/columns";
import {
  clearValueFilterInSheet,
  getColumnSortDirection as getColumnSortDirectionFromSheet,
  setColumnWidthInSheet,
  setSortInSheet,
  setTextFilterInSheet,
  toggleRowSelectionInSheet,
  toggleValueFilterInSheet,
  toggleVisibleSelectionInSheet,
} from "../sheet/actions";
import { SheetState } from "../sheet/types";

type WorkspaceTableInteractionNotice = {
  tone: "success" | "error" | "info";
  message: string;
};

type ResizeState = {
  path: string;
  startX: number;
  startWidth: number;
} | null;

type UseWorkspaceTableInteractionControllerOptions = {
  activeSheet: SheetState;
  allVisibleSelected: boolean;
  visibleSelectableKeys: string[];
  resizeStateRef: MutableRefObject<ResizeState>;
  sheetScrollRef: MutableRefObject<HTMLDivElement | null>;
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
  fetchRow: (
    sheetId: string,
    rowKey: string,
    shipmentIdOverride?: string,
    options?: { forceRefresh?: boolean }
  ) => Promise<void>;
  showNotice: (notice: WorkspaceTableInteractionNotice) => void;
};

export function useWorkspaceTableInteractionController({
  activeSheet,
  allVisibleSelected,
  visibleSelectableKeys,
  resizeStateRef,
  sheetScrollRef,
  updateActiveSheet,
  fetchRow,
  showNotice,
}: UseWorkspaceTableInteractionControllerOptions) {
  const openSourceLink = useCallback(
    async (url: string) => {
      try {
        await invoke("open_external_url", { url });
      } catch (error) {
        showNotice({
          tone: "error",
          message: "Gagal membuka sumber tracking.",
        });
        console.error("[ShipFlow] Unable to open source link.", error);
      }
    },
    [showNotice]
  );

  const focusTrackingInputRelative = useCallback(
    (currentInput: HTMLInputElement, offset: number) => {
      const trackingInputs = Array.from(
        sheetScrollRef.current?.querySelectorAll<HTMLInputElement>(
          "tbody .tracking-cell .sheet-input"
        ) ?? []
      );

      if (trackingInputs.length === 0) {
        return false;
      }

      const currentIndex = trackingInputs.indexOf(currentInput);
      if (currentIndex === -1) {
        return false;
      }

      const nextIndex = currentIndex + offset;
      if (nextIndex < 0 || nextIndex >= trackingInputs.length) {
        return false;
      }

      trackingInputs[nextIndex]?.focus();
      return true;
    },
    [sheetScrollRef]
  );

  const handleTrackingInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, sheetId: string, rowKey: string) => {
      const currentInput = event.currentTarget;
      event.stopPropagation();
      if ("stopImmediatePropagation" in event.nativeEvent) {
        event.nativeEvent.stopImmediatePropagation();
      }

      const hasSelectedText =
        typeof currentInput.selectionStart === "number" &&
        typeof currentInput.selectionEnd === "number" &&
        currentInput.selectionStart !== currentInput.selectionEnd;

      if (event.key === "Enter") {
        event.preventDefault();
        if (hasSelectedText) {
          return;
        }
        const moved = focusTrackingInputRelative(currentInput, 1);
        if (!moved) {
          void fetchRow(sheetId, rowKey, currentInput.value);
          currentInput.blur();
        }
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusTrackingInputRelative(currentInput, 1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusTrackingInputRelative(currentInput, -1);
      }
    },
    [fetchRow, focusTrackingInputRelative]
  );

  const handleFilterChange = useCallback(
    (path: string, value: string) => {
      updateActiveSheet((current) => setTextFilterInSheet(current, path, value));
    },
    [updateActiveSheet]
  );

  const toggleColumnValueFilter = useCallback(
    (path: string, value: string) => {
      updateActiveSheet((current) => toggleValueFilterInSheet(current, path, value));
    },
    [updateActiveSheet]
  );

  const clearColumnValueFilter = useCallback(
    (path: string) => {
      updateActiveSheet((current) => clearValueFilterInSheet(current, path));
    },
    [updateActiveSheet]
  );

  const setColumnSort = useCallback(
    (path: string, direction: "asc" | "desc" | null) => {
      updateActiveSheet((current) => setSortInSheet(current, path, direction));
    },
    [updateActiveSheet]
  );

  const getColumnSortDirection = useCallback(
    (path: string) => getColumnSortDirectionFromSheet(activeSheet, path),
    [activeSheet]
  );

  const toggleRowSelection = useCallback(
    (rowKey: string) => {
      updateActiveSheet((current) => toggleRowSelectionInSheet(current, rowKey));
    },
    [updateActiveSheet]
  );

  const toggleVisibleSelection = useCallback(() => {
    updateActiveSheet((current) =>
      toggleVisibleSelectionInSheet(current, allVisibleSelected, visibleSelectableKeys)
    );
  }, [allVisibleSelected, updateActiveSheet, visibleSelectableKeys]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLSpanElement>, column: (typeof COLUMNS)[number]) => {
      event.preventDefault();
      event.stopPropagation();

      resizeStateRef.current = {
        path: column.path,
        startX: event.clientX,
        startWidth: activeSheet.columnWidths[column.path],
      };

      const handlePointerMove = (moveEvent: MouseEvent) => {
        const activeResize = resizeStateRef.current;
        if (!activeResize) {
          return;
        }

        const nextWidth = Math.max(
          column.minWidth ?? 100,
          activeResize.startWidth + moveEvent.clientX - activeResize.startX
        );

        updateActiveSheet((current) =>
          setColumnWidthInSheet(current, activeResize.path, nextWidth)
        );
      };

      const handlePointerUp = () => {
        resizeStateRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", handlePointerMove);
        document.removeEventListener("mouseup", handlePointerUp);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handlePointerMove);
      document.addEventListener("mouseup", handlePointerUp);
    },
    [activeSheet.columnWidths, resizeStateRef, updateActiveSheet]
  );

  return {
    clearColumnValueFilter,
    getColumnSortDirection,
    handleFilterChange,
    handleResizeStart,
    handleTrackingInputKeyDown,
    openSourceLink,
    setColumnSort,
    toggleColumnValueFilter,
    toggleRowSelection,
    toggleVisibleSelection,
  };
}
