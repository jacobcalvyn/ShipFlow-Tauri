import {
  ClipboardEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  COLUMNS,
  FILTER_PRESETS_STORAGE_KEY,
  HIDDEN_COLUMNS_STORAGE_KEY,
  INITIAL_ROW_COUNT,
  MAX_CONCURRENT_BULK_REQUESTS,
  PINNED_COLUMNS_STORAGE_KEY,
  SELECTOR_COLUMN_WIDTH,
  TRACKING_COLUMN_PATH,
} from "./features/sheet/columns";
import { SheetActionBar } from "./features/sheet/components/SheetActionBar";
import { SheetTable } from "./features/sheet/components/SheetTable";
import {
  FilterPreset,
  SheetRow,
  SortState,
  TrackResponse,
} from "./features/sheet/types";
import {
  buildCsvValue,
  compareRows,
  createEmptyRows,
  ensureRowCapacity,
  ensureTrailingEmptyRows,
  getEffectiveColumnWidth,
  formatColumnValue,
  getColumnValueOptions,
  getInitialColumnWidths,
  isBrowserReady,
  loadStoredFilterPresets,
  loadStoredStringArray,
} from "./features/sheet/utils";
import {
  applyPresetToHiddenColumns,
  buildFilterPreset,
  countActiveTextFilters,
  countActiveValueFilters,
  sanitizeTextFilters,
  sanitizeValueFilters,
  toggleColumnVisibilityState,
  togglePinnedColumnState,
  toggleValueFilterSelection,
} from "./features/sheet/state";

