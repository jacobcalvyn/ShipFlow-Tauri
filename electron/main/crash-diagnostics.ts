import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_CRASH_DIRECTORIES = 32;
const MAX_CRASH_FILES = 256;

type ProcessMetric = {
  memory?: {
    workingSetSize?: number;
  };
  type?: string;
};

export type CrashDumpInventory = {
  crashDumpCount: number;
  latestCrashDumpBytes: number;
  latestCrashDumpName: string;
};

export function summarizeProcessMetrics(metrics: ProcessMetric[]) {
  const processTypeCounts = new Map<string, number>();
  let aggregateWorkingSetKb = 0;
  let gpuWorkingSetKb = 0;
  let rendererWorkingSetKb = 0;

  for (const metric of metrics) {
    const type = metric.type?.trim() || "Unknown";
    const workingSetSize = metric.memory?.workingSetSize ?? 0;
    processTypeCounts.set(type, (processTypeCounts.get(type) ?? 0) + 1);
    aggregateWorkingSetKb += workingSetSize;
    if (type === "GPU") {
      gpuWorkingSetKb += workingSetSize;
    }
    if (type === "Tab") {
      rendererWorkingSetKb += workingSetSize;
    }
  }

  return {
    aggregateWorkingSetKb,
    appProcessCount: metrics.length,
    gpuWorkingSetKb,
    processTypes: [...processTypeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => `${type}:${count}`)
      .join(","),
    rendererWorkingSetKb,
  };
}

export async function inspectCrashDumps(
  crashDumpsPath: string,
): Promise<CrashDumpInventory> {
  const directories = [crashDumpsPath];
  let directoryIndex = 0;
  let crashDumpCount = 0;
  let latestCrashDumpBytes = 0;
  let latestCrashDumpModifiedMs = 0;
  let latestCrashDumpName = "";

  while (
    directoryIndex < directories.length &&
    directoryIndex < MAX_CRASH_DIRECTORIES &&
    crashDumpCount < MAX_CRASH_FILES
  ) {
    const directory = directories[directoryIndex];
    directoryIndex += 1;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (directories.length < MAX_CRASH_DIRECTORIES) {
          directories.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".dmp")) {
        continue;
      }
      crashDumpCount += 1;
      const metadata = await stat(entryPath).catch(() => null);
      if (metadata && metadata.mtimeMs >= latestCrashDumpModifiedMs) {
        latestCrashDumpBytes = metadata.size;
        latestCrashDumpModifiedMs = metadata.mtimeMs;
        latestCrashDumpName = path.relative(crashDumpsPath, entryPath);
      }
      if (crashDumpCount >= MAX_CRASH_FILES) {
        break;
      }
    }
  }

  return {
    crashDumpCount,
    latestCrashDumpBytes,
    latestCrashDumpName,
  };
}
