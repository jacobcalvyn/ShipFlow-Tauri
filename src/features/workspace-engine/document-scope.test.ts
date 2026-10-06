import { beforeEach, describe, expect, it, vi } from "vitest";
import { installShipFlowTestBridge } from "../../backend/bridge";
import { createTestBridge } from "../../test/bridge";
import { installTestBridge } from "../../test/bridge";
import { beginWorkspaceDocumentHandoff, captureWorkspaceDocumentScope, requestScopedWorkspace, replaceScopedWorkspace } from "./document-scope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const request = vi.fn();
beforeEach(() => { request.mockReset(); installTestBridge({ requestWorkspace: request }); });

describe("native document command scope", () => {
  it("blocks commands after native restore until the replacement UI commits", async () => {
    const finishHandoff = beginWorkspaceDocumentHandoff();
    request.mockResolvedValueOnce({ documentGeneration: 1 });
    await replaceScopedWorkspace({ command: "restore_workspace" });
    const beforeRender = captureWorkspaceDocumentScope();
    await expect(requestScopedWorkspace("workspace.command", { command: "clear_sheet_rows" })).rejects.toThrow("Dokumen berubah");
    finishHandoff(true);
    await expect(requestScopedWorkspace("workspace.command", {}, undefined, beforeRender)).rejects.toThrow("Dokumen berubah");
    await requestScopedWorkspace("workspace.command", { command: "list_sheets" });
    expect(request).toHaveBeenLastCalledWith("workspace.command", { command: "list_sheets", documentGeneration: 1 });
  });

  it("does not rebind displayed-document commands after a committed restore loses its response", async () => {
    let nativeGeneration = 0;
    let loseResponse = true;
    const bridge = createTestBridge();
    bridge.requestWorkspace = (async (method, params: { command?: string; documentGeneration?: number }) => {
      if (method === "workspace.document_generation") return { documentGeneration: nativeGeneration };
      if (params.documentGeneration !== nativeGeneration) throw new Error("Document changed");
      if (params.command === "restore_workspace") {
        nativeGeneration += 1;
        if (loseResponse) throw new Error("lost restore response");
      }
      return { documentGeneration: nativeGeneration };
    }) as typeof bridge.requestWorkspace;
    installShipFlowTestBridge(bridge);
    await expect(replaceScopedWorkspace({ command: "restore_workspace" })).rejects.toThrow("lost restore response");
    await expect(requestScopedWorkspace("workspace.command", { command: "clear_sheet_rows" })).rejects.toThrow("Document changed");
    loseResponse = false;
    await replaceScopedWorkspace({ command: "restore_workspace" });
    await expect(requestScopedWorkspace("workspace.command", { command: "list_sheets" })).resolves.toEqual({ documentGeneration: 2 });
  });

  it("keeps in-flight scopes valid during seed-only startup", async () => {
    const { restoreWorkspace } = await import("./client");
    const scope = captureWorkspaceDocumentScope();
    request.mockResolvedValueOnce({ type: "sheets", payload: [], documentGeneration: 0 });
    await restoreWorkspace({ sheets: [], seedOnly: true });
    await requestScopedWorkspace("workspace.command", { command: "list_sheets" }, undefined, scope);
    expect(request).toHaveBeenLastCalledWith("workspace.command", { command: "list_sheets", documentGeneration: 0 });
  });

  it("rejects commands captured before or during replacement and accepts the committed generation", async () => {
    const oldScope = captureWorkspaceDocumentScope();
    const restore = deferred<{ documentGeneration: number }>();
    request.mockReturnValueOnce(restore.promise);
    const replacing = replaceScopedWorkspace({ command: "restore_workspace", payload: {} });
    const duringRestore = captureWorkspaceDocumentScope();
    await expect(requestScopedWorkspace("workspace.command", { command: "clear_sheet_rows" }, undefined, oldScope)).rejects.toThrow("Dokumen berubah");
    await expect(requestScopedWorkspace("workspace.command", { command: "clear_sheet_rows" }, undefined, duringRestore)).rejects.toThrow("Dokumen berubah");
    restore.resolve({ documentGeneration: 1 });
    await replacing;
    await expect(requestScopedWorkspace("workspace.command", { command: "clear_sheet_rows" }, undefined, oldScope)).rejects.toThrow("Dokumen berubah");
    await requestScopedWorkspace("workspace.command", { command: "list_sheets" });
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["workspace.command", { command: "restore_workspace", payload: {}, documentGeneration: 0 }],
      ["workspace.command", { command: "list_sheets", documentGeneration: 1 }],
    ]);
  });

  it("discards delayed responses and progress from the old document", async () => {
    const response = deferred<unknown>();
    request.mockReturnValueOnce(response.promise);
    const onEvent = vi.fn();
    const query = requestScopedWorkspace("workspace.refresh_tracking_with_progress", { sheetId: "default-sheet" }, onEvent);
    const rejection = expect(query).rejects.toThrow("Dokumen berubah");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const emit = request.mock.calls[0][2];
    emit({ type: "before" });
    request.mockResolvedValueOnce({ documentGeneration: 1 });
    await replaceScopedWorkspace({ command: "restore_workspace" });
    emit({ type: "after" });
    response.resolve({ rows: ["old document"] });
    await rejection;
    expect(onEvent.mock.calls).toEqual([[{ type: "before" }]]);
  });

  it("fences later pages using the original generation", async () => {
    const scope = captureWorkspaceDocumentScope();
    request.mockResolvedValueOnce({ rows: ["page one"] });
    await requestScopedWorkspace("workspace.command", { command: "query_sheet_rows", offset: 0 }, undefined, scope);
    request.mockResolvedValueOnce({ documentGeneration: 1 });
    await replaceScopedWorkspace({ command: "restore_workspace" });
    await expect(requestScopedWorkspace("workspace.command", { command: "query_sheet_rows", offset: 1000 }, undefined, scope)).rejects.toThrow("Dokumen berubah");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("allows a new command after a failed restore while invalidating old captures", async () => {
    const oldScope = captureWorkspaceDocumentScope();
    request.mockRejectedValueOnce(new Error("invalid document"));
    await expect(replaceScopedWorkspace({ command: "restore_workspace" })).rejects.toThrow("invalid document");
    await expect(requestScopedWorkspace("workspace.command", {}, undefined, oldScope)).rejects.toThrow("Dokumen berubah");
    await requestScopedWorkspace("workspace.command", { command: "list_sheets" });
    expect(request).toHaveBeenLastCalledWith("workspace.command", { command: "list_sheets", documentGeneration: 0 });
  });
});
