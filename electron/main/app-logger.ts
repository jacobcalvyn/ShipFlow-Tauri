import path from "node:path";
import { appendFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";

export type AppLogLevel = "INFO" | "WARN" | "ERROR";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const TOKEN_PATTERN = /\bsf_[a-zA-Z0-9_-]{16,}\b/g;
const AUTHORIZATION_PATTERN = /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi;

function safeMessage(message: unknown) {
  return String(message)
    .replace(TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(AUTHORIZATION_PATTERN, "$1[REDACTED]")
    .replace(/\r?\n/g, "\\n");
}

export class FileAppLogger {
  readonly filePath: string;
  readonly backupPath: string;
  readonly #maxFileBytes: number;
  #currentBytes = 0;
  #initialized = false;
  #lastError: Error | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.1`;
    this.#maxFileBytes = maxFileBytes;
  }

  info(scope: string, message: unknown) {
    this.write("INFO", scope, message);
  }

  warn(scope: string, message: unknown) {
    this.write("WARN", scope, message);
  }

  error(scope: string, message: unknown) {
    this.write("ERROR", scope, message);
  }

  write(level: AppLogLevel, scope: string, message: unknown) {
    const line = `[${new Date().toISOString()}] [${level}] [${safeMessage(scope)}] ${safeMessage(message)}\n`;
    process.stderr.write(line);
    this.#enqueue(async () => {
      await this.#initialize();
      const lineBytes = Buffer.byteLength(line);
      if (this.#currentBytes > 0 && this.#currentBytes + lineBytes > this.#maxFileBytes) {
        await this.#rotate();
      }
      await appendFile(this.filePath, line, "utf8");
      this.#currentBytes += lineBytes;
      this.#lastError = null;
    });
  }

  async ensureFile() {
    await this.#queue;
    if (this.#lastError) {
      throw this.#lastError;
    }
    await this.#initialize();
    return this.filePath;
  }

  async flush() {
    await this.#queue;
  }

  #enqueue(operation: () => Promise<void>) {
    this.#queue = this.#queue.then(operation, operation).catch((error) => {
      this.#lastError = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(`[ShipFlowLogger] ${String(error)}\n`);
    });
  }

  async #initialize() {
    if (this.#initialized) {
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const metadata = await stat(this.filePath);
      this.#currentBytes = metadata.size;
      if (this.#currentBytes >= this.#maxFileBytes) {
        await this.#rotate();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await writeFile(this.filePath, "", { flag: "a" });
      this.#currentBytes = 0;
    }
    this.#initialized = true;
  }

  async #rotate() {
    await unlink(this.backupPath).catch(() => undefined);
    await rename(this.filePath, this.backupPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await writeFile(this.filePath, "", "utf8");
    this.#currentBytes = 0;
  }
}

let activeLogger: FileAppLogger | null = null;

export function configureAppLogger(filePath: string) {
  activeLogger = new FileAppLogger(filePath);
  return activeLogger;
}

export const appLogger = {
  get filePath() {
    if (!activeLogger) {
      throw new Error("ShipFlow app logger has not been configured.");
    }
    return activeLogger.filePath;
  },
  info(scope: string, message: unknown) {
    activeLogger?.info(scope, message);
  },
  warn(scope: string, message: unknown) {
    activeLogger?.warn(scope, message);
  },
  error(scope: string, message: unknown) {
    activeLogger?.error(scope, message);
  },
  async ensureFile() {
    if (!activeLogger) {
      throw new Error("ShipFlow app logger has not been configured.");
    }
    return activeLogger.ensureFile();
  },
  async flush() {
    await activeLogger?.flush();
  },
};
