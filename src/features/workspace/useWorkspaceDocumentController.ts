import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createDefaultWorkspaceState } from "./default-state";
import {
  createDefaultWorkspaceDocumentMeta,
  createWorkspaceDocumentFile,
  getWorkspaceDocumentName,
  WorkspaceDocumentFile,
  WorkspaceDocumentMeta,
} from "./document";
import {
  buildWorkspaceWindowTitle,
  loadDocumentAutosaveEnabled,
  loadRecentWorkspaceDocuments,
  loadWorkspaceDocumentMeta,
  loadWorkspaceState,
  normalizePersistedWorkspaceState,
  persistDocumentAutosaveEnabled,
  persistRecentWorkspaceDocuments,
  persistWorkspaceDocumentMeta,
  persistWorkspaceStateSnapshot,
  pushRecentWorkspaceDocument,
  serializeWorkspaceStateForDocument,
} from "./persistence";
import { WorkspaceState } from "./types";

type WorkspaceDocumentDialogMode = "open" | "saveAs";

type WorkspaceDocumentReadResult = {
  path: string;
  document: WorkspaceDocumentFile;
};

type WorkspaceDocumentWriteResult = {
  path: string;
  savedAt: string;
};

type WorkspaceWindowLaunchRequest = {
  documentPath: string | null;
  startFresh: boolean;
};

type WorkspaceDocumentClaimResult = {
  status: "claimed" | "alreadyOpen";
  path: string | null;
  ownerLabel: string | null;
};

type WindowCloseRequestPayload = {
  documentName: string;
};

export type WorkspaceDocumentControllerNotice = {
  tone: "success" | "error" | "info";
  message: string;
};

type UseWorkspaceDocumentControllerOptions = {
  workspaceState: WorkspaceState;
  setWorkspaceState: Dispatch<SetStateAction<WorkspaceState>>;
  showNotice: (notice: WorkspaceDocumentControllerNotice) => void;
};

async function pickWorkspaceDocumentPath(
  mode: "open" | "save",
  suggestedName?: string
) {
  return Promise.resolve(
    invoke<string | null>("pick_workspace_document_path", {
      mode,
      suggestedName,
    })
  );
}

