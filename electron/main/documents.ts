import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDocumentFile } from "../../src/features/workspace/document";
import type {
  WorkspaceCsvExportResult,
  WorkspaceDocumentReadResult,
  WorkspaceDocumentWriteResult,
  WorkspaceRecoverySnapshot,
} from "../../src/backend/commands";

const MAX_RECOVERY_FILES = 8;

export function resolveWorkspaceDocumentPath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Workspace file path is required.");
  }
  const expanded = trimmed.startsWith("~/")
    ? path.join(process.env.HOME ?? "", trimmed.slice(2))
    : trimmed;
  return path.extname(expanded) ? path.resolve(expanded) : path.resolve(`${expanded}.shipflow`);
}

function validateDocument(document: WorkspaceDocumentFile) {
  if (document.version !== 1) {
    throw new Error("Unsupported workspace document version.");
  }
  if (document.app !== "shipflow-desktop") {
    throw new Error("This file is not a ShipFlow workspace document.");
  }
  if (!document.workspace || typeof document.workspace !== "object") {
    throw new Error("Workspace document payload is invalid.");
  }
}

function temporaryPath(targetPath: string, suffix: string) {
  return `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.${suffix}`;
}

async function replaceFileAtomically(targetPath: string, content: string) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = temporaryPath(targetPath, "tmp");
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
    const backupPath = temporaryPath(targetPath, "bak");
    try {
      await rename(targetPath, backupPath);
      await rename(tempPath, targetPath);
      await unlink(backupPath).catch(() => undefined);
    } catch (replacementError) {
      await rename(backupPath, targetPath).catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw replacementError;
    }
  }
}

async function recoveryPaths(targetPath: string) {
  const directory = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".recovery"))
    .sort()
    .map((entry) => path.join(directory, entry));
}

async function createRecoverySnapshot(targetPath: string) {
  try {
    await stat(targetPath);
  } catch {
    return;
  }
  await copyFile(targetPath, `${targetPath}.${Date.now()}.recovery`);
  const snapshots = await recoveryPaths(targetPath);
  for (const stalePath of snapshots.slice(0, Math.max(0, snapshots.length - MAX_RECOVERY_FILES))) {
    await unlink(stalePath).catch(() => undefined);
  }
}

export async function readWorkspaceDocument(
  inputPath: string,
): Promise<WorkspaceDocumentReadResult> {
  const targetPath = resolveWorkspaceDocumentPath(inputPath);
  const document = JSON.parse(await readFile(targetPath, "utf8")) as WorkspaceDocumentFile;
  validateDocument(document);
  return { path: targetPath, document };
}

export async function writeWorkspaceDocument(
  inputPath: string,
  document: WorkspaceDocumentFile,
): Promise<WorkspaceDocumentWriteResult> {
  validateDocument(document);
  const targetPath = resolveWorkspaceDocumentPath(inputPath);
  await createRecoverySnapshot(targetPath);
  await replaceFileAtomically(targetPath, `${JSON.stringify(document, null, 2)}\n`);
  return { path: targetPath, savedAt: document.savedAt };
}

export async function writeCsvExport(
  inputPath: string,
  csvContent: string,
  rowCount: number,
): Promise<WorkspaceCsvExportResult> {
  const targetPath = path.extname(inputPath) ? path.resolve(inputPath) : path.resolve(`${inputPath}.csv`);
  await replaceFileAtomically(targetPath, csvContent);
  return {
    path: targetPath,
    rowCount,
    exportedAt: new Date().toISOString(),
  };
}

export async function listWorkspaceRecovery(
  inputPath: string,
): Promise<WorkspaceRecoverySnapshot[]> {
  const targetPath = resolveWorkspaceDocumentPath(inputPath);
  const snapshots = await recoveryPaths(targetPath);
  const results = await Promise.all(
    snapshots.reverse().map(async (snapshotPath) => ({
      path: snapshotPath,
      createdAt: (await stat(snapshotPath)).mtime.toISOString(),
    })),
  );
  return results;
}
