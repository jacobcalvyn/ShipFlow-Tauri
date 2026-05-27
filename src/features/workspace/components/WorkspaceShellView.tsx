import { ComponentProps } from "react";
import { ActionNotice } from "../../useActionNotices";
import { ActionNoticeStack } from "../../components/ActionNoticeStack";
import { SheetActionBar } from "../../sheet/components/SheetActionBar";
import { SheetAnalyticsView } from "../../sheet/components/SheetAnalyticsView";
import { SheetModeSwitch } from "../../sheet/components/SheetModeSwitch";
import { SheetTable } from "../../sheet/components/SheetTable";
import { SheetViewMode } from "../../sheet/types";
import { SheetTabs } from "./SheetTabs";
import { WorkspaceDocumentDialogs } from "./WorkspaceDocumentDialogs";

type WorkspaceShellViewProps = {
  actionNotices: ActionNotice[];
  displayScale: "small" | "medium" | "large";
  activeSheetMode: SheetViewMode;
  sheetTabsProps: ComponentProps<typeof SheetTabs>;
  sheetModeSwitchProps: ComponentProps<typeof SheetModeSwitch>;
  sheetActionBarProps: ComponentProps<typeof SheetActionBar>;
  sheetAnalyticsViewProps: ComponentProps<typeof SheetAnalyticsView>;
  sheetTableProps: ComponentProps<typeof SheetTable>;
  documentDialogsProps: ComponentProps<typeof WorkspaceDocumentDialogs>;
};

export function WorkspaceShellView({
  actionNotices,
  displayScale,
  activeSheetMode,
  sheetTabsProps,
  sheetModeSwitchProps,
  sheetActionBarProps,
  sheetAnalyticsViewProps,
  sheetTableProps,
  documentDialogsProps,
}: WorkspaceShellViewProps) {
  return (
    <>
      <ActionNoticeStack notices={actionNotices} />
      <main className={`shell display-scale-${displayScale}`}>
        <SheetTabs {...sheetTabsProps} />
        <section className="sheet-panel">
          <SheetModeSwitch {...sheetModeSwitchProps} />
          {activeSheetMode === "workspace" ? (
            <>
              <SheetActionBar {...sheetActionBarProps} />
              <SheetTable {...sheetTableProps} />
            </>
          ) : (
            <SheetAnalyticsView {...sheetAnalyticsViewProps} />
          )}
        </section>
      </main>
      <WorkspaceDocumentDialogs {...documentDialogsProps} />
    </>
  );
}
