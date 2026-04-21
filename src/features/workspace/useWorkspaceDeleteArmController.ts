import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { SheetState } from "../sheet/types";
import { armDeleteAllInSheet, disarmDeleteAllInSheet } from "../sheet/actions";

type UseWorkspaceDeleteArmControllerOptions = {
  activeSheetId: string;
  updateSheet: (sheetId: string, updater: (sheetState: SheetState) => SheetState) => void;
};

type UseWorkspaceDeleteArmControllerResult = {
  deleteAllTimeoutRef: MutableRefObject<number | null>;
  deleteAllArmedSheetIdRef: MutableRefObject<string | null>;
  deleteSelectedTimeoutRef: MutableRefObject<number | null>;
  deleteSelectedArmedSheetIdRef: MutableRefObject<string | null>;
  deleteSelectedArmedSheetId: string | null;
  setDeleteSelectedArmedSheetId: Dispatch<SetStateAction<string | null>>;
  armDeleteAll: () => void;
  disarmDeleteAll: () => void;
  armDeleteSelected: () => void;
  disarmDeleteSelected: () => void;
};

export function useWorkspaceDeleteArmController({
  activeSheetId,
  updateSheet,
}: UseWorkspaceDeleteArmControllerOptions): UseWorkspaceDeleteArmControllerResult {
  const deleteAllTimeoutRef = useRef<number | null>(null);
  const deleteAllArmedSheetIdRef = useRef<string | null>(null);
  const deleteSelectedTimeoutRef = useRef<number | null>(null);
  const deleteSelectedArmedSheetIdRef = useRef<string | null>(null);
  const [deleteSelectedArmedSheetId, setDeleteSelectedArmedSheetId] = useState<string | null>(
    null
  );

  useEffect(() => {
    return () => {
      if (deleteAllTimeoutRef.current !== null) {
        window.clearTimeout(deleteAllTimeoutRef.current);
      }
      if (deleteSelectedTimeoutRef.current !== null) {
        window.clearTimeout(deleteSelectedTimeoutRef.current);
      }
    };
  }, []);

  const armDeleteAll = useCallback(() => {
    const targetSheetId = activeSheetId;
    updateSheet(targetSheetId, (current) => armDeleteAllInSheet(current));
    deleteAllArmedSheetIdRef.current = targetSheetId;

    if (deleteAllTimeoutRef.current !== null) {
      window.clearTimeout(deleteAllTimeoutRef.current);
    }

    deleteAllTimeoutRef.current = window.setTimeout(() => {
      const armedSheetId = deleteAllArmedSheetIdRef.current;
      if (armedSheetId) {
        updateSheet(armedSheetId, (current) => disarmDeleteAllInSheet(current));
      }
      deleteAllTimeoutRef.current = null;
      deleteAllArmedSheetIdRef.current = null;
    }, 4000);
  }, [activeSheetId, updateSheet]);

  const disarmDeleteAll = useCallback(() => {
    const targetSheetId = deleteAllArmedSheetIdRef.current ?? activeSheetId;
    updateSheet(targetSheetId, (current) => disarmDeleteAllInSheet(current));
    if (deleteAllTimeoutRef.current !== null) {
      window.clearTimeout(deleteAllTimeoutRef.current);
      deleteAllTimeoutRef.current = null;
    }
    deleteAllArmedSheetIdRef.current = null;
  }, [activeSheetId, updateSheet]);

  const armDeleteSelected = useCallback(() => {
    const targetSheetId = activeSheetId;
    deleteSelectedArmedSheetIdRef.current = targetSheetId;
    setDeleteSelectedArmedSheetId(targetSheetId);

    if (deleteSelectedTimeoutRef.current !== null) {
      window.clearTimeout(deleteSelectedTimeoutRef.current);
    }

    deleteSelectedTimeoutRef.current = window.setTimeout(() => {
      deleteSelectedArmedSheetIdRef.current = null;
      setDeleteSelectedArmedSheetId(null);
      deleteSelectedTimeoutRef.current = null;
    }, 2000);
  }, [activeSheetId]);

  const disarmDeleteSelected = useCallback(() => {
    if (deleteSelectedTimeoutRef.current !== null) {
      window.clearTimeout(deleteSelectedTimeoutRef.current);
      deleteSelectedTimeoutRef.current = null;
    }
    deleteSelectedArmedSheetIdRef.current = null;
    setDeleteSelectedArmedSheetId(null);
  }, []);

  return {
    deleteAllTimeoutRef,
    deleteAllArmedSheetIdRef,
    deleteSelectedTimeoutRef,
    deleteSelectedArmedSheetIdRef,
    deleteSelectedArmedSheetId,
    setDeleteSelectedArmedSheetId,
    armDeleteAll,
    disarmDeleteAll,
    armDeleteSelected,
    disarmDeleteSelected,
  };
}
