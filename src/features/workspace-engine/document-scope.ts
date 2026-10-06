import { getShipFlowBridge } from "../../backend/bridge";
import type {
  ShipFlowBridge,
  ShipFlowWorkspaceMethod,
} from "../../backend/bridge-contract";

export type WorkspaceDocumentScope = {
  bridge: ShipFlowBridge;
  epoch: number;
  generation: Promise<number>;
  available: boolean;
};

let owner: ShipFlowBridge | null = null;
let epoch = 0;
let generation: Promise<number> | null = null;
let displayedGeneration: Promise<number> | null = null;
let replacing = false;
let pendingHandoffs = 0;

const staleDocument = () =>
  new Error("Dokumen berubah. Ulangi perintah pada dokumen aktif.");

function captureScope(forReplacement = false): WorkspaceDocumentScope {
  const bridge = getShipFlowBridge();
  if (owner !== bridge) {
    owner = bridge;
    epoch += 1;
    generation = null;
    displayedGeneration = null;
    replacing = false;
    pendingHandoffs = 0;
  }
  generation ??= bridge.requestWorkspace<{ documentGeneration: number }>(
    "workspace.document_generation", {},
  ).then((result) => {
    if (!Number.isSafeInteger(result.documentGeneration) || result.documentGeneration < 0) {
      throw new Error("Invalid native document generation.");
    }
    return result.documentGeneration;
  });
  displayedGeneration ??= generation;
  return {
    bridge,
    epoch,
    generation: forReplacement ? generation : displayedGeneration,
    available: !replacing && (forReplacement || pendingHandoffs === 0),
  };
}

export function captureWorkspaceDocumentScope(): WorkspaceDocumentScope {
  return captureScope();
}

// Keep ordinary commands blocked until React commits the replacement state,
// including the interval after native restore has already returned.
export function beginWorkspaceDocumentHandoff(): (committed?: boolean) => void {
  const bridge = captureScope().bridge;
  pendingHandoffs += 1;
  epoch += 1;
  let finished = false;
  return (committed = false) => {
    if (!finished && owner === bridge) {
      pendingHandoffs -= 1;
      if (committed && pendingHandoffs === 0 && generation !== null) {
        displayedGeneration = generation;
      }
    }
    finished = true;
  };
}

function isScopeIdentityCurrent(scope: WorkspaceDocumentScope) {
  return scope.available && !replacing && owner === scope.bridge && epoch === scope.epoch;
}

export function isWorkspaceDocumentScopeCurrent(scope: WorkspaceDocumentScope) {
  return pendingHandoffs === 0 && isScopeIdentityCurrent(scope);
}

export function assertWorkspaceDocumentScope(scope: WorkspaceDocumentScope) {
  if (!isWorkspaceDocumentScopeCurrent(scope)) throw staleDocument();
}

export async function requestScopedWorkspace<T>(
  method: ShipFlowWorkspaceMethod,
  params: object,
  onEvent?: (event: unknown) => void,
  scope = captureWorkspaceDocumentScope(),
): Promise<T> {
  assertWorkspaceDocumentScope(scope);
  const documentGeneration = await scope.generation;
  assertWorkspaceDocumentScope(scope);
  const scopedParams = { ...params, documentGeneration };
  const result = onEvent
    ? await scope.bridge.requestWorkspace<T>(method, scopedParams, (event) => {
        if (isWorkspaceDocumentScopeCurrent(scope)) onEvent(event);
      })
    : await scope.bridge.requestWorkspace<T>(method, scopedParams);
  assertWorkspaceDocumentScope(scope);
  return result;
}

export async function replaceScopedWorkspace<T>(command: object): Promise<T> {
  const scope = captureScope(true);
  if (!isScopeIdentityCurrent(scope)) throw staleDocument();
  replacing = true;
  epoch += 1;
  try {
    const documentGeneration = await scope.generation;
    const result = await scope.bridge.requestWorkspace<T & { documentGeneration: number }>(
      "workspace.command", { ...command, documentGeneration },
    );
    if (!Number.isSafeInteger(result.documentGeneration) || result.documentGeneration < 0) {
      throw new Error("Invalid restored document generation.");
    }
    generation = Promise.resolve(result.documentGeneration);
    if (pendingHandoffs === 0) displayedGeneration = generation;
    return result;
  } catch (error) {
    // A failed response may follow a committed restore. Reload native identity
    // for replacement retries, but keep ordinary commands bound to the displayed document.
    generation = null;
    throw error;
  } finally {
    replacing = false;
  }
}
