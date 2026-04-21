import { HIDDEN_COLUMNS_STORAGE_KEY, PINNED_COLUMNS_STORAGE_KEY, SELECTOR_COLUMN_WIDTH } from "../sheet/columns";
import {
  pruneSelectionToVisibleRowsInSheet,
  setHighlightedColumnInSheet,
  setOpenColumnMenuInSheet,
  syncSelectionWithVisibleRowsInSheet,
  toggleColumnVisibilityInSheet,
  togglePinnedColumnInSheet,
} from "../sheet/actions";
import { isBrowserReady } from "../sheet/utils";
import { SheetState } from "../sheet/types";
import {
  MutableRefObject,
  UIEvent,
  useCallback,
  useEffect,
} from "react";

type UseWorkspaceTableShellControllerOptions = {
  activeSheetId: string;
  activeSheetOpenColumnMenuPath: string | null;
  activeSheetSelectionFollowsVisibleRows: boolean;
  hiddenColumnPaths: string[];
  pinnedColumnPaths: string[];
  visibleSelectableKeys: string[];
  selectedVisibleRowKeys: string[];
  selectedTrackingIds: string[];
  visibleColumnPathSet: Set<string>;
  effectiveColumnWidths: Record<string, number>;
  pinnedColumnSet: Set<string>;
  sheetScrollRef: MutableRefObject<HTMLDivElement | null>;
  sheetScrollPositionsRef: MutableRefObject<Map<string, { left: number; top: number }>>;
  columnMenuRefs: MutableRefObject<Map<string, HTMLDivElement | null>>;
  highlightedColumnTimeoutRef: MutableRefObject<number | null>;
  highlightedColumnSheetIdRef: MutableRefObject<string | null>;
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
  updateSheet: (sheetId: string, updater: (sheetState: SheetState) => SheetState) => void;
  copySelectedTrackingIds: () => void;
};

