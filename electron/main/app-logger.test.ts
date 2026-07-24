import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureAppLogger,
  FileAppLogger,
  pipeTextStreamToAppLogger,
} from "./app-logger";

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
    expect(content).toMatch(/\| session=[a-f0-9-]+ sequence=1/);
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

  it("writes structured audit events with stable field ordering and redaction", async () => {
    const logger = await createLogger();

    logger.event("INFO", "Lifecycle", "app_ready", {
      platform: "darwin",
      authToken: "sf_1234567890abcdef1234567890abcdef",
      packaged: true,
    });
    await logger.flush();

    const content = await readFile(logger.filePath, "utf8");
    expect(content).toContain(
      'event=app_ready data={"authToken":"[REDACTED]","packaged":true,"platform":"darwin"}',
    );
    expect(content).not.toContain("sf_1234567890abcdef1234567890abcdef");
  });

  it("keeps child-process output line aligned across arbitrary chunks", async () => {
    const logger = await createLogger();
    const streamLogger = configureAppLogger(logger.filePath);
    const stream = new PassThrough();
    pipeTextStreamToAppLogger(stream, "Service", "WARN");

    stream.write("first");
    stream.write(" line\nsecond");
    stream.end(" line\n");
    await new Promise((resolve) => stream.once("end", resolve));
    await streamLogger.flush();

    const content = await readFile(logger.filePath, "utf8");
    expect(content).toContain("[WARN] [Service] first line");
    expect(content).toContain("[WARN] [Service] second line");
  });

  it("bounds oversized messages before persisting them", async () => {
    const logger = await createLogger();

    logger.warn("Frontend", "x".repeat(64 * 1024));
    await logger.flush();

    const content = await readFile(logger.filePath, "utf8");
    expect(Buffer.byteLength(content)).toBeLessThan(34 * 1024);
    expect(content).toContain("[TRUNCATED]");
  });
});
