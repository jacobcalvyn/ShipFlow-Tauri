import { WorkspaceState } from "./types";

export type WorkspaceDocumentFile = {
  version: 1;
  app: "shipflow-desktop";
  savedAt: string;
  workspace: WorkspaceState;
};

export type WorkspaceDocumentMeta = {
  path: string | null;
  name: string;
  isDirty: boolean;
  lastSavedAt: string | null;
  persistenceStatus: "idle" | "saving" | "error";
  errorMessage: string | null;
};

type PersistedWorkspaceDocumentMeta = {
  path: string | null;
  lastSavedAt: string | null;
};

export function getWorkspaceDocumentName(path: string | null) {
  if (!path) {
    return "Untitled.shipflow";
  }

  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Untitled.shipflow";
}

export function createWorkspaceDocumentFile(
  workspace: WorkspaceState,
  savedAt = new Date().toISOString()
): WorkspaceDocumentFile {
  return {
    version: 1,
    app: "shipflow-desktop",
    savedAt,
    workspace,
  };
}

export function createDefaultWorkspaceDocumentMeta(): WorkspaceDocumentMeta {
  return {
    path: null,
    name: getWorkspaceDocumentName(null),
    isDirty: false,
    lastSavedAt: null,
    persistenceStatus: "idle",
    errorMessage: null,
  };
}

export function createPersistedWorkspaceDocumentMeta(
  meta: WorkspaceDocumentMeta
): PersistedWorkspaceDocumentMeta {
  return {
    path: meta.path,
    lastSavedAt: meta.lastSavedAt,
  };
}

export function normalizePersistedWorkspaceDocumentMeta(
  value: unknown
): WorkspaceDocumentMeta {
  if (!value || typeof value !== "object") {
    return createDefaultWorkspaceDocumentMeta();
  }

  const candidate = value as Partial<PersistedWorkspaceDocumentMeta>;
  const path = typeof candidate.path === "string" && candidate.path.trim() ? candidate.path : null;
  const lastSavedAt =
    typeof candidate.lastSavedAt === "string" && candidate.lastSavedAt.trim()
      ? candidate.lastSavedAt
      : null;

  return {
    path,
    name: getWorkspaceDocumentName(path),
    isDirty: false,
    lastSavedAt,
    persistenceStatus: "idle",
    errorMessage: null,
  };
}
