const ENGINE_ROW_SELECTION_PREFIX = "engine:";

export function createEngineRowSelectionKey(rowId: string) {
  return `${ENGINE_ROW_SELECTION_PREFIX}${rowId}`;
}

export function getEngineRowIdFromSelectionKey(selectionKey: string) {
  if (!selectionKey.startsWith(ENGINE_ROW_SELECTION_PREFIX)) {
    return null;
  }

  const rowId = selectionKey.slice(ENGINE_ROW_SELECTION_PREFIX.length).trim();
  return rowId || null;
}
