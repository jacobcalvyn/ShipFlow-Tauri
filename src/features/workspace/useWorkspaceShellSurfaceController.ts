import { Dispatch, SetStateAction } from "react";
import { useFrontendRuntimeLogging } from "../useFrontendRuntimeLogging";
import { useWorkspaceActionNoticeController } from "./useWorkspaceActionNoticeController";
import { useWorkspaceDocumentController } from "./useWorkspaceDocumentController";
import { useWorkspaceServiceSurfaceController } from "./useWorkspaceServiceSurfaceController";
import { useWorkspaceShellSettingsSurfaceController } from "./useWorkspaceShellSettingsSurfaceController";
import { WorkspaceState } from "./types";

type UseWorkspaceShellSurfaceControllerOptions = {
  workspaceState: WorkspaceState;
  setWorkspaceState: Dispatch<SetStateAction<WorkspaceState>>;
};

export function useWorkspaceShellSurfaceController({
  workspaceState,
  setWorkspaceState,
}: UseWorkspaceShellSurfaceControllerOptions) {
  const { actionNotices, showActionNotice } = useWorkspaceActionNoticeController();
  const document = useWorkspaceDocumentController({
    workspaceState,
    setWorkspaceState,
    showNotice: showActionNotice,
  });
  const service = useWorkspaceServiceSurfaceController({
    showNotice: showActionNotice,
  });
  const shellSettings = useWorkspaceShellSettingsSurfaceController({
    document,
    service,
  });

  useFrontendRuntimeLogging();

  return {
    actionNotices,
    showActionNotice,
    ...document,
    ...service,
    ...shellSettings,
  };
}
