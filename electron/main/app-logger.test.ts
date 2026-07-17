import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAppLogger } from "./app-logger";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createLogger(maxFileBytes = 5 * 1024 * 1024) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shipflow-logger-"));
  temporaryDirectories.push(directory);
  return new FileAppLogger(path.join(directory, "shipflow-desktop.log"), maxFileBytes);
}

describe("FileAppLogger", () => {
  it("serializes log entries and redacts service credentials", async () => {
    const logger = await createLogger();

    logger.info("Electron", "Application ready.");
    logger.error(
      "Service",
      "Authorization: Bearer sf_1234567890abcdef1234567890abcdef\nrequest failed",
    );
    await logger.flush();

    const content = await readFile(logger.filePath, "utf8");
    expect(content).toContain("[INFO] [Electron] Application ready.");
    expect(content).toContain("Authorization: Bearer [REDACTED]");
    expect(content).toContain("\\nrequest failed");
    expect(content).not.toContain("sf_1234567890abcdef1234567890abcdef");
  });

  it("rotates a bounded log into a single backup file", async () => {
    const logger = await createLogger(140);

    logger.info("Test", "a".repeat(70));
    logger.info("Test", "b".repeat(70));
    await logger.flush();

    const current = await readFile(logger.filePath, "utf8");
    const backup = await readFile(logger.backupPath, "utf8");
    expect(current).toContain("b".repeat(70));
    expect(backup).toContain("a".repeat(70));
  });
});
