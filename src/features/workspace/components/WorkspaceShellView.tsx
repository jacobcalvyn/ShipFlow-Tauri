import { ComponentProps } from "react";
import { ActionNotice } from "../../useActionNotices";
import { ActionNoticeStack } from "../../components/ActionNoticeStack";
import { SheetActionBar } from "../../sheet/components/SheetActionBar";
import { SheetTable } from "../../sheet/components/SheetTable";
import { SheetTabs } from "./SheetTabs";
import { WorkspaceDocumentDialogs } from "./WorkspaceDocumentDialogs";

type WorkspaceShellViewProps = {
  actionNotices: ActionNotice[];
  displayScale: "small" | "medium" | "large";
  sheetTabsProps: ComponentProps<typeof SheetTabs>;
  sheetActionBarProps: ComponentProps<typeof SheetActionBar>;
  sheetTableProps: ComponentProps<typeof SheetTable>;
  documentDialogsProps: ComponentProps<typeof WorkspaceDocumentDialogs>;
};

export function WorkspaceShellView({
  actionNotices,
  displayScale,
  sheetTabsProps,
  sheetActionBarProps,
  sheetTableProps,
  documentDialogsProps,
}: WorkspaceShellViewProps) {
  return (
    <>
      <ActionNoticeStack notices={actionNotices} />
      <main className={`shell display-scale-${displayScale}`}>
        <SheetTabs {...sheetTabsProps} />
        <section className="sheet-panel">
          <SheetActionBar {...sheetActionBarProps} />
          <SheetTable {...sheetTableProps} />
        </section>
      </main>
      <WorkspaceDocumentDialogs {...documentDialogsProps} />
    </>
  );
}
