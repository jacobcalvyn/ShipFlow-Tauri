import { TRACKING_COLUMN_PATH } from "./columns";

export function countActiveTextFilters(
  filters: Record<string, string>,
  visiblePaths?: Set<string>
) {
  return Object.entries(filters).filter(([path, value]) => {
    if (visiblePaths && !visiblePaths.has(path)) {
      return false;
    }

    return value.trim() !== "";
  }).length;
}

export function countActiveValueFilters(
  valueFilters: Record<string, string[]>,
  visiblePaths?: Set<string>
) {
  return Object.entries(valueFilters).filter(([path, values]) => {
    if (visiblePaths && !visiblePaths.has(path)) {
      return false;
    }

    return values.length > 0;
  }).length;
}

export function sanitizeTextFilters(
  filters: Record<string, string>,
  validPaths: Set<string>
) {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([path, value]) => validPaths.has(path) && value.trim() !== ""
    )
  );
}

export function sanitizeValueFilters(
  valueFilters: Record<string, string[]>,
  validPaths: Set<string>
) {
  return Object.fromEntries(
    Object.entries(valueFilters).flatMap(([path, values]) => {
      if (!validPaths.has(path)) {
        return [];
      }

      const normalizedValues = values.filter(
        (value, index, current) => value.trim() !== "" && current.indexOf(value) === index
      );

      if (normalizedValues.length === 0) {
        return [];
      }

      return [[path, normalizedValues] as const];
    })
  );
}

export function toggleColumnVisibilityState(
  hiddenColumnPaths: string[],
  path: string
) {
  if (path === TRACKING_COLUMN_PATH) {
    return hiddenColumnPaths;
  }

  return hiddenColumnPaths.includes(path)
    ? hiddenColumnPaths.filter((currentPath) => currentPath !== path)
    : [...hiddenColumnPaths, path];
}

export function togglePinnedColumnState(pinnedColumnPaths: string[], path: string) {
  return pinnedColumnPaths.includes(path)
    ? pinnedColumnPaths.filter((currentPath) => currentPath !== path)
    : [...pinnedColumnPaths, path];
}

export function toggleValueFilterSelection(
  valueFilters: Record<string, string[]>,
  path: string,
  value: string
) {
  const currentValues = valueFilters[path] ?? [];
  const nextValues = currentValues.includes(value)
    ? currentValues.filter((currentValue) => currentValue !== value)
    : [...currentValues, value];

  if (nextValues.length === 0) {
    const nextFilters = { ...valueFilters };
    delete nextFilters[path];
    return nextFilters;
  }

  return {
    ...valueFilters,
    [path]: nextValues,
  };
}
