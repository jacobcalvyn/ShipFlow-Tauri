import { WorkspaceShellView } from "./components/WorkspaceShellView";
import { useWorkspaceAppController } from "./useWorkspaceAppController";

export function WorkspaceApp() {
  const workspaceShellViewProps = useWorkspaceAppController();

  return <WorkspaceShellView {...workspaceShellViewProps} />;
}
