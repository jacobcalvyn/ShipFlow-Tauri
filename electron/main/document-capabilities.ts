import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveWorkspaceDocumentPath } from "./documents";

export function canonicalWorkspaceDocumentPath(inputPath: string) {
  const resolved = resolveWorkspaceDocumentPath(inputPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    try {
      return path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

export class DocumentPathCapabilities {
  readonly #authorizedPaths = new Set<string>();

  constructor(initialPaths: string[] = []) {
    for (const inputPath of initialPaths) {
      this.authorize(inputPath);
    }
  }

  authorize(inputPath: string) {
    const normalized = canonicalWorkspaceDocumentPath(inputPath);
    this.#authorizedPaths.add(normalized);
    return normalized;
  }

  has(inputPath: string) {
    return this.#authorizedPaths.has(canonicalWorkspaceDocumentPath(inputPath));
  }

  require(inputPath: string) {
    const normalized = canonicalWorkspaceDocumentPath(inputPath);
    if (!this.#authorizedPaths.has(normalized)) {
      throw new Error(
        "Workspace path is not authorized. Select it with the native file picker first.",
      );
    }
    return normalized;
  }
}