function App() {
  const [rows, setRows] = useState<SheetRow[]>(() =>
    createEmptyRows(INITIAL_ROW_COUNT)
  );
  const [serverUrl, setServerUrl] = useState("");
  const [serverError, setServerError] = useState("");
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [valueFilters, setValueFilters] = useState<Record<string, string[]>>({});
  const [sortState, setSortState] = useState<SortState>({
    path: null,
    direction: "asc",
  });
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    getInitialColumnWidths
  );
  const [hiddenColumnPaths, setHiddenColumnPaths] = useState<string[]>(() =>
    loadStoredStringArray(HIDDEN_COLUMNS_STORAGE_KEY, [])
  );
  const [pinnedColumnPaths, setPinnedColumnPaths] = useState<string[]>(() =>
    loadStoredStringArray(
      PINNED_COLUMNS_STORAGE_KEY,
      COLUMNS.filter((column) => column.sticky).map((column) => column.path)
    )
  );
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(
    loadStoredFilterPresets
  );
  const [presetNameInput, setPresetNameInput] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [openColumnMenuPath, setOpenColumnMenuPath] = useState<string | null>(
    null
  );
  const resizeStateRef = useRef<{
    path: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const requestControllersRef = useRef(new Map<string, AbortController>());
  const columnMenuRefs = useRef(new Map<string, HTMLDivElement | null>());
  const rowsRef = useRef(rows);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    let isActive = true;

    invoke<string>("get_tracking_server_url")
      .then((url) => {
        if (isActive) {
          setServerUrl(url);
        }
      })
      .catch((error) => {
        if (isActive) {
          setServerError(
            error instanceof Error
              ? error.message
              : "Tracking server could not be started."
          );
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!openColumnMenuPath) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const activeMenu = columnMenuRefs.current.get(openColumnMenuPath);
      if (!activeMenu || !(event.target instanceof Node)) {
        return;
      }

      if (!activeMenu.contains(event.target)) {
        setOpenColumnMenuPath(null);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [openColumnMenuPath]);

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
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      FILTER_PRESETS_STORAGE_KEY,
      JSON.stringify(filterPresets)
    );
  }, [filterPresets]);

  useEffect(() => {
    return () => {
      requestControllersRef.current.forEach((controller) => controller.abort());
      requestControllersRef.current.clear();
    };
  }, []);

  const loadedCount = useMemo(
    () => rows.filter((row) => row.shipment !== null).length,
    [rows]
  );

  const visibleColumns = useMemo(() => {
    const hidden = new Set(hiddenColumnPaths);
    const orderedVisibleColumns = COLUMNS.filter((column) => !hidden.has(column.path));
    const pinnedColumns = pinnedColumnPaths
      .map((path) =>
        orderedVisibleColumns.find((column) => column.path === path) ?? null
      )
      .filter((column): column is (typeof COLUMNS)[number] => column !== null);
    const pinnedPaths = new Set(pinnedColumns.map((column) => column.path));

    return [
      ...pinnedColumns,
      ...orderedVisibleColumns.filter((column) => !pinnedPaths.has(column.path)),
    ];
  }, [hiddenColumnPaths, pinnedColumnPaths]);

  const visibleColumnPathSet = useMemo(
    () => new Set(visibleColumns.map((column) => column.path)),
    [visibleColumns]
  );

  const pinnedColumnSet = useMemo(
    () => new Set(pinnedColumnPaths),
    [pinnedColumnPaths]
  );

  const effectiveColumnWidths = useMemo(
    () =>
      Object.fromEntries(
        visibleColumns.map((column) => [
          column.path,
          getEffectiveColumnWidth(column, columnWidths),
        ])
      ),
    [columnWidths, visibleColumns]
  );

  const pinnedLeftMap = useMemo(() => {
    let currentLeft = SELECTOR_COLUMN_WIDTH;
    const nextMap: Record<string, number> = {};

    visibleColumns.forEach((column) => {
      if (!pinnedColumnSet.has(column.path)) {
        return;
      }

      nextMap[column.path] = currentLeft;
      currentLeft += effectiveColumnWidths[column.path];
    });

    return nextMap;
  }, [effectiveColumnWidths, pinnedColumnSet, visibleColumns]);

  const activeFilterCount = useMemo(
    () =>
      countActiveTextFilters(filters, visibleColumnPathSet) +
      countActiveValueFilters(valueFilters, visibleColumnPathSet),
    [filters, valueFilters, visibleColumnPathSet]
  );

  const ignoredHiddenFilterCount = useMemo(
    () =>
      countActiveTextFilters(filters) +
      countActiveValueFilters(valueFilters) -
      activeFilterCount,
    [activeFilterCount, filters, valueFilters]
  );

  const valueOptionsByPath = useMemo(
    () =>
      Object.fromEntries(
        visibleColumns.map((column) => [column.path, getColumnValueOptions(rows, column)])
      ),
    [rows, visibleColumns]
  );

  const displayedRows = useMemo(() => {
    const hasActiveFilters = activeFilterCount > 0;
    const hasSort = sortState.path !== null;

    if (!hasActiveFilters && !hasSort) {
      return rows;
    }

    let workingRows = rows.filter((row) => {
      if (!row.shipment && row.trackingInput.trim() === "") {
        return false;
      }

      return visibleColumns.every((column) => {
        const filterValue = filters[column.path]?.trim().toLowerCase();
        const cellValue = formatColumnValue(row, column).toLowerCase();
        const selectedValues = valueFilters[column.path] ?? [];

        if (filterValue && !cellValue.includes(filterValue)) {
          return false;
        }

        if (selectedValues.length > 0) {
          return selectedValues.includes(formatColumnValue(row, column));
        }

        return true;
      });
    });

    if (sortState.path) {
      const sortColumn = COLUMNS.find((column) => column.path === sortState.path);

      if (sortColumn) {
        workingRows = [...workingRows].sort((left, right) =>
          compareRows(left, right, sortColumn, sortState.direction)
        );
      }
    }

    const draftRows = rows
      .filter((row) => row.shipment === null && row.trackingInput.trim() === "")
      .slice(0, 5);

    return [...workingRows, ...draftRows];
  }, [activeFilterCount, filters, rows, sortState, valueFilters, visibleColumns]);

  const visibleSelectableKeys = useMemo(
    () =>
      displayedRows
        .filter((row) => row.trackingInput.trim() !== "" || row.shipment !== null)
        .map((row) => row.key),
    [displayedRows]
  );

  const allVisibleSelected =
    visibleSelectableKeys.length > 0 &&
    visibleSelectableKeys.every((key) => selectedRowKeys.includes(key));

  const selectedTrackingIds = useMemo(
    () =>
      rows
        .filter((row) => selectedRowKeys.includes(row.key))
        .map((row) => row.trackingInput.trim())
        .filter(Boolean),
    [rows, selectedRowKeys]
  );

  const selectedRowKeySet = useMemo(
    () => new Set(selectedRowKeys),
    [selectedRowKeys]
  );

  const exportableRows = useMemo(() => {
    if (selectedRowKeys.length > 0) {
      return rows.filter(
        (row) =>
          selectedRowKeys.includes(row.key) &&
          (row.trackingInput.trim() !== "" || row.shipment !== null)
      );
    }

    return displayedRows.filter(
      (row) => row.trackingInput.trim() !== "" || row.shipment !== null
    );
  }, [displayedRows, rows, selectedRowKeys]);

  const hiddenColumns = useMemo(
    () => COLUMNS.filter((column) => hiddenColumnPaths.includes(column.path)),
    [hiddenColumnPaths]
  );

  const handleTrackingInputChange = useCallback((rowKey: string, value: string) => {
    requestControllersRef.current.get(rowKey)?.abort();

    setRows((current) =>
      ensureTrailingEmptyRows(
        current.map((row) =>
          row.key === rowKey
            ? {
                ...row,
                trackingInput: value,
                shipment:
                  value.trim() === row.trackingInput.trim() ? row.shipment : null,
                loading: false,
                error: value.trim() === row.trackingInput.trim() ? row.error : "",
              }
            : row
        )
      )
    );
  }, []);

  const fetchShipmentIntoRow = useCallback(
    async (rowKey: string, shipmentId: string) => {
      const normalizedId = shipmentId.trim();
      requestControllersRef.current.get(rowKey)?.abort();

      if (!normalizedId) {
        requestControllersRef.current.delete(rowKey);
        setRows((current) =>
          current.map((row) =>
            row.key === rowKey
              ? {
                  ...row,
                  shipment: null,
                  loading: false,
                  error: "",
                }
              : row
          )
        );
        return;
      }

      if (!serverUrl) {
        requestControllersRef.current.delete(rowKey);
        setRows((current) =>
          current.map((row) =>
            row.key === rowKey
              ? {
                  ...row,
                  shipment: null,
                  loading: false,
                  error: serverError || "Tracking server is not ready yet.",
                }
              : row
          )
        );
        return;
      }

      const controller = new AbortController();
      requestControllersRef.current.set(rowKey, controller);

      setRows((current) =>
        current.map((row) =>
          row.key === rowKey
            ? {
                ...row,
                trackingInput: normalizedId,
                loading: true,
                error: "",
              }
            : row
        )
      );

      try {
        const response = await fetch(
          `${serverUrl}/track/${encodeURIComponent(normalizedId)}`,
          {
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;

          throw new Error(payload?.error ?? "Tracking request failed.");
        }

        const result = (await response.json()) as TrackResponse;

        if (requestControllersRef.current.get(rowKey) !== controller) {
          return;
        }

        setRows((current) =>
          ensureTrailingEmptyRows(
            current.map((row) =>
              row.key === rowKey
                ? {
                    ...row,
                    trackingInput:
                      result.detail.shipment_header.nomor_kiriman ?? normalizedId,
                    shipment: result,
                    loading: false,
                    error: "",
                  }
                : row
            )
          )
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (requestControllersRef.current.get(rowKey) !== controller) {
          return;
        }

        setRows((current) =>
          current.map((row) =>
            row.key === rowKey
              ? {
                  ...row,
                  shipment: null,
                  loading: false,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Tracking request failed.",
                }
              : row
          )
        );
      } finally {
        if (requestControllersRef.current.get(rowKey) === controller) {
          requestControllersRef.current.delete(rowKey);
        }
      }
    },
    [serverError, serverUrl]
  );

  const fetchRow = useCallback(
    async (rowKey: string) => {
      const targetRow = rowsRef.current.find((row) => row.key === rowKey);
      if (!targetRow) {
        return;
      }

      const shipmentId = targetRow.trackingInput.trim();
      if (!shipmentId) {
        return;
      }

      await fetchShipmentIntoRow(rowKey, shipmentId);
    },
    [fetchShipmentIntoRow]
  );

  const handleTrackingInputBlur = useCallback(
    (rowKey: string) => {
      void fetchRow(rowKey);
    },
    [fetchRow]
  );

  const handleTrackingInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, rowKey: string) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void fetchRow(rowKey);
        (event.currentTarget as HTMLInputElement).blur();
      }
    },
    [fetchRow]
  );

  const runBulkPasteFetches = useCallback(
    async (entries: Array<{ key: string; value: string }>) => {
      const queue = [...entries];
      const workerCount = Math.min(MAX_CONCURRENT_BULK_REQUESTS, queue.length);

      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) {
            return;
          }

          await fetchShipmentIntoRow(next.key, next.value);
        }
      });

      await Promise.allSettled(workers);
    },
    [fetchShipmentIntoRow]
  );

  const handleTrackingInputPaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement>, rowKey: string) => {
      const values = event.clipboardData
        .getData("text")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);

      if (values.length <= 1) {
        return;
      }

      event.preventDefault();

      const startIndex = rowsRef.current.findIndex((row) => row.key === rowKey);
      if (startIndex === -1) {
        return;
      }

      const requiredLength = startIndex + values.length;
      const expandedRows = ensureRowCapacity([...rowsRef.current], requiredLength);
      const targetKeys: string[] = [];

      for (let offset = 0; offset < values.length; offset += 1) {
        const row = expandedRows[startIndex + offset];
        targetKeys.push(row.key);
        expandedRows[startIndex + offset] = {
          ...row,
          trackingInput: values[offset],
          shipment: null,
          loading: false,
          error: "",
        };
      }

      setRows(ensureTrailingEmptyRows(expandedRows));
      setSelectedRowKeys((current) =>
        Array.from(new Set([...current, ...targetKeys]))
      );

      void runBulkPasteFetches(
        targetKeys.map((key, index) => ({ key, value: values[index] }))
      );
    },
    [runBulkPasteFetches]
  );

  const handleFilterChange = useCallback((path: string, value: string) => {
    setFilters((current) => ({
      ...current,
      [path]: value,
    }));
  }, []);

  const toggleColumnValueFilter = useCallback((path: string, value: string) => {
    setValueFilters((current) => toggleValueFilterSelection(current, path, value));
  }, []);

  const clearColumnValueFilter = useCallback((path: string) => {
    setValueFilters((current) => {
      if (!(path in current)) {
        return current;
      }

      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  const setColumnSort = useCallback(
    (path: string, direction: "asc" | "desc" | null) => {
      setSortState({
        path: direction ? path : null,
        direction: direction ?? "asc",
      });
    },
    []
  );

  const getSortLabel = useCallback(
    (path: string) => {
      if (sortState.path !== path) {
        return "↕";
      }

      return sortState.direction === "asc" ? "↑" : "↓";
    },
    [sortState]
  );

  const getColumnSortDirection = useCallback(
    (path: string) => (sortState.path === path ? sortState.direction : null),
    [sortState]
  );

  const toggleRowSelection = useCallback((rowKey: string) => {
    setSelectedRowKeys((current) =>
      current.includes(rowKey)
        ? current.filter((key) => key !== rowKey)
        : [...current, rowKey]
    );
  }, []);

  const toggleVisibleSelection = useCallback(() => {
    setSelectedRowKeys((current) => {
      if (allVisibleSelected) {
        return current.filter((key) => !visibleSelectableKeys.includes(key));
      }

      const next = new Set(current);
      visibleSelectableKeys.forEach((key) => next.add(key));
      return Array.from(next);
    });
  }, [allVisibleSelected, visibleSelectableKeys]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLSpanElement>, column: (typeof COLUMNS)[number]) => {
      event.preventDefault();
      event.stopPropagation();

      resizeStateRef.current = {
        path: column.path,
        startX: event.clientX,
        startWidth: columnWidths[column.path],
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

        setColumnWidths((current) =>
          current[activeResize.path] === nextWidth
            ? current
            : {
                ...current,
                [activeResize.path]: nextWidth,
              }
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
    [columnWidths]
  );

  const copySelectedTrackingIds = useCallback(() => {
    if (selectedTrackingIds.length === 0) {
      return;
    }

    void navigator.clipboard.writeText(selectedTrackingIds.join("\n")).catch(() => {
      /* no-op */
    });
  }, [selectedTrackingIds]);

  const clearSelection = useCallback(() => {
    setSelectedRowKeys([]);
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilters({});
    setValueFilters({});
    setSelectedPresetId("");
  }, []);

  const clearHiddenFilters = useCallback(() => {
    setFilters((current) =>
      sanitizeTextFilters(current, visibleColumnPathSet)
    );
    setValueFilters((current) => sanitizeValueFilters(current, visibleColumnPathSet));
  }, [visibleColumnPathSet]);

  const deleteSelectedRows = useCallback(() => {
    if (selectedRowKeys.length === 0) {
      return;
    }

    selectedRowKeys.forEach((rowKey) => {
      requestControllersRef.current.get(rowKey)?.abort();
      requestControllersRef.current.delete(rowKey);
    });

    setRows((current) =>
      ensureTrailingEmptyRows(
        current.map((row) =>
          selectedRowKeys.includes(row.key)
            ? {
                ...row,
                trackingInput: "",
                shipment: null,
                loading: false,
                error: "",
              }
            : row
        )
      )
    );
    setSelectedRowKeys([]);
  }, [selectedRowKeys]);

  const exportCsv = useCallback(() => {
    if (exportableRows.length === 0) {
      return;
    }

    const header = visibleColumns.map((column) => buildCsvValue(column.label));
    const lines = exportableRows.map((row) =>
      visibleColumns
        .map((column) => buildCsvValue(formatColumnValue(row, column)))
        .join(",")
    );

    const csvContent = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateSuffix = new Date().toISOString().slice(0, 10);

    link.href = objectUrl;
    link.download =
      selectedRowKeys.length > 0
        ? `shipflow-selected-${dateSuffix}.csv`
        : `shipflow-view-${dateSuffix}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }, [exportableRows, selectedRowKeys.length, visibleColumns]);

  const toggleColumnVisibility = useCallback(
    (path: string) => {
      if (path === TRACKING_COLUMN_PATH) {
        return;
      }

      if (!hiddenColumnPaths.includes(path)) {
        setFilters((current) => {
          if (!current[path]) {
            return current;
          }

          const next = { ...current };
          delete next[path];
          return next;
        });
        setValueFilters((current) => {
          if (!(path in current)) {
            return current;
          }

          const next = { ...current };
          delete next[path];
          return next;
        });

        setSortState((current) =>
          current.path === path ? { path: null, direction: "asc" } : current
        );
      }

      setHiddenColumnPaths((current) => toggleColumnVisibilityState(current, path));
    },
    [hiddenColumnPaths]
  );

  const togglePinnedColumn = useCallback((path: string) => {
    setPinnedColumnPaths((current) => togglePinnedColumnState(current, path));
  }, []);

  const saveCurrentFilterPreset = useCallback(() => {
    const nextPreset = buildFilterPreset(
      presetNameInput,
      filters,
      valueFilters,
      visibleColumnPathSet,
      () => crypto.randomUUID()
    );

    if (!nextPreset) {
      return;
    }

    setFilterPresets((current) => [...current, nextPreset]);
    setSelectedPresetId(nextPreset.id);
    setPresetNameInput("");
  }, [filters, presetNameInput, valueFilters, visibleColumnPathSet]);

  const applySelectedPreset = useCallback(() => {
    if (!selectedPresetId) {
      return;
    }

    const targetPreset = filterPresets.find(
      (preset) => preset.id === selectedPresetId
    );

    if (!targetPreset) {
      return;
    }

    setHiddenColumnPaths((current) => applyPresetToHiddenColumns(current, targetPreset));
    setFilters(targetPreset.textFilters);
    setValueFilters(targetPreset.valueFilters);
  }, [filterPresets, selectedPresetId]);

  const deleteSelectedPreset = useCallback(() => {
    if (!selectedPresetId) {
      return;
    }

    setFilterPresets((current) =>
      current.filter((preset) => preset.id !== selectedPresetId)
    );
    setSelectedPresetId("");
  }, [selectedPresetId]);

  const closeColumnMenu = useCallback(() => {
    setOpenColumnMenuPath(null);
  }, []);

  const handleColumnMenuRef = useCallback(
    (path: string, element: HTMLDivElement | null) => {
      columnMenuRefs.current.set(path, element);
    },
    []
  );

  const toggleColumnMenu = useCallback((path: string) => {
    setOpenColumnMenuPath((current) => (current === path ? null : path));
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (selectedRowKeys.length === 0) {
        return;
      }

      const activeTag = document.activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        if (selectedTrackingIds.length === 0) {
          return;
        }

        event.preventDefault();
        copySelectedTrackingIds();
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedRows();
      }
    };

    const handleCopy = (event: globalThis.ClipboardEvent) => {
      if (selectedRowKeys.length === 0) {
        return;
      }

      const activeTag = document.activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if (selectedTrackingIds.length === 0) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData("text/plain", selectedTrackingIds.join("\n"));
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("copy", handleCopy);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("copy", handleCopy);
    };
  }, [copySelectedTrackingIds, deleteSelectedRows, selectedRowKeys, selectedTrackingIds]);

  return (
    <main className="shell">
      {serverError ? <section className="error-box">{serverError}</section> : null}

      <section className="sheet-panel">
        <SheetActionBar
          loadedCount={loadedCount}
          exportableRowsCount={exportableRows.length}
          presetNameInput={presetNameInput}
          activeFilterCount={activeFilterCount}
          selectedPresetId={selectedPresetId}
          filterPresets={filterPresets}
          selectedRowCount={selectedRowKeys.length}
          ignoredHiddenFilterCount={ignoredHiddenFilterCount}
          sortLabel={sortState.path ? getSortLabel(sortState.path) : "Off"}
          onPresetNameInputChange={setPresetNameInput}
          onSelectedPresetChange={setSelectedPresetId}
          onExportCsv={exportCsv}
          onSavePreset={saveCurrentFilterPreset}
          onApplyPreset={applySelectedPreset}
          onDeletePreset={deleteSelectedPreset}
          onClearSelection={clearSelection}
          onClearFilter={clearAllFilters}
          onCopySelectedIds={copySelectedTrackingIds}
          onDeleteSelectedRows={deleteSelectedRows}
          onClearHiddenFilters={clearHiddenFilters}
        />

        <SheetTable
          displayedRows={displayedRows}
          visibleColumns={visibleColumns}
          hiddenColumns={hiddenColumns}
          columnWidths={effectiveColumnWidths}
          pinnedColumnSet={pinnedColumnSet}
          pinnedLeftMap={pinnedLeftMap}
          hoveredColumn={hoveredColumn}
          allVisibleSelected={allVisibleSelected}
          selectedRowKeySet={selectedRowKeySet}
          filters={filters}
          valueFilters={valueFilters}
          valueOptionsByPath={valueOptionsByPath}
          openColumnMenuPath={openColumnMenuPath}
          sortDirectionForPath={getColumnSortDirection}
          onMouseLeaveTable={() => setHoveredColumn(null)}
          onHoverColumn={setHoveredColumn}
          onToggleVisibleSelection={toggleVisibleSelection}
          onToggleRowSelection={toggleRowSelection}
          onTrackingInputChange={handleTrackingInputChange}
          onTrackingInputBlur={handleTrackingInputBlur}
          onTrackingInputKeyDown={handleTrackingInputKeyDown}
          onTrackingInputPaste={handleTrackingInputPaste}
          onFilterChange={handleFilterChange}
          onResizeStart={handleResizeStart}
          onToggleColumnMenu={toggleColumnMenu}
          onSetColumnSort={setColumnSort}
          onTogglePinnedColumn={togglePinnedColumn}
          onToggleColumnVisibility={toggleColumnVisibility}
          onToggleValueFilter={toggleColumnValueFilter}
          onClearValueFilter={clearColumnValueFilter}
          onCloseColumnMenu={closeColumnMenu}
          onColumnMenuRef={handleColumnMenuRef}
        />
      </section>
    </main>
  );
}

export default App;