export function useWorkspaceTableShellController({
  activeSheetId,
  activeSheetOpenColumnMenuPath,
  activeSheetSelectionFollowsVisibleRows,
  hiddenColumnPaths,
  pinnedColumnPaths,
  visibleSelectableKeys,
  selectedVisibleRowKeys,
  selectedTrackingIds,
  visibleColumnPathSet,
  effectiveColumnWidths,
  pinnedColumnSet,
  sheetScrollRef,
  sheetScrollPositionsRef,
  columnMenuRefs,
  highlightedColumnTimeoutRef,
  highlightedColumnSheetIdRef,
  updateActiveSheet,
  updateSheet,
  copySelectedTrackingIds,
}: UseWorkspaceTableShellControllerOptions) {
  useEffect(() => {
    const scrollContainer = sheetScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const nextPosition = sheetScrollPositionsRef.current.get(activeSheetId) ?? {
      left: 0,
      top: 0,
    };

    scrollContainer.scrollLeft = nextPosition.left;
    scrollContainer.scrollTop = nextPosition.top;
  }, [activeSheetId, sheetScrollPositionsRef, sheetScrollRef]);

  useEffect(() => {
    if (!activeSheetOpenColumnMenuPath) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const activeMenu = columnMenuRefs.current.get(activeSheetOpenColumnMenuPath);
      if (!activeMenu || !(event.target instanceof Node)) {
        return;
      }

      if (!activeMenu.contains(event.target)) {
        updateActiveSheet((current) => setOpenColumnMenuInSheet(current, null));
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [activeSheetOpenColumnMenuPath, columnMenuRefs, updateActiveSheet]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      HIDDEN_COLUMNS_STORAGE_KEY,
      JSON.stringify(hiddenColumnPaths)
    );
  }, [hiddenColumnPaths]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      PINNED_COLUMNS_STORAGE_KEY,
      JSON.stringify(pinnedColumnPaths)
    );
  }, [pinnedColumnPaths]);

  useEffect(() => {
    return () => {
      if (highlightedColumnTimeoutRef.current !== null) {
        window.clearTimeout(highlightedColumnTimeoutRef.current);
      }
    };
  }, [highlightedColumnTimeoutRef]);

  useEffect(() => {
    if (!activeSheetSelectionFollowsVisibleRows) {
      return;
    }

    updateActiveSheet((current) =>
      syncSelectionWithVisibleRowsInSheet(current, visibleSelectableKeys)
    );
  }, [activeSheetSelectionFollowsVisibleRows, updateActiveSheet, visibleSelectableKeys]);

  useEffect(() => {
    if (activeSheetSelectionFollowsVisibleRows) {
      return;
    }

    updateActiveSheet((current) =>
      pruneSelectionToVisibleRowsInSheet(current, visibleSelectableKeys)
    );
  }, [activeSheetSelectionFollowsVisibleRows, updateActiveSheet, visibleSelectableKeys]);

  const scrollToColumn = useCallback(
    (path: string) => {
      const scrollContainer = sheetScrollRef.current;
      if (!scrollContainer || !visibleColumnPathSet.has(path)) {
        return;
      }

      const headerCells = Array.from(
        scrollContainer.querySelectorAll<HTMLTableCellElement>(
          'thead tr:first-child th[data-column-path]'
        )
      );
      const targetCell = headerCells.find((cell) => cell.dataset.columnPath === path);

      if (!targetCell) {
        return;
      }

      const targetSheetId = activeSheetId;
      updateSheet(targetSheetId, (current) => setHighlightedColumnInSheet(current, path));
      highlightedColumnSheetIdRef.current = targetSheetId;
      if (highlightedColumnTimeoutRef.current !== null) {
        window.clearTimeout(highlightedColumnTimeoutRef.current);
      }
      highlightedColumnTimeoutRef.current = window.setTimeout(() => {
        const highlightedSheetId = highlightedColumnSheetIdRef.current;
        if (highlightedSheetId) {
          updateSheet(highlightedSheetId, (current) =>
            setHighlightedColumnInSheet(
              current,
              current.highlightedColumnPath === path ? null : current.highlightedColumnPath
            )
          );
        }
        highlightedColumnTimeoutRef.current = null;
        highlightedColumnSheetIdRef.current = null;
      }, 2000);

      const stickyWidth = Array.from(pinnedColumnSet).reduce(
        (total, columnPath) => total + (effectiveColumnWidths[columnPath] ?? 0),
        SELECTOR_COLUMN_WIDTH
      );

      scrollContainer.scrollTo({
        left: Math.max(targetCell.offsetLeft - stickyWidth - 12, 0),
        behavior: "smooth",
      });
    },
    [
      activeSheetId,
      effectiveColumnWidths,
      highlightedColumnSheetIdRef,
      highlightedColumnTimeoutRef,
      pinnedColumnSet,
      sheetScrollRef,
      updateSheet,
      visibleColumnPathSet,
    ]
  );

  const toggleColumnVisibility = useCallback(
    (path: string) => {
      updateActiveSheet((current) => toggleColumnVisibilityInSheet(current, path));
    },
    [updateActiveSheet]
  );

  const togglePinnedColumn = useCallback(
    (path: string) => {
      updateActiveSheet((current) => togglePinnedColumnInSheet(current, path));
    },
    [updateActiveSheet]
  );

  const closeColumnMenu = useCallback(() => {
    updateActiveSheet((current) => setOpenColumnMenuInSheet(current, null));
  }, [updateActiveSheet]);

  const handleColumnMenuRef = useCallback(
    (path: string, element: HTMLDivElement | null) => {
      columnMenuRefs.current.set(path, element);
    },
    [columnMenuRefs]
  );

  const handleSheetScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      sheetScrollPositionsRef.current.set(activeSheetId, {
        left: event.currentTarget.scrollLeft,
        top: event.currentTarget.scrollTop,
      });
    },
    [activeSheetId, sheetScrollPositionsRef]
  );

  const toggleColumnMenu = useCallback(
    (path: string) => {
      updateActiveSheet((current) =>
        setOpenColumnMenuInSheet(current, current.openColumnMenuPath === path ? null : path)
      );
    },
    [updateActiveSheet]
  );

  useEffect(() => {
    const hasActiveTextSelection = () => {
      const selection = document.getSelection();
      return !!selection && selection.type === "Range" && selection.toString().trim().length > 0;
    };

    const isEditableNode = (node: EventTarget | null) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node.isContentEditable
      ) {
        return true;
      }

      return !!node.closest('input, textarea, [contenteditable="true"]');
    };

    const isEditableEventTarget = (event: Event) => {
      if (isEditableNode(event.target)) {
        return true;
      }

      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      return path.some((node) => isEditableNode(node));
    };

    const hasSelectedTextInFormControl = (target: EventTarget | null) => {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return (
          typeof target.selectionStart === "number" &&
          typeof target.selectionEnd === "number" &&
          target.selectionStart !== target.selectionEnd
        );
      }

      return false;
    };

    const isSafeGlobalShortcutContext = () => {
      const activeElement = document.activeElement;

      return (
        !activeElement ||
        activeElement === document.body ||
        activeElement === document.documentElement
      );
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const isDeleteKey = event.key === "Delete" || event.key === "Backspace";
      if (document.querySelector('.settings-modal[role="dialog"][aria-modal="true"]')) {
        if (isDeleteKey) {
          event.preventDefault();
        }
        return;
      }

      const activeElement = document.activeElement;
      const hasSelectedTextInActiveControl =
        activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
          ? typeof activeElement.selectionStart === "number" &&
            typeof activeElement.selectionEnd === "number" &&
            activeElement.selectionStart !== activeElement.selectionEnd
          : false;

      if (
        isEditableEventTarget(event) ||
        hasSelectedTextInFormControl(event.target) ||
        hasSelectedTextInActiveControl
      ) {
        return;
      }

      if (!isSafeGlobalShortcutContext()) {
        if (isDeleteKey) {
          event.preventDefault();
        }
        return;
      }

      const activeTag = activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if (hasActiveTextSelection()) {
        return;
      }

      if (isDeleteKey) {
        event.preventDefault();
        return;
      }

      if (selectedVisibleRowKeys.length === 0) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        if (selectedTrackingIds.length === 0) {
          return;
        }

        event.preventDefault();
        copySelectedTrackingIds();
      }
    };

    const handleCopy = (event: globalThis.ClipboardEvent) => {
      if (document.querySelector('.settings-modal[role="dialog"][aria-modal="true"]')) {
        return;
      }

      if (selectedVisibleRowKeys.length === 0) {
        return;
      }

      const activeElement = document.activeElement;
      const hasSelectedTextInActiveControl =
        activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
          ? typeof activeElement.selectionStart === "number" &&
            typeof activeElement.selectionEnd === "number" &&
            activeElement.selectionStart !== activeElement.selectionEnd
          : false;

      if (
        isEditableEventTarget(event) ||
        hasSelectedTextInFormControl(event.target) ||
        hasSelectedTextInActiveControl
      ) {
        return;
      }

      if (!isSafeGlobalShortcutContext()) {
        return;
      }

      const activeTag = activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if (hasActiveTextSelection()) {
        return;
      }

      if (selectedTrackingIds.length === 0) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData("text/plain", selectedTrackingIds.join("\n"));
    };

    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("copy", handleCopy);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("copy", handleCopy);
    };
  }, [copySelectedTrackingIds, selectedTrackingIds, selectedVisibleRowKeys.length]);

  return {
    closeColumnMenu,
    handleColumnMenuRef,
    handleSheetScroll,
    scrollToColumn,
    toggleColumnMenu,
    toggleColumnVisibility,
    togglePinnedColumn,
  };
}
