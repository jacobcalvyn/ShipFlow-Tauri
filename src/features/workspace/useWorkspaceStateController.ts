import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SheetState } from "../sheet/types";
import { assertValidSheetState } from "../sheet/utils";
import {
  updateActiveSheetInWorkspace,
  updateSheetInWorkspace,
} from "./actions";
import { loadWorkspaceState } from "./persistence";
import { getActiveSheet, getWorkspaceTabs } from "./selectors";
import { WorkspaceState } from "./types";

function shouldAssertSheetState() {
  return import.meta.env.DEV || import.meta.env.MODE === "test";
}

type UseWorkspaceStateControllerResult = {
  workspaceState: WorkspaceState;
  setWorkspaceState: Dispatch<SetStateAction<WorkspaceState>>;
  activeSheet: SheetState;
  activeSheetId: string;
  workspaceTabs: ReturnType<typeof getWorkspaceTabs>;
  workspaceRef: MutableRefObject<WorkspaceState>;
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
  updateSheet: (sheetId: string, updater: (sheetState: SheetState) => SheetState) => void;
};

export function useWorkspaceStateController(): UseWorkspaceStateControllerResult {
  const [workspaceState, setWorkspaceState] = useState(loadWorkspaceState);
  const activeSheet = useMemo(() => getActiveSheet(workspaceState), [workspaceState]);
  const activeSheetId = workspaceState.activeSheetId;
  const workspaceTabs = useMemo(
    () => getWorkspaceTabs(workspaceState),
    [workspaceState]
  );
  const workspaceRef = useRef(workspaceState);

  const updateActiveSheet = useCallback(
    (updater: (sheetState: SheetState) => SheetState) => {
      setWorkspaceState((current) => {
        const nextWorkspace = updateActiveSheetInWorkspace(current, (sheetState) => {
          const nextSheetState = updater(sheetState);
          return shouldAssertSheetState()
            ? assertValidSheetState(nextSheetState)
            : nextSheetState;
        });
        workspaceRef.current = nextWorkspace;
        return nextWorkspace;
      });
    },
    []
  );

  const updateSheet = useCallback(
    (sheetId: string, updater: (sheetState: SheetState) => SheetState) => {
      setWorkspaceState((current) => {
        const nextWorkspace = updateSheetInWorkspace(current, sheetId, (sheetState) => {
          const nextSheetState = updater(sheetState);
          return shouldAssertSheetState()
            ? assertValidSheetState(nextSheetState)
            : nextSheetState;
        });
        workspaceRef.current = nextWorkspace;
        return nextWorkspace;
      });
    },
    []
  );

  useLayoutEffect(() => {
    workspaceRef.current = workspaceState;
  }, [workspaceState]);

  return {
    workspaceState,
    setWorkspaceState,
    activeSheet,
    activeSheetId,
    workspaceTabs,
    workspaceRef,
    updateActiveSheet,
    updateSheet,
  };
}