export function useWorkspaceDocumentController({
  workspaceState,
  setWorkspaceState,
  showNotice,
}: UseWorkspaceDocumentControllerOptions) {
  const [documentMeta, setDocumentMeta] = useState<WorkspaceDocumentMeta>(
    () => loadWorkspaceDocumentMeta()
  );
  const [windowStorageScope, setWindowStorageScope] = useState<string | null>("main");
  const [recentWorkspaceDocuments, setRecentWorkspaceDocuments] = useState<string[]>(
    loadRecentWorkspaceDocuments
  );
  const [autosaveEnabled, setAutosaveEnabled] = useState(loadDocumentAutosaveEnabled);
  const [pendingWindowCloseRequest, setPendingWindowCloseRequest] =
    useState<WindowCloseRequestPayload | null>(null);
  const [isResolvingWindowClose, setIsResolvingWindowClose] = useState(false);
  const [documentDialogMode, setDocumentDialogMode] =
    useState<WorkspaceDocumentDialogMode | null>(null);
  const [documentPathDraft, setDocumentPathDraft] = useState("");
  const workspaceRef = useRef(workspaceState);
  const documentMetaRef = useRef(documentMeta);
  const documentBaselineRef = useRef<string>("__unset__");
  const documentSaveInFlightRef = useRef(false);
  const documentAutosaveTimeoutRef = useRef<number | null>(null);
  const canUseAutosave = documentMeta.path !== null;
  const isAutosaveActive = canUseAutosave && autosaveEnabled;
  const recentDocumentItems = useMemo(
    () =>
      recentWorkspaceDocuments.map((path) => ({
        path,
        name: getWorkspaceDocumentName(path),
      })),
    [recentWorkspaceDocuments]
  );

  if (documentBaselineRef.current === "__unset__") {
    documentBaselineRef.current = serializeWorkspaceStateForDocument(workspaceState);
  }

  useEffect(() => {
    workspaceRef.current = workspaceState;
  }, [workspaceState]);

  useEffect(() => {
    documentMetaRef.current = documentMeta;
  }, [documentMeta]);

  useEffect(() => {
    void Promise.resolve(invoke<string>("get_current_window_label"))
      .then((label) => {
        setWindowStorageScope(label);

        if (label !== "main") {
          const scopedWorkspace = loadWorkspaceState(label);
          const scopedDocumentMeta = loadWorkspaceDocumentMeta(label);
          documentBaselineRef.current = serializeWorkspaceStateForDocument(scopedWorkspace);
          setWorkspaceState(scopedWorkspace);
          setDocumentMeta(scopedDocumentMeta);
        }
      })
      .catch(() => {
        setWindowStorageScope("main");
      });
  }, [setWorkspaceState]);

  useEffect(() => {
    const serializedWorkspace = serializeWorkspaceStateForDocument(workspaceState);
    const isDirty = serializedWorkspace !== documentBaselineRef.current;

    setDocumentMeta((current) =>
      current.isDirty === isDirty ? current : { ...current, isDirty }
    );
  }, [workspaceState]);

  useEffect(() => {
    persistWorkspaceDocumentMeta(documentMeta, windowStorageScope);
  }, [documentMeta.lastSavedAt, documentMeta.path, windowStorageScope]);

  useEffect(() => {
    persistRecentWorkspaceDocuments(recentWorkspaceDocuments);
  }, [recentWorkspaceDocuments]);

  useEffect(() => {
    persistDocumentAutosaveEnabled(autosaveEnabled);
  }, [autosaveEnabled]);

  useEffect(() => {
    void Promise.resolve(
      invoke("set_current_window_title", {
        title: buildWorkspaceWindowTitle(documentMeta),
      })
    ).catch(() => {
      // Ignore title update failures so document state stays functional.
    });
  }, [documentMeta]);

  useEffect(() => {
    void Promise.resolve(
      invoke("set_current_window_document_state", {
        isDirty: documentMeta.isDirty,
        documentName: documentMeta.name,
      })
    ).catch(() => {
      // Ignore sync failures so editing stays functional.
    });
  }, [documentMeta.isDirty, documentMeta.name]);

  useEffect(() => {
    persistWorkspaceStateSnapshot({
      workspaceState,
      documentMeta,
      windowLabel: windowStorageScope,
    });
  }, [documentMeta, windowStorageScope, workspaceState]);

  const closeDocumentDialog = useCallback(() => {
    setDocumentDialogMode(null);
    setDocumentPathDraft("");
  }, []);

  const claimCurrentWorkspaceDocumentPath = useCallback(async (path: string | null) => {
    return Promise.resolve(
      invoke<WorkspaceDocumentClaimResult>("claim_current_workspace_document", {
        path,
      })
    );
  }, []);

  const openDocumentDialog = useCallback(
    (mode: WorkspaceDocumentDialogMode) => {
      setDocumentDialogMode(mode);
      setDocumentPathDraft(documentMeta.path ?? "");
    },
    [documentMeta.path]
  );

  const confirmReplaceCurrentDocument = useCallback((message: string) => {
    const hasUnsavedChanges =
      serializeWorkspaceStateForDocument(workspaceRef.current) !== documentBaselineRef.current;

    if (!hasUnsavedChanges) {
      return true;
    }

    return window.confirm(message);
  }, []);

  const saveWorkspaceDocumentToPath = useCallback(
    async (path: string, options?: { silent?: boolean }) => {
      const trimmedPath = path.trim();
      if (!trimmedPath || documentSaveInFlightRef.current) {
        return false;
      }

      const previousPath = documentMetaRef.current.path;
      const claimResult = await claimCurrentWorkspaceDocumentPath(trimmedPath);
      if (claimResult.status === "alreadyOpen") {
        if (!options?.silent) {
          showNotice({
            tone: "info",
            message: "Dokumen itu sudah terbuka di jendela lain.",
          });
        }
        return false;
      }

      const savedAt = new Date().toISOString();
      const serializedWorkspace = serializeWorkspaceStateForDocument(workspaceRef.current);
      const document = createWorkspaceDocumentFile(
        JSON.parse(serializedWorkspace) as WorkspaceState,
        savedAt
      );

      documentSaveInFlightRef.current = true;
      setDocumentMeta((current) => ({
        ...current,
        persistenceStatus: "saving",
        errorMessage: null,
      }));

      try {
        const result = await Promise.resolve(
          invoke<WorkspaceDocumentWriteResult>("write_workspace_document", {
            path: trimmedPath,
            document,
          })
        );

        documentBaselineRef.current = serializedWorkspace;
        setDocumentMeta({
          path: result.path,
          name: getWorkspaceDocumentName(result.path),
          isDirty: false,
          lastSavedAt: result.savedAt,
          persistenceStatus: "idle",
          errorMessage: null,
        });
        setRecentWorkspaceDocuments((current) =>
          pushRecentWorkspaceDocument(current, result.path)
        );

        if (!options?.silent) {
          showNotice({
            tone: "success",
            message: "Dokumen berhasil disimpan.",
          });
        }

        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gagal menyimpan dokumen.";

        if (previousPath !== trimmedPath) {
          void claimCurrentWorkspaceDocumentPath(previousPath);
        }

        setDocumentMeta((current) => ({
          ...current,
          persistenceStatus: "error",
          errorMessage: message,
        }));

        if (!options?.silent) {
          showNotice({
            tone: "error",
            message,
          });
        }

        return false;
      } finally {
        documentSaveInFlightRef.current = false;
      }
    },
    [claimCurrentWorkspaceDocumentPath, showNotice]
  );

  const applyWorkspaceDocument = useCallback(
    (path: string, document: WorkspaceDocumentFile) => {
      const normalizedWorkspace = normalizePersistedWorkspaceState(document.workspace);
      const serializedWorkspace = serializeWorkspaceStateForDocument(normalizedWorkspace);
      documentBaselineRef.current = serializedWorkspace;
      setWorkspaceState(normalizedWorkspace);
      setDocumentMeta({
        path,
        name: getWorkspaceDocumentName(path),
        isDirty: false,
        lastSavedAt: document.savedAt,
        persistenceStatus: "idle",
        errorMessage: null,
      });
    },
    [setWorkspaceState]
  );

  const openWorkspaceDocumentFromPath = useCallback(
    async (path: string) => {
      const trimmedPath = path.trim();
      if (!trimmedPath) {
        return false;
      }

      if (!confirmReplaceCurrentDocument("Perubahan belum disimpan. Buka dokumen lain?")) {
        return false;
      }

      const previousPath = documentMetaRef.current.path;
      const claimResult = await claimCurrentWorkspaceDocumentPath(trimmedPath);
      if (claimResult.status === "alreadyOpen") {
        showNotice({
          tone: "info",
          message: "Dokumen itu sudah terbuka di jendela lain.",
        });
        return false;
      }

      try {
        const result = await Promise.resolve(
          invoke<WorkspaceDocumentReadResult>("read_workspace_document", {
            path: trimmedPath,
          })
        );

        applyWorkspaceDocument(result.path, result.document);
        setRecentWorkspaceDocuments((current) =>
          pushRecentWorkspaceDocument(current, result.path)
        );
        showNotice({
          tone: "success",
          message: "Dokumen berhasil dibuka.",
        });
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gagal membuka dokumen.";
        void claimCurrentWorkspaceDocumentPath(previousPath);
        showNotice({
          tone: "error",
          message,
        });
        return false;
      }
    },
    [applyWorkspaceDocument, claimCurrentWorkspaceDocumentPath, confirmReplaceCurrentDocument, showNotice]
  );

  const openWorkspaceDocumentWithPicker = useCallback(async () => {
    try {
      const pickedPath = await pickWorkspaceDocumentPath("open");
      if (!pickedPath) {
        return false;
      }

      return openWorkspaceDocumentFromPath(pickedPath);
    } catch {
      openDocumentDialog("open");
      return false;
    }
  }, [openDocumentDialog, openWorkspaceDocumentFromPath]);

  const createNewWorkspaceDocument = useCallback(() => {
    const hasUnsavedChanges =
      serializeWorkspaceStateForDocument(workspaceRef.current) !== documentBaselineRef.current;

    if (hasUnsavedChanges && !window.confirm("Perubahan belum disimpan. Buat dokumen baru?")) {
      return;
    }

    const nextWorkspace = createDefaultWorkspaceState();
    documentBaselineRef.current = serializeWorkspaceStateForDocument(nextWorkspace);
    setWorkspaceState(nextWorkspace);
    setDocumentMeta(createDefaultWorkspaceDocumentMeta());
    void claimCurrentWorkspaceDocumentPath(null);
    showNotice({
      tone: "info",
      message: "Dokumen baru dibuat.",
    });
  }, [claimCurrentWorkspaceDocumentPath, setWorkspaceState, showNotice]);

  const saveCurrentWorkspaceDocument = useCallback(async () => {
    if (documentMeta.path) {
      return saveWorkspaceDocumentToPath(documentMeta.path);
    }

    try {
      const pickedPath = await pickWorkspaceDocumentPath("save", documentMeta.name);
      if (!pickedPath) {
        return false;
      }

      return saveWorkspaceDocumentToPath(pickedPath);
    } catch {
      openDocumentDialog("saveAs");
    }

    return false;
  }, [documentMeta.name, documentMeta.path, openDocumentDialog, saveWorkspaceDocumentToPath]);

  const saveWorkspaceDocumentAs = useCallback(async () => {
    try {
      const pickedPath = await pickWorkspaceDocumentPath("save", documentMeta.name);
      if (!pickedPath) {
        return false;
      }

      return saveWorkspaceDocumentToPath(pickedPath);
    } catch {
      openDocumentDialog("saveAs");
      return false;
    }
  }, [documentMeta.name, openDocumentDialog, saveWorkspaceDocumentToPath]);

  const createNewWorkspaceWindow = useCallback(async () => {
    const result = await Promise.resolve(
      invoke<WorkspaceDocumentClaimResult>("create_workspace_window", {
        documentPath: null,
      })
    );

    if (result.status === "alreadyOpen") {
      showNotice({
        tone: "info",
        message: "Dokumen itu sudah terbuka di jendela lain.",
      });
    }
  }, [showNotice]);

  const openWorkspaceInNewWindow = useCallback(async () => {
    try {
      const pickedPath = await pickWorkspaceDocumentPath("open");
      if (!pickedPath) {
        return;
      }

      const result = await Promise.resolve(
        invoke<WorkspaceDocumentClaimResult>("create_workspace_window", {
          documentPath: pickedPath,
        })
      );

      if (result.status === "alreadyOpen") {
        showNotice({
          tone: "info",
          message: "Dokumen itu sudah terbuka di jendela lain.",
        });
      } else {
        setRecentWorkspaceDocuments((current) =>
          pushRecentWorkspaceDocument(current, pickedPath)
        );
      }
    } catch {
      showNotice({
        tone: "error",
        message: "Gagal membuka pemilih file untuk jendela baru.",
      });
    }
  }, [showNotice]);

  const submitDocumentDialog = useCallback(async () => {
    if (documentDialogMode === "open") {
      const didOpen = await openWorkspaceDocumentFromPath(documentPathDraft);
      if (didOpen) {
        closeDocumentDialog();
      }
      return;
    }

    if (documentDialogMode === "saveAs") {
      const didSave = await saveWorkspaceDocumentToPath(documentPathDraft);
      if (didSave) {
        closeDocumentDialog();
      }
    }
  }, [
    closeDocumentDialog,
    documentDialogMode,
    documentPathDraft,
    openWorkspaceDocumentFromPath,
    saveWorkspaceDocumentToPath,
  ]);

  useEffect(() => {
    if (
      !isAutosaveActive ||
      !documentMeta.path ||
      !documentMeta.isDirty ||
      documentSaveInFlightRef.current
    ) {
      return;
    }

    const autosavePath = documentMeta.path;

    if (documentAutosaveTimeoutRef.current !== null) {
      window.clearTimeout(documentAutosaveTimeoutRef.current);
    }

    documentAutosaveTimeoutRef.current = window.setTimeout(() => {
      void saveWorkspaceDocumentToPath(autosavePath, { silent: true });
      documentAutosaveTimeoutRef.current = null;
    }, 700);

    return () => {
      if (documentAutosaveTimeoutRef.current !== null) {
        window.clearTimeout(documentAutosaveTimeoutRef.current);
        documentAutosaveTimeoutRef.current = null;
      }
    };
  }, [
    documentMeta.isDirty,
    documentMeta.path,
    isAutosaveActive,
    saveWorkspaceDocumentToPath,
    workspaceState,
  ]);

  useEffect(() => {
    void Promise.resolve(
      invoke<WorkspaceWindowLaunchRequest | null>("take_pending_workspace_window_request")
    )
      .then((request) => {
        if (!request) {
          return;
        }

        if (request.documentPath) {
          void openWorkspaceDocumentFromPath(request.documentPath);
          return;
        }

        if (request.startFresh) {
          const nextWorkspace = createDefaultWorkspaceState();
          documentBaselineRef.current = serializeWorkspaceStateForDocument(nextWorkspace);
          setWorkspaceState(nextWorkspace);
          setDocumentMeta(createDefaultWorkspaceDocumentMeta());
        }
      })
      .catch(() => {
        // Ignore launch request failures for the primary window.
      });
  }, [openWorkspaceDocumentFromPath, setWorkspaceState]);

  useEffect(() => {
    if (!documentMeta.path) {
      return;
    }

    void claimCurrentWorkspaceDocumentPath(documentMeta.path);
  }, [claimCurrentWorkspaceDocumentPath, documentMeta.path]);

  useEffect(() => {
    let isDisposed = false;
    let unlistenWindowCloseRequest: null | (() => void) = null;

    void listen<WindowCloseRequestPayload>("shipflow://window-close-requested", (event) => {
      if (isDisposed) {
        return;
      }

      setPendingWindowCloseRequest({
        documentName: event.payload.documentName,
      });
    }).then((unlisten) => {
      if (isDisposed) {
        void unlisten();
        return;
      }

      unlistenWindowCloseRequest = unlisten;
    });

    return () => {
      isDisposed = true;
      if (unlistenWindowCloseRequest) {
        void unlistenWindowCloseRequest();
      }
    };
  }, []);

  const resolvePendingWindowClose = useCallback(async (action: "cancel" | "discard") => {
    await Promise.resolve(
      invoke("resolve_window_close_request", {
        action,
      })
    );
    setPendingWindowCloseRequest(null);
  }, []);

  const cancelPendingWindowClose = useCallback(() => {
    setIsResolvingWindowClose(true);
    void resolvePendingWindowClose("cancel").finally(() => {
      setIsResolvingWindowClose(false);
    });
  }, [resolvePendingWindowClose]);

  const discardPendingWindowClose = useCallback(() => {
    setIsResolvingWindowClose(true);
    void resolvePendingWindowClose("discard").finally(() => {
      setIsResolvingWindowClose(false);
    });
  }, [resolvePendingWindowClose]);

  const saveAndCloseWindow = useCallback(() => {
    setIsResolvingWindowClose(true);
    void saveCurrentWorkspaceDocument()
      .then((didSave) => {
        if (!didSave) {
          return;
        }

        return resolvePendingWindowClose("discard");
      })
      .finally(() => {
        setIsResolvingWindowClose(false);
      });
  }, [resolvePendingWindowClose, saveCurrentWorkspaceDocument]);

  const toggleAutosave = useCallback(() => {
    if (!canUseAutosave) {
      return;
    }

    setAutosaveEnabled((current) => !current);
  }, [canUseAutosave]);

  return {
    autosaveEnabled,
    canUseAutosave,
    cancelPendingWindowClose,
    closeDocumentDialog,
    createNewWorkspaceDocument,
    createNewWorkspaceWindow,
    discardPendingWindowClose,
    documentDialogMode,
    documentMeta,
    documentPathDraft,
    isAutosaveActive,
    isResolvingWindowClose,
    openWorkspaceDocumentFromPath,
    openWorkspaceDocumentWithPicker,
    openWorkspaceInNewWindow,
    pendingWindowCloseRequest,
    recentDocumentItems,
    saveAndCloseWindow,
    saveCurrentWorkspaceDocument,
    saveWorkspaceDocumentAs,
    setDocumentPathDraft,
    submitDocumentDialog,
    toggleAutosave,
  };
}
