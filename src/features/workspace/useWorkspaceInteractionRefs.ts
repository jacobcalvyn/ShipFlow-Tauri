import { Dispatch, MutableRefObject, SetStateAction, useRef, useState } from "react";

type ResizeState = {
  path: string;
  startX: number;
  startWidth: number;
} | null;

type UseWorkspaceInteractionRefsResult = {
  hoveredColumn: number | null;
  setHoveredColumn: Dispatch<SetStateAction<number | null>>;
  resizeStateRef: MutableRefObject<ResizeState>;
  columnMenuRefs: MutableRefObject<Map<string, HTMLDivElement | null>>;
  sheetScrollRef: MutableRefObject<HTMLDivElement | null>;
  sheetScrollPositionsRef: MutableRefObject<Map<string, { left: number; top: number }>>;
  highlightedColumnTimeoutRef: MutableRefObject<number | null>;
  highlightedColumnSheetIdRef: MutableRefObject<string | null>;
};

export function useWorkspaceInteractionRefs(): UseWorkspaceInteractionRefsResult {
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const resizeStateRef = useRef<ResizeState>(null);
  const columnMenuRefs = useRef(new Map<string, HTMLDivElement | null>());
  const sheetScrollRef = useRef<HTMLDivElement>(null);
  const sheetScrollPositionsRef = useRef(
    new Map<string, { left: number; top: number }>()
  );
  const highlightedColumnTimeoutRef = useRef<number | null>(null);
  const highlightedColumnSheetIdRef = useRef<string | null>(null);

  return {
    hoveredColumn,
    setHoveredColumn,
    resizeStateRef,
    columnMenuRefs,
    sheetScrollRef,
    sheetScrollPositionsRef,
    highlightedColumnTimeoutRef,
    highlightedColumnSheetIdRef,
  };
}
